import type {
  Actor,
  AgentConfig,
  AgentHostContract,
  AgentSettings,
  ConfigureResult,
  SetupEvent,
  SetupStep,
} from "@kelpie/config";
import { DEFAULT_SETTINGS, parseSettings, SETUP_AGENT_ID } from "@kelpie/config";
import type { CompiledContext, ContextStoreContract } from "@kelpie/context-store/contract";
import { Agent } from "agents";
import { and, eq, lte } from "drizzle-orm";
import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { SETUP_PROMPT } from "../setup-agent.ts";
import migrations from "./migrations/migrations.js";
import * as schema from "./schema.ts";
import { composeSystemPrompt, hasVaultContext } from "./system-prompt.ts";

let contextStoreForTesting: ContextStoreContract | undefined;

/** Tests run in the Worker's isolate and swap the Context Store with this. Production never calls it. */
export function replaceContextStoreForTesting(store: ContextStoreContract | undefined): void {
  contextStoreForTesting = store;
}

/** A vault the Context Store can't read in time is replaced by the last one it compiled. */
const COMPILE_TIMEOUT_MS = 3_000;

/**
 * One agent (ADR-0002): its configuration now; its MCP connections, schedules, budget and task
 * board (ADR-0011) as they arrive. It extends the Agents SDK's `Agent` for those. One instance per
 * agent, named by the agent's id.
 */
export class AgentHost extends Agent<Env> implements AgentHostContract {
  readonly #db: DrizzleSqliteDODatabase<typeof schema>;
  /** True when the agent's tables were already there: it ran before this instance. */
  readonly #existed: boolean;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#db = drizzle(ctx.storage, { schema });
    this.#existed =
      ctx.storage.sql
        .exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'state'")
        .toArray().length > 0;
    // If a migration fails the object resets, and the next request retries it.
    void ctx.blockConcurrencyWhile(async () => {
      try {
        await migrate(this.#db, migrations);
        this.#dropUnnamedSettings();
      } catch (error) {
        console.error("AgentHost migration failed", error instanceof Error ? error.name : error);
        throw error;
      }
    });
  }

  /**
   * The agent's settings, defaults filled in, and its prompt version. The setup agent's default
   * prompt is its built-in persona. A deploy that changed the default prompt in effect bumps the
   * prompt version, as a configured prompt change does.
   */
  config(): AgentConfig {
    const defaults = this.#defaults();
    const stored = this.#stored();
    return {
      settings: { ...defaults, ...stored },
      promptVersion: this.#promptVersion(defaults.systemPrompt, stored.systemPrompt === undefined),
    };
  }

