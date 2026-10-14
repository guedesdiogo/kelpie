import type { Remote } from "@kelpie/access";
import type {
  Actor,
  AgentConfig,
  AgentHostContract,
  AgentSettings,
  ConfigureResult,
  RegistryContract,
  SetupEvent,
  SetupStep,
} from "@kelpie/config";
import {
  type AgentRole,
  agentModel,
  DEFAULT_SETTINGS,
  parseSettings,
  REGISTRY_NAME,
  SETUP_AGENT_ID,
} from "@kelpie/config";
import type { CompiledContext, ContextStoreContract } from "@kelpie/context-store/contract";
import type { ModelDescription, ModelSettings } from "@kelpie/llm/models";
import { Agent } from "agents";
import { and, eq, lte } from "drizzle-orm";
import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { SETUP_PROMPT } from "../setup-agent.ts";
import { identitySection } from "./identity.ts";
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
 * Where a turn's identity comes from (#283): the agent's name and role in the Registry (#314), and
 * its conversation's trio as llm-gateway resolves it (#286).
 */
export interface IdentitySources {
  /** The agent's name and role, or null while the Registry doesn't list it. */
  agent(id: string): Promise<{ name: string; role: AgentRole } | null>;
  describe(agent: ModelSettings): Promise<ModelDescription>;
}

let identitySourcesForTesting: IdentitySources | undefined;

/** Tests run in the Worker's isolate and swap the identity's sources with this. Production never calls it. */
export function replaceIdentitySourcesForTesting(sources: IdentitySources | undefined): void {
  identitySourcesForTesting = sources;
}

/** A name or trio not read in time is replaced by the last one seen. */
const IDENTITY_TIMEOUT_MS = 1_000;

/**
 * One agent (ADR-0002): its configuration now; its MCP connections, schedules, budget and task
 * board (ADR-0011) as they arrive. It extends the Agents SDK's `Agent` for those. One instance per
 * agent, named by the agent's id.
 */
export class AgentHost extends Agent<Env> implements AgentHostContract {
  readonly #db: DrizzleSqliteDODatabase<typeof schema>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#db = drizzle(ctx.storage, { schema });
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
   * Answers once the migrations ran: the constructor holds every call until then, and a failed
   * migration fails this call. The deploy's probe calls it for every agent the Registry lists
   * (#234).
   */
  ping(): { ok: true } {
    return { ok: true };
  }

  /**
   * The agent's settings, defaults filled in, and its prompt version. The setup agent's default
   * prompt is its built-in persona. A deploy that edits a built-in prompt doesn't bump the version:
   * each turn's prompt key catches a change in the text the model gets (#220).
   */
  config(): AgentConfig {
    return {
      settings: { ...this.#defaults(), ...this.#stored() },
      promptVersion: this.#get("promptVersion", 0),
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
   * The settings that differ from the built-in defaults, the only ones stored: a setting set back to
   * its default follows the default again, later edits included (#218).
   */
  #overrides(settings: Partial<AgentSettings>): Partial<AgentSettings> {
    const defaults = this.#defaults();
    return Object.fromEntries(
      Object.entries(settings).filter(
        ([key, value]) =>
          JSON.stringify(value) !== JSON.stringify(defaults[key as keyof AgentSettings]),
      ),
    );
  }

  /**
   * Until #212 a change stored the whole settings, so an agent changed before it holds that day's
   * defaults beside its owner's choices, and a later edit to a default never reached it. This keeps
   * only the settings some change named, as the audit log records them, and that differ from the
   * defaults; the others follow the defaults again. A system prompt or memory core that changes by
   * it starts a new prompt version. It runs once per agent, so the audit log decides nothing after
   * it.
   */
  #dropUnnamedSettings(): void {
    if (this.#get("settingsOverridesOnly", false)) return;
    const raw = this.#get<StoredSettings>("settings", {});
    const named = new Set(
      this.#db
        .select({ fields: schema.auditLog.fields })
        .from(schema.auditLog)
        .all()
        .flatMap((row) => row.fields),
    );
    const before = current(raw);
    const kept = this.#overrides(
      Object.fromEntries(Object.entries(before).filter(([key]) => named.has(key))),
    );
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
        ["settingsOverridesOnly", true],
      ] as const) {
        tx.insert(schema.state)
          .values({ key, value })
          .onConflictDoUpdate({ target: schema.state.key, set: { value } })
          .run();
      }
    });
  }

  /**
   * What a turn runs with: the settings, with the system prompt composed from the agent's identity
   * (#283), then the vault's persona, rules and skills (ADR-0016). A change in the vault bumps the
   * prompt version, as a configured prompt change does. So does a deploy that flips the built-in
   * memory core while the agent follows it (#224): the core isn't in the prompt key, and only turns
   * use it. The first default a turn sees is recorded without a bump. When the Context Store can't
   * answer, the last vault it compiled is used; when the Registry or llm-gateway can't, the last
   * name and trio seen are. The settings' `model` is the agent's own, a tier set before #286
   * included (`agentModel`). A new name or route needs no bump: each turn's prompt key catches the
   * change in the text, as it does a deploy's (#220).
   */
  async turnConfig(): Promise<AgentConfig> {
    const id = this.ctx.id.name ?? "";
    const sources = this.#identitySources();
    // The stored settings, read before the await: the trio is described for them.
    const model = agentModel(this.#stored());
    const [vault, listed, described] = await Promise.all([
      this.#vaultContext(),
      this.#lookup(
        "identityAgent",
        async () => (await sources.agent(id)) ?? { name: id, role: null },
      ),
      this.#lookup("identityModel", () => sources.describe(model)),
    ]);
    // Read after the await: another call or a configure may have run meanwhile, and the compare,
    // the bump and the write below are one synchronous step.
    const config = this.config();
    const key = hasVaultContext(vault) ? JSON.stringify(vault) : "";
    const vaultChanged = key !== this.#get("vaultContext", "");
    const builtInCore = this.#defaults().memoryCore;
    const seenCore = this.#get<boolean | null>("defaultMemoryCore", null);
    const coreFlipped =
      seenCore !== null && seenCore !== builtInCore && this.#stored().memoryCore === undefined;
    const rows: [string, unknown][] = [];
    if (vaultChanged) rows.push(["vaultContext", key]);
    for (const [stateKey, looked] of [
      ["identityAgent", listed],
      ["identityModel", described],
    ] as const) {
      const changed = JSON.stringify(looked.value) !== JSON.stringify(this.#get(stateKey, null));
      if (looked.fresh && changed) rows.push([stateKey, looked.value]);
    }
    if (seenCore !== builtInCore) rows.push(["defaultMemoryCore", builtInCore]);
    const bump = vaultChanged || coreFlipped;
    const promptVersion = bump ? config.promptVersion + 1 : config.promptVersion;
    if (bump) rows.push(["promptVersion", promptVersion]);
    if (rows.length > 0) {
      this.#db.transaction((tx) => {
        for (const [stateKey, value] of rows) {
          tx.insert(schema.state)
            .values({ key: stateKey, value })
            .onConflictDoUpdate({ target: schema.state.key, set: { value } })
            .run();
        }
      });
    }
    const identity = identitySection({
      id,
      name: listed.value?.name ?? id,
      role: listed.value?.role ?? null,
      model: described.value,
    });
    return {
      settings: {
        ...config.settings,
        model,
        systemPrompt: `${identity}\n\n${composeSystemPrompt(config.settings.systemPrompt, vault)}`,
      },
      promptVersion,
    };
  }

  #identitySources(): IdentitySources {
    if (identitySourcesForTesting) return identitySourcesForTesting;
    const registry = this.env.REGISTRY.getByName(
      REGISTRY_NAME,
    ) as unknown as Remote<RegistryContract>;
    const gateway = this.env.LLM_GATEWAY as unknown as {
      describe(area: "conversation", agent: ModelSettings): Promise<ModelDescription>;
    };
    return {
      agent: async (id) => {
        const entry = await registry.get(id);
        return entry ? { name: entry.name, role: entry.role } : null;
      },
      describe: (agent) => gateway.describe("conversation", agent),
    };
  }

  /**
   * One fact of the identity (#283), and whether it was just read. A source that fails, or takes
   * longer than IDENTITY_TIMEOUT_MS, gives the last value seen, or null if it never answered: a
   * turn neither fails nor waits for it, as when a partial rollback leaves an older llm-gateway.
   */
  async #lookup<T>(
    key: string,
    read: () => Promise<T>,
  ): Promise<{ value: T | null; fresh: boolean }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timed out")), IDENTITY_TIMEOUT_MS);
        }),
      ]);
      return { value, fresh: true };
    } catch (error) {
      console.error(`AgentHost: reading ${key} failed; using the last one`, errorName(error));
      return { value: this.#get<T | null>(key, null), fresh: false };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
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
    const stored = this.#overrides({
      ...this.#stored(),
      ...Object.fromEntries(fields.map((key) => [key, parsed[key]])),
    });
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
