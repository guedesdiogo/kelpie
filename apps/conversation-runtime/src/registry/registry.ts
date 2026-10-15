import { DurableObject } from "cloudflare:workers";
import {
  type Actor,
  type AddAgentResult,
  type AgentEntry,
  isAgentId,
  isAgentName,
  type RegistryContract,
  type RenameAgentResult,
  SETUP_AGENT_ID,
  type SetAgentResult,
} from "@kelpie/config";
import { and, asc, count, eq, ne } from "drizzle-orm";
import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import migrations from "./migrations/migrations.js";
import * as schema from "./schema.ts";

/** The most subagents one creator has live at once (ADR-0036 §5). */
export const MAX_LIVE_SUBAGENTS = 3;

/**
 * Which agents exist, so commands and the management UI can list them (ADR-0015 left this to
 * Story 3.10). Each agent's configuration lives in its own AgentHost.
 *
 * The configuration commands are its only callers and authorize the actor (ADR-0013); this object
 * validates its input, because it is an RPC boundary.
 */
export class Registry extends DurableObject<Env> implements RegistryContract {
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
  add(id: string, name: string, actor: Actor): AddAgentResult {
    if (!isAgentId(id) || !isAgentName(name)) return { ok: false, reason: "invalid_input" };
    if (this.get(id)) return { ok: true, created: false };
    const now = Date.now();
    // A specialist the main agent owns, which doesn't chat until the user turns it on (ADR-0036).
    const owner = this.#mainId();
    this.#db.transaction((tx) => {
      tx.insert(schema.agents)
        .values({ id, name, createdAt: now, updatedAt: now, ownerId: owner, chat: false })
        .run();
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
    return { ok: true, created: true };
  }

  /**
   * Adds a temporary subagent of `creator`'s (ADR-0036 §5, #290): owned by it, with no chat. A
   * subagent creates none, and a creator has at most MAX_LIVE_SUBAGENTS live at once. The creator's
   * `spawn` is checked before this is called.
   */
  addSubagent(id: string, name: string, creator: string, actor: Actor): SetAgentResult {
    if (!isAgentId(id) || !isAgentName(name) || !isAgentId(creator)) {
      return { ok: false, reason: "invalid_input" };
    }
    const owner = this.get(creator);
    if (!owner) return { ok: false, reason: "unknown_agent" };
    if (owner.role === "subagent" || this.get(id)) return { ok: false, reason: "not_allowed" };
    const live = this.#db
      .select({ n: count() })
      .from(schema.agents)
      .where(and(eq(schema.agents.ownerId, creator), eq(schema.agents.role, "subagent")))
      .get();
    if ((live?.n ?? 0) >= MAX_LIVE_SUBAGENTS) return { ok: false, reason: "not_allowed" };
    const now = Date.now();
    this.#db.transaction((tx) => {
      tx.insert(schema.agents)
        .values({
          id,
          name,
          createdAt: now,
          updatedAt: now,
          role: "subagent",
          ownerId: creator,
          chat: false,
        })
        .run();
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
    return { ok: true };
  }

  /** Renaming to the current name changes nothing, so it isn't audited. */
  rename(id: string, name: string, actor: Actor): RenameAgentResult {
    if (!isAgentId(id) || !isAgentName(name)) return { ok: false, reason: "invalid_input" };
    const agent = this.get(id);
    if (!agent) return { ok: false, reason: "unknown_agent" };
    if (agent.name === name) return { ok: true };
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
    return { ok: true };
  }

  get(id: string): AgentEntry | null {
    const row = this.#db.select().from(schema.agents).where(eq(schema.agents.id, id)).get();
    return row ? entryOf(row) : null;
  }