  #defaults(): AgentSettings {
    return this.ctx.id.name === SETUP_AGENT_ID
      ? { ...DEFAULT_SETTINGS, systemPrompt: SETUP_PROMPT }
      : DEFAULT_SETTINGS;
  }

  /** Only the settings a change set: the others follow the defaults. */
  #stored(): Partial<AgentSettings> {
    return current(this.#get<StoredSettings>("settings", {}));
  }

  /**
   * Until #212 a change stored the whole settings, so an agent changed before it holds that day's
   * defaults beside its owner's choices, and a later edit to a default never reached it. This keeps
   * only the settings some change named, as the audit log records them; the others follow the
   * defaults again. A system prompt or memory core that changes by it starts a new prompt version.
   */
  #dropUnnamedSettings(): void {
    const raw = this.#get<StoredSettings | null>("settings", null);
    if (raw === null) return;
    const named = new Set(
      this.#db
        .select({ fields: schema.auditLog.fields })
        .from(schema.auditLog)
        .all()
        .flatMap((row) => row.fields),
    );
    const before = current(raw);
    const kept: Partial<AgentSettings> = Object.fromEntries(
      Object.entries(before).filter(([key]) => named.has(key)),
    );
    if (Object.keys(kept).length === Object.keys(raw).length) return;
    const was = { ...this.#defaults(), ...before };
    const now = { ...this.#defaults(), ...kept };
    const version = this.#get("promptVersion", 0);
    const promptVersion =
      now.systemPrompt === was.systemPrompt && now.memoryCore === was.memoryCore
        ? version
        : version + 1;
    this.#db.transaction((tx) => {
      for (const [key, value] of [
        ["settings", kept],
        ["promptVersion", promptVersion],
      ] as const) {
        tx.insert(schema.state)
          .values({ key, value })
          .onConflictDoUpdate({ target: schema.state.key, set: { value } })
          .run();
      }
    });
  }

  /**
   * The prompt version, once the built-in default prompt is checked against the one last seen. A
   * new default bumps it only while no configured prompt replaces it. With none seen yet, an agent
   * this instance created records the default without a bump; one whose tables were already there
   * can't tell whether its default changed since its replies, so it bumps once. The compare, the
   * bump and the write are one synchronous step.
   */
  #promptVersion(builtIn: string, inEffect: boolean): number {
    const version = this.#get("promptVersion", 0);
    const seen = this.#get<string | null>("defaultPrompt", null);
    if (seen === builtIn) return version;
    const promptVersion = (seen !== null || this.#existed) && inEffect ? version + 1 : version;
    this.#db.transaction((tx) => {
      for (const [key, value] of [
        ["defaultPrompt", builtIn],
        ["promptVersion", promptVersion],
      ] as const) {
        tx.insert(schema.state)
          .values({ key, value })
          .onConflictDoUpdate({ target: schema.state.key, set: { value } })
          .run();
      }
    });
    return promptVersion;
  }

  /**
   * What a turn runs with: the settings, with the system prompt composed from the vault's persona,
   * rules and skills (ADR-0016). A change in the vault bumps the prompt version, as a configured
   * prompt change does. When the Context Store can't answer, the last vault it compiled is used.
   */
  async turnConfig(): Promise<AgentConfig> {
    const vault = await this.#vaultContext();
    // Read after the await: another call or a configure may have run meanwhile, and the compare,
    // the bump and the write below are one synchronous step.
    const config = this.config();
    const key = hasVaultContext(vault) ? JSON.stringify(vault) : "";
    let promptVersion = config.promptVersion;
    if (key !== this.#get("vaultContext", "")) {
      promptVersion += 1;
      this.#db.transaction((tx) => {
        for (const [stateKey, value] of [
          ["vaultContext", key],
          ["promptVersion", promptVersion],
        ] as const) {
          tx.insert(schema.state)
            .values({ key: stateKey, value })
            .onConflictDoUpdate({ target: schema.state.key, set: { value } })
            .run();
        }
      });
    }
    return {
      settings: {
        ...config.settings,
        systemPrompt: composeSystemPrompt(config.settings.systemPrompt, vault),
      },
      promptVersion,
    };
  }

  async #vaultContext(): Promise<CompiledContext | null> {
    const agentId = this.ctx.id.name;
    const store =
      contextStoreForTesting ?? (this.env.CONTEXT_STORE as unknown as ContextStoreContract);
    if (!agentId) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        store.compile(agentId),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timed out")), COMPILE_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      console.error("AgentHost: the Context Store failed; using the last vault", errorName(error));
      const last = this.#get("vaultContext", "");
      return last === "" ? null : (JSON.parse(last) as CompiledContext);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Applies changes and audits them. The configuration commands are its only callers and authorize
   * the actor (ADR-0013); this validates the changes again, because it is an RPC boundary. A new
   * system prompt bumps the prompt version, and so does turning the memory core on or off (#112).
   * Setting the current values changes nothing, so it isn't audited.
   */
  configure(changes: Partial<AgentSettings>, actor: Actor): ConfigureResult {
    const parsed = parseSettings(changes);
    if (!parsed) return { ok: false, reason: "invalid_input" };
    const current = this.config();
    const fields = (Object.keys(parsed) as (keyof AgentSettings)[]).filter(
      (key) => JSON.stringify(parsed[key]) !== JSON.stringify(current.settings[key]),
    );
    if (fields.length === 0) return { ok: true, value: current };
    const settings = { ...current.settings, ...parsed };
    const promptVersion =
      settings.systemPrompt === current.settings.systemPrompt &&
      settings.memoryCore === current.settings.memoryCore
        ? current.promptVersion
        : current.promptVersion + 1;
    const stored = {
      ...this.#stored(),
      ...Object.fromEntries(fields.map((key) => [key, parsed[key]])),
    };
    this.#db.transaction((tx) => {
      for (const [key, value] of [
        ["settings", stored],
        ["promptVersion", promptVersion],
      ] as const) {
        tx.insert(schema.state)
          .values({ key, value })
          .onConflictDoUpdate({ target: schema.state.key, set: { value } })
          .run();
      }
      tx.insert(schema.auditLog)
        .values({
          at: Date.now(),
          action: "settings.changed",
          userId: actor.userId,
          via: actor.via,
          fields,
          promptVersion,
        })
        .run();
    });
    return { ok: true, value: { settings, promptVersion } };
  }

  /**
   * Notes that a conversation waits for a step of this agent (#206). Waiting again moves its end.
   * An RPC boundary, so the values are checked; a bad one is ignored.
   */
  awaitSetup(conversation: string, step: SetupStep, until: number): void {
    if (
      typeof conversation !== "string" ||
      conversation === "" ||
      conversation.length > MAX_CONVERSATION_NAME ||
      !isSetupStep(step) ||
      !Number.isFinite(until)
    ) {
      return;
    }
    const now = Date.now();
    this.#pruneWaits(now);
    // No wait outlasts the longest a link does.
    const capped = Math.min(until, now + MAX_SETUP_WAIT_MS);
    this.#db
      .insert(schema.setupWaits)
      .values({ conversation, step, until: capped })
      .onConflictDoUpdate({
        target: [schema.setupWaits.conversation, schema.setupWaits.step],
        set: { until: capped },
      })
      .run();
  }

  /**
   * Tells each conversation still waiting for the event's step that the owner finished it. A wait
   * ends once its conversation took the event; one it couldn't reach stays, for the next report.
   * Expired waits go first.
   */
  async setupDone(event: SetupEvent): Promise<void> {
    const agentId = this.ctx.id.name;
    if (!agentId || !isSetupStep(event?.step)) return;
    this.#pruneWaits(Date.now());
    const waiting = this.#db
      .select({ conversation: schema.setupWaits.conversation })
      .from(schema.setupWaits)
      .where(eq(schema.setupWaits.step, event.step))
      .all();
    for (const { conversation } of waiting) {
      try {
        await this.env.CONVERSATION_AGENT.getByName(conversation).setupDone(agentId, event);
      } catch (error) {
        console.error("AgentHost: a conversation wasn't told a setup step", errorName(error));
        continue;
      }
      this.#db
        .delete(schema.setupWaits)
        .where(
          and(
            eq(schema.setupWaits.conversation, conversation),
            eq(schema.setupWaits.step, event.step),
          ),
        )
        .run();
    }
  }

  /**
   * Drops the waits whose links ran out, a grace past their end: a form submitted in its last
   * seconds is reported a moment after.
   */
  #pruneWaits(now: number): void {
    this.#db
      .delete(schema.setupWaits)
      .where(lte(schema.setupWaits.until, now - SETUP_WAIT_GRACE_MS))
      .run();
  }

  #get<T>(key: string, fallback: T): T {
    const row = this.#db
      .select({ value: schema.state.value })
      .from(schema.state)
      .where(eq(schema.state.key, key))
      .get();
    return row ? (row.value as T) : fallback;
  }
}

