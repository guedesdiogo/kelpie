import { DurableObject } from "cloudflare:workers";
import type { Actor, AgentSummary } from "@kelpie/config";
import { asc, eq } from "drizzle-orm";
import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import migrations from "./migrations/migrations.js";
import * as schema from "./schema.ts";

/** Kelpie runs one Registry. */
export const REGISTRY_NAME = "registry";

/**
 * Which agents exist, so commands and the management UI can list them (ADR-0015 left this to
 * Story 3.10). Each agent's configuration lives in its own AgentHost.
 */
export class Registry extends DurableObject<Env> {
  readonly #db: DrizzleSqliteDODatabase<typeof schema>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#db = drizzle(ctx.storage, { schema });
    void ctx.blockConcurrencyWhile(async () => {
      try {
        await migrate(this.#db, migrations);
      } catch (error) {
        console.error("Registry migration failed", error instanceof Error ? error.name : error);
        throw error;
      }
    });
  }

  /** Adds an agent. Adding one that exists changes nothing, so a retried create is safe. */
  add(id: string, name: string, actor: Actor): { created: boolean } {
    if (this.get(id)) return { created: false };
    const now = Date.now();
    this.#db.transaction((tx) => {
      tx.insert(schema.agents).values({ id, name, createdAt: now, updatedAt: now }).run();
      tx.insert(schema.auditLog)
        .values({
          at: now,
          action: "agent.created",
          agentId: id,
          userId: actor.userId,
          via: actor.via,
        })
        .run();
    });
    return { created: true };
  }

  rename(id: string, name: string, actor: Actor): { found: boolean } {
    if (!this.get(id)) return { found: false };
    const now = Date.now();
    this.#db.transaction((tx) => {
      tx.update(schema.agents).set({ name, updatedAt: now }).where(eq(schema.agents.id, id)).run();
      tx.insert(schema.auditLog)
        .values({
          at: now,
          action: "agent.renamed",
          agentId: id,
          userId: actor.userId,
          via: actor.via,
        })
        .run();
    });
    return { found: true };
  }

  get(id: string): AgentSummary | null {
    return (
      this.#db
        .select({ id: schema.agents.id, name: schema.agents.name })
        .from(schema.agents)
        .where(eq(schema.agents.id, id))
        .get() ?? null
    );
  }

  list(): AgentSummary[] {
    return this.#db
      .select({ id: schema.agents.id, name: schema.agents.name })
      .from(schema.agents)
      .orderBy(asc(schema.agents.id))
      .all();
  }
}
