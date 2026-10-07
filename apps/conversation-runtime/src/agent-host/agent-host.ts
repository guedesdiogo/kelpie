import type {
  Actor,
  AgentConfig,
  AgentHostContract,
  AgentSettings,
  ConfigureResult,
} from "@kelpie/config";
import { DEFAULT_SETTINGS, parseSettings, SETUP_AGENT_ID } from "@kelpie/config";
import type { CompiledContext, ContextStoreContract } from "@kelpie/context-store/contract";
import { Agent } from "agents";
import { eq } from "drizzle-orm";
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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#db = drizzle(ctx.storage, { schema });
    // If a migration fails the object resets, and the next request retries it.
    void ctx.blockConcurrencyWhile(async () => {
      try {
        await migrate(this.#db, migrations);
      } catch (error) {
        console.error("AgentHost migration failed", error instanceof Error ? error.name : error);
        throw error;
      }
    });
  }

  /**
   * The agent's settings, defaults filled in, and its prompt version. The setup agent's default
   * prompt is its built-in persona.
   */
  config(): AgentConfig {
    const defaults =
      this.ctx.id.name === SETUP_AGENT_ID
        ? { ...DEFAULT_SETTINGS, systemPrompt: SETUP_PROMPT }
        : DEFAULT_SETTINGS;
    return {
      settings: { ...defaults, ...current(this.#get<StoredSettings>("settings", {})) },
      promptVersion: this.#get("promptVersion", 0),
    };
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
   * system prompt bumps the prompt version. Setting the current values changes nothing, so it
   * isn't audited.
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
      settings.systemPrompt === current.settings.systemPrompt
        ? current.promptVersion
        : current.promptVersion + 1;
    this.#db.transaction((tx) => {
      for (const [key, value] of [
        ["settings", settings],
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

  #get<T>(key: string, fallback: T): T {
    const row = this.#db
      .select({ value: schema.state.value })
      .from(schema.state)
      .where(eq(schema.state.key, key))
      .get();
    return row ? (row.value as T) : fallback;
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown error";
}

/** Settings as stored; those saved before ADR-0024 also carry the end-of-turn windows. */
type StoredSettings = Partial<AgentSettings> & { quietWindow?: unknown };

/**
 * A change stores the whole settings, so settings saved before ADR-0024 hold the old windows and
 * the old 10 s cap, which would cut the new fixed wait short: both give way to the defaults.
 */
function current(stored: StoredSettings): Partial<AgentSettings> {
  if (!("quietWindow" in stored)) return stored;
  const { quietWindow: _windows, maxWaitMs: _cap, ...rest } = stored;
  return rest;
}
