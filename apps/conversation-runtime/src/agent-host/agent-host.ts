import type { Actor, AgentConfig, AgentSettings, ConfigureResult } from "@kelpie/config";
import { DEFAULT_SETTINGS, parseSettings } from "@kelpie/config";
import { Agent } from "agents";
import { eq } from "drizzle-orm";
import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import migrations from "./migrations/migrations.js";
import * as schema from "./schema.ts";

/**
 * One agent (ADR-0002): its configuration now; its MCP connections, schedules, budget and task
 * board (ADR-0011) as they arrive. It extends the Agents SDK's `Agent` for those. One instance per
 * agent, named by the agent's id.
 */
export class AgentHost extends Agent<Env> {
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

  /** The agent's settings, defaults filled in, and its prompt version. */
  config(): AgentConfig {
    return {
      settings: { ...DEFAULT_SETTINGS, ...this.#get<Partial<AgentSettings>>("settings", {}) },
      promptVersion: this.#get("promptVersion", 0),
    };
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
