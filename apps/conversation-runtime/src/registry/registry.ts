import { DurableObject } from "cloudflare:workers";
import {
  type Actor,
  type AddAgentResult,
  type AgentEntry,
  isAgentId,
  isAgentName,
  RETIRED_AGENT_ID,
  type RegistryContract,
  type RenameAgentResult,
  type SetAgentResult,
} from "@kelpie/config";
import { and, asc, count, eq, gt, like, ne } from "drizzle-orm";
import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { subagentPrefix } from "../subagent-limits.ts";
import migrations from "./migrations/migrations.js";
import * as schema from "./schema.ts";

/** The most subagents one creator has live at once (ADR-0036 §5). */
export const MAX_LIVE_SUBAGENTS = 3;
/** The most subagents one creator makes in a day, so creating and deleting can't churn. */
export const MAX_SUBAGENTS_PER_DAY = 10;
const DAY_MS = 24 * 60 * 60_000;

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

  /**
   * Adds an agent. Adding one that exists changes nothing, so a retried create is safe. The retired
   * id stays reserved (ADR-0048).
   */
  add(id: string, name: string, actor: Actor): AddAgentResult {
    if (!isAgentId(id) || id === RETIRED_AGENT_ID || !isAgentName(name)) {
      return { ok: false, reason: "invalid_input" };
    }
    if (this.get(id)) return { ok: true, created: false };
    const now = Date.now();
    // A specialist Master owns, which doesn't chat until the user turns it on (ADR-0036).
    const owner = this.#masterId();
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
    if (owner.role === "subagent" || this.#row(id)) return { ok: false, reason: "not_allowed" };
    const live = this.#db
      .select({ n: count() })
      .from(schema.agents)
      .where(and(eq(schema.agents.ownerId, creator), eq(schema.agents.role, "subagent")))
      .get();
    if ((live?.n ?? 0) >= MAX_LIVE_SUBAGENTS) return { ok: false, reason: "not_allowed" };
    const now = Date.now();
    // Three live, but no churn: deleting one to make another counts against a day's creations.
    // Only its subagents count: Master also creates agents through its tools (ADR-0048).
    const made = this.#db
      .select({ n: count() })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.action, "agent.created"),
          eq(schema.auditLog.via, `agent:${creator}`),
          like(schema.auditLog.agentId, `${subagentPrefix(creator)}%`),
          gt(schema.auditLog.at, now - DAY_MS),
        ),
      )
      .get();
    if ((made?.n ?? 0) >= MAX_SUBAGENTS_PER_DAY) return { ok: false, reason: "not_allowed" };
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

  /** The agent, never the retired id (ADR-0048): nothing reaches it any more. */
  get(id: string): AgentEntry | null {
    if (id === RETIRED_AGENT_ID) return null;
    const row = this.#row(id);
    return row ? entryOf(row) : null;
  }

  /** Any row, the retired id's included. */
  #row(id: string): typeof schema.agents.$inferSelect | undefined {
    return this.#db.select().from(schema.agents).where(eq(schema.agents.id, id)).get();
  }

  /**
   * Makes the agent Master (ADR-0036 §1). The previous one becomes a specialist that keeps
   * chatting, and every specialist is owned by the new one. A subagent can't be it.
   */
  setMaster(id: string, actor: Actor): SetAgentResult {
    if (!isAgentId(id)) return { ok: false, reason: "invalid_input" };
    const agent = this.get(id);
    if (!agent) return { ok: false, reason: "unknown_agent" };
    if (agent.role === "subagent") return { ok: false, reason: "not_allowed" };
    if (agent.role === "master") return { ok: true };
    const now = Date.now();
    this.#db.transaction((tx) => {
      tx.update(schema.agents)
        .set({ role: "specialist", chat: true, updatedAt: now })
        .where(eq(schema.agents.role, schema.STORED_MASTER_ROLE))
        .run();
      tx.update(schema.agents)
        .set({ ownerId: id, updatedAt: now })
        // The retired id's row is stored as a specialist: a rollback finds it as it was.
        .where(
          and(
            eq(schema.agents.role, "specialist"),
            ne(schema.agents.id, id),
            ne(schema.agents.id, RETIRED_AGENT_ID),
          ),
        )
        .run();
      tx.update(schema.agents)
        .set({ role: schema.STORED_MASTER_ROLE, ownerId: null, chat: true, updatedAt: now })
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

  /** Turns a specialist's chat on or off. Master always chats; subagents never do. */
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
   * storage is gone. Master and an agent that still owns another, such as its subagents,
   * aren't removed (ADR-0036 §1).
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
    if (agent.role === "master" || owns) return { ok: false, reason: "not_allowed" };
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

  #masterId(): string | null {
    return (
      this.#db
        .select({ id: schema.agents.id })
        .from(schema.agents)
        .where(eq(schema.agents.role, schema.STORED_MASTER_ROLE))
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

  /** The agents, by id, without the retired id (ADR-0048). */
  list(): AgentEntry[] {
    return this.#db
      .select()
      .from(schema.agents)
      .where(ne(schema.agents.id, RETIRED_AGENT_ID))
      .orderBy(asc(schema.agents.id))
      .all()
      .map(entryOf);
  }
}

/**
 * An agent as callers see it, with Master's stored role read as `master` (ADR-0060). The roles'
 * rules hold whatever the row says: Master chats, a subagent never does.
 */
function entryOf(row: typeof schema.agents.$inferSelect): AgentEntry {
  const role = row.role === schema.STORED_MASTER_ROLE ? "master" : row.role;
  const chat = role === "master" || (role === "specialist" && row.chat);
  return { id: row.id, name: row.name, role, owner: row.ownerId, chat };
}