  /**
   * Makes the agent the main agent (ADR-0036 §1). The previous one becomes a specialist that keeps
   * chatting, and every specialist is owned by the new one. Admin and subagents can't be it.
   */
  setMain(id: string, actor: Actor): SetAgentResult {
    if (!isAgentId(id)) return { ok: false, reason: "invalid_input" };
    const agent = this.get(id);
    if (!agent) return { ok: false, reason: "unknown_agent" };
    if (agent.role === "admin" || agent.role === "subagent") {
      return { ok: false, reason: "not_allowed" };
    }
    if (agent.role === "main") return { ok: true };
    const now = Date.now();
    this.#db.transaction((tx) => {
      tx.update(schema.agents)
        .set({ role: "specialist", chat: true, updatedAt: now })
        .where(eq(schema.agents.role, "main"))
        .run();
      tx.update(schema.agents)
        .set({ ownerId: id, updatedAt: now })
        // Admin's row is stored as a specialist; its role is the setup agent's, by its id.
        .where(
          and(
            eq(schema.agents.role, "specialist"),
            ne(schema.agents.id, id),
            ne(schema.agents.id, SETUP_AGENT_ID),
          ),
        )
        .run();
      tx.update(schema.agents)
        .set({ role: "main", ownerId: null, chat: true, updatedAt: now })
        .where(eq(schema.agents.id, id))
        .run();
      tx.insert(schema.auditLog)
        .values({
          at: now,
          action: "agent.main_set",
          agentId: id,
          userId: actor.userId,
          via: actor.via,
        })
        .run();
    });
    return { ok: true };
  }

  /** Turns a specialist's chat on or off. Admin and the main agent always chat; subagents never do. */
  setChat(id: string, chat: boolean, actor: Actor): SetAgentResult {
    if (!isAgentId(id) || typeof chat !== "boolean") return { ok: false, reason: "invalid_input" };
    const agent = this.get(id);
    if (!agent) return { ok: false, reason: "unknown_agent" };
    if (agent.role !== "specialist") return { ok: false, reason: "not_allowed" };
    if (agent.chat === chat) return { ok: true };
    const now = Date.now();
    this.#db.transaction((tx) => {
      tx.update(schema.agents).set({ chat, updatedAt: now }).where(eq(schema.agents.id, id)).run();
      tx.insert(schema.auditLog)
        .values({
          at: now,
          action: "agent.chat_set",
          agentId: id,
          userId: actor.userId,
          via: actor.via,
        })
        .run();
    });
    return { ok: true };
  }

  /**
   * Removes a deleted agent's row and audits it (#303): `deleteAgent` calls it once the agent's
   * storage is gone. Admin, the main agent and an agent that still owns another, such as its
   * subagents, aren't removed (ADR-0036 §1).
   */
  remove(id: string, actor: Actor): SetAgentResult {
    if (!isAgentId(id)) return { ok: false, reason: "invalid_input" };
    const agent = this.get(id);
    if (!agent) return { ok: false, reason: "unknown_agent" };
    const owns = this.#db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(eq(schema.agents.ownerId, id))
      .get();
    if (agent.role === "admin" || agent.role === "main" || owns) {
      return { ok: false, reason: "not_allowed" };
    }
    const now = Date.now();
    this.#db.transaction((tx) => {
      tx.delete(schema.agents).where(eq(schema.agents.id, id)).run();
      tx.insert(schema.auditLog)
        .values({
          at: now,
          action: "agent.deleted",
          agentId: id,
          userId: actor.userId,
          via: actor.via,
        })
        .run();
    });
    return { ok: true };
  }

  #mainId(): string | null {
    return (
      this.#db
        .select({ id: schema.agents.id })
        .from(schema.agents)
        .where(eq(schema.agents.role, "main"))
        .get()?.id ?? null
    );
  }

  /**
   * Answers once the migrations ran: the constructor holds every call until then, and a failed
   * migration fails this call. The deploy's probe calls it (#234).
   */
  ping(): { ok: true } {
    return { ok: true };
  }

  list(): AgentEntry[] {
    return this.#db.select().from(schema.agents).orderBy(asc(schema.agents.id)).all().map(entryOf);
  }
}

/**
 * An agent as callers see it. Admin is the setup agent, by its id, whatever its row holds, and the
 * roles' rules hold whatever the row says: Admin and the main agent chat, a subagent never does.
 */
function entryOf(row: typeof schema.agents.$inferSelect): AgentEntry {
  if (row.id === SETUP_AGENT_ID) {
    return { id: row.id, name: row.name, role: "admin", owner: null, chat: true };
  }
  const chat = row.role === "main" || (row.role === "specialist" && row.chat);
  return { id: row.id, name: row.name, role: row.role, owner: row.ownerId, chat };
}