/** Every setup step: a new one doesn't compile until it is here. */
const SETUP_STEPS: Record<SetupStep, true> = { telegram_connected: true, telegram_paired: true };
const isSetupStep = (step: unknown): step is SetupStep =>
  typeof step === "string" && Object.hasOwn(SETUP_STEPS, step);
/** The longest a link lasts: a day for the pairing page, whose Telegram code starts later. */
const MAX_SETUP_WAIT_MS = 24 * 60 * 60_000;
/** How long past its end a wait still takes a report. */
const SETUP_WAIT_GRACE_MS = 5 * 60_000;
/** A conversation object's name is an agent id, a channel and a thread id. */
const MAX_CONVERSATION_NAME = 256;

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown error";
}

/** Settings as stored; those saved before ADR-0024 also carry the end-of-turn windows. */
type StoredSettings = Partial<AgentSettings> & { quietWindow?: unknown };

/**
 * A change stored the whole settings until #212, so settings saved before ADR-0024 hold the old
 * windows and the old 10 s cap, which would cut the new fixed wait short: both give way to the
 * defaults.
 */
function current(stored: StoredSettings): Partial<AgentSettings> {
  if (!("quietWindow" in stored)) return stored;
  const { quietWindow: _windows, maxWaitMs: _cap, ...rest } = stored;
  return rest;
}
