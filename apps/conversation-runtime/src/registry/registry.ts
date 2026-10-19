import { DurableObject } from "cloudflare:workers";
import {
  type Actor,
  type AddAgentResult,
  type AgentEntry,
  isAgentId,
  isAgentName,
  isProposalId,
  isTaskId,
  type NewProposal,
  PROPOSAL_CAPS,
  PROPOSAL_STATUSES,
  PROPOSAL_TTL_MS,
  type Proposal,
  type ProposalOutcome,
  type ProposalResult,
  type ProposalStatus,
  parseProposalChanges,
  parseProposalReason,
  RETIRED_AGENT_ID,
  type RegistryContract,
  type RenameAgentResult,
  type SetAgentResult,
  sameValue,
} from "@kelpie/config";
import { and, asc, count, desc, eq, gt, inArray, isNotNull, like, lte, ne, or } from "drizzle-orm";
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
 * An approval no finish followed for this long was abandoned, as when a service failed mid-way:
 * the alarm settles it (#302).
 */
const ABANDONED_CLAIM_MS = 5 * 60_000;
/** The most a proposal's change and its snapshot hold together, as JSON. */
const MAX_PROPOSAL_JSON = 200_000;
/** The most tries at telling a proposer an outcome, and the wait before the next (#302). */
const MAX_TELLS = 3;
const TELL_RETRY_MS = 5 * 60_000;
/** The most proposals a list shows, and the most outcomes one alarm tells. */
const MAX_LISTED_PROPOSALS = 100;
const MAX_TELLS_PER_ALARM = 20;
/** One of the database's transactions, for the steps a proposal's audit adds to it. */
type Transaction = Parameters<
  Parameters<DrizzleSqliteDODatabase<typeof schema>["transaction"]>[0]
>[0];
/** A proposal that counts against the caps: waiting for the owner, or being applied. */
const OPEN_PROPOSALS: ProposalStatus[] = ["pending", "applying"];

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
      // An alarm that fired on a release without `alarm()`, as during a rollback, was dropped:
      // the proposals' next expiry or outcome to tell sets it again (#302).
      await this.#wake();
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

  /**
   * Turns a specialist's chat on or off. Master always chats; subagents never do. With
   * `expect`, a proposal's (#302), a chat that is neither the change nor `expect` is a conflict.
   */
  setChat(id: string, chat: boolean, actor: Actor, expect?: boolean): SetAgentResult {
    if (!isAgentId(id) || typeof chat !== "boolean") return { ok: false, reason: "invalid_input" };
    if (expect !== undefined && typeof expect !== "boolean") {
      return { ok: false, reason: "invalid_input" };
    }
    const agent = this.get(id);
    if (!agent) return { ok: false, reason: "unknown_agent" };
    if (agent.role !== "specialist") return { ok: false, reason: "not_allowed" };
    if (agent.chat === chat) return { ok: true };
    if (expect !== undefined && agent.chat !== expect) return { ok: false, reason: "conflict" };
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
  async remove(id: string, actor: Actor): Promise<SetAgentResult> {
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
    // Its open proposals, by it or about it, can never apply now (#302).
    const voided = this.#db
      .select({ id: schema.proposals.id })
      .from(schema.proposals)
      .where(
        and(
          inArray(schema.proposals.status, OPEN_PROPOSALS),
          or(eq(schema.proposals.proposerId, id), eq(schema.proposals.targetId, id)),
        ),
      )
      .all();
    this.#db.transaction((tx) => {
      for (const { id: proposal } of voided) {
        // A proposer that remains hears it, as of any outcome.
        tx.update(schema.proposals)
          .set({ status: "void", decidedAt: now, decidedBy: actor.userId, nextTellAt: now })
          .where(eq(schema.proposals.id, proposal))
          .run();
        tx.insert(schema.proposalEvents)
          .values({
            proposalId: proposal,
            at: now,
            kind: "void",
            userId: actor.userId,
            via: actor.via,
          })
          .run();
      }
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
    if (voided.length > 0) await this.#wake();
    return { ok: true };
  }

  /**
   * Records a proposal (ADR-0061, #302) about an agent its proposer owns, within the caps: one
   * pending per proposer and target, PROPOSAL_CAPS.perProposer pending per proposer,
   * PROPOSAL_CAPS.perDay made a day per proposer, and PROPOSAL_CAPS.pending in all. The checks and
   * the insert are one synchronous step, so two calls can't both pass a cap. It applies nothing.
   */
  async propose(input: NewProposal, actor: Actor): Promise<ProposalResult> {
    const parsed = parseNewProposal(input);
    if (!parsed || !isOwnerActor(actor)) return { ok: false, reason: "invalid_input" };
    const target = this.get(parsed.target);
    if (!target) return { ok: false, reason: "unknown_agent" };
    const proposer = this.get(parsed.proposer);
    if (!proposer || target.owner !== proposer.id) return { ok: false, reason: "not_allowed" };
    // The change as its target's role takes it, and a snapshot of the same fields, to check it by.
    const changes = parseProposalChanges(target.role, parsed.changes);
    const fields = (value: object) => Object.keys(value).sort().join(",");
    if (!changes || fields(changes) !== fields(parsed.before)) {
      return { ok: false, reason: "invalid_input" };
    }
    const now = Date.now();
    const open = and(
      or(eq(schema.proposals.status, "applying"), gt(schema.proposals.expiresAt, now)),
      inArray(schema.proposals.status, OPEN_PROPOSALS),
    );
    const counted = (...where: Parameters<typeof and>) =>
      this.#db
        .select({ n: count() })
        .from(schema.proposals)
        .where(and(...where))
        .get()?.n ?? 0;
    const byProposer = eq(schema.proposals.proposerId, proposer.id);
    if (
      counted(open, byProposer, eq(schema.proposals.targetId, target.id)) >=
        PROPOSAL_CAPS.perTarget ||
      counted(open, byProposer) >= PROPOSAL_CAPS.perProposer ||
      counted(byProposer, gt(schema.proposals.createdAt, now - DAY_MS)) >= PROPOSAL_CAPS.perDay ||
      counted(open) >= PROPOSAL_CAPS.pending
    ) {
      return { ok: false, reason: "too_many" };
    }
    const id = crypto.randomUUID();
    this.#db.transaction((tx) => {
      tx.insert(schema.proposals)
        .values({
          id,
          proposerId: proposer.id,
          targetId: target.id,
          actingUserId: parsed.actingUserId,
          taskId: parsed.taskId,
          changes,
          before: parsed.before,
          reason: parsed.reason,
          status: "pending",
          createdAt: now,
          expiresAt: now + PROPOSAL_TTL_MS,
        })
        .run();
      this.#event(tx, id, now, "proposed", actor);
    });
    await this.#wake();
    return this.#result(id);
  }

  /** A proposal, as it stands: one past its expiry shows as expired before the alarm settles it. */
  proposal(id: string): Proposal | null {
    if (!isProposalId(id)) return null;
    const row = this.#proposalRow(id);
    return row ? proposalOf(row, Date.now()) : null;
  }

  /** The newest proposals first, MAX_LISTED_PROPOSALS at most, or those in one status. */
  proposals(status?: ProposalStatus): Proposal[] {
    if (status !== undefined && !PROPOSAL_STATUSES.includes(status)) return [];
    const now = Date.now();
    // As `proposalOf` shows them: a pending one past its expiry is expired.
    const due = and(eq(schema.proposals.status, "pending"), lte(schema.proposals.expiresAt, now));
    const where =
      status === undefined
        ? undefined
        : status === "pending"
          ? and(eq(schema.proposals.status, "pending"), gt(schema.proposals.expiresAt, now))
          : status === "expired"
            ? or(eq(schema.proposals.status, "expired"), due)
            : eq(schema.proposals.status, status);
    return this.#db
      .select()
      .from(schema.proposals)
      .where(where)
      .orderBy(desc(schema.proposals.createdAt))
      .limit(MAX_LISTED_PROPOSALS)
      .all()
      .map((row) => proposalOf(row, now));
  }

  /** The owner refuses a pending proposal (#302): once, so a repeat answers `not_pending`. */
  async refuseProposal(id: string, actor: Actor): Promise<ProposalResult> {
    const found = this.#open(id, actor);
    if (!found.ok) return found;
    const now = Date.now();
    if (found.row.status !== "pending") return { ok: false, reason: "not_pending" };
    const due = found.row.expiresAt <= now;
    return this.#settled(this.#settle(id, due ? "expired" : "refused", due ? null : actor, now));
  }

  /**
   * The owner approves (#302): a pending proposal becomes `applying`, once. One that is due expires
   * instead, one whose proposer or target went is void, and one whose target its proposer no longer
   * owns is a conflict. An approval that never finishes is the alarm's to settle.
   */
  async claimProposal(id: string, actor: Actor): Promise<ProposalResult> {
    const found = this.#open(id, actor);
    if (!found.ok) return found;
    const { row } = found;
    const now = Date.now();
    if (row.status !== "pending") return { ok: false, reason: "not_pending" };
    if (row.expiresAt <= now) return this.#settled(this.#settle(id, "expired", null, now));
    const target = this.get(row.targetId);
    if (!target || !this.get(row.proposerId)) {
      return this.#settled(this.#settle(id, "void", actor, now));
    }
    if (target.owner !== row.proposerId) {
      return this.#settled(this.#settle(id, "conflict", actor, now));
    }
    this.#db.transaction((tx) => {
      tx.update(schema.proposals)
        .set({ status: "applying", claimedAt: now })
        .where(eq(schema.proposals.id, id))
        .run();
      this.#event(tx, id, now, "claimed", actor);
    });
    // Woken for it, in case this approval never finishes.
    await this.#wake();
    return this.#result(id);
  }

  /** Ends an approval (#302): applied, a conflict, void, or `released` back to pending. */
  async finishProposal(
    id: string,
    outcome: "applied" | "conflict" | "void" | "released",
    actor: Actor,
  ): Promise<ProposalResult> {
    if (!["applied", "conflict", "void", "released"].includes(outcome)) {
      return { ok: false, reason: "invalid_input" };
    }
    const found = this.#open(id, actor);
    if (!found.ok) return found;
    if (found.row.status !== "applying") return { ok: false, reason: "not_pending" };
    const now = Date.now();
    if (outcome !== "released") return this.#settled(this.#settle(id, outcome, actor, now));
    this.#release(id, actor, now);
    // It may have come due while it was being applied.
    return this.#settled(this.#result(id));
  }

  /** An approval that didn't apply goes back to pending. */
  #release(id: string, by: Actor | null, now: number): void {
    this.#db.transaction((tx) => {
      tx.update(schema.proposals)
        .set({ status: "pending", claimedAt: null })
        .where(and(eq(schema.proposals.id, id), eq(schema.proposals.status, "applying")))
        .run();
      this.#event(tx, id, now, "released", by);
    });
  }

  /**
   * The proposals' alarm (#302): settles the approvals that were abandoned, expires the pending
   * proposals that are due, tells each proposer an outcome it hasn't heard, MAX_TELLS tries at
   * most, and wakes again for the next of these.
   */
  override async alarm(): Promise<void> {
    const abandoned = this.#db
      .select()
      .from(schema.proposals)
      .where(
        and(
          eq(schema.proposals.status, "applying"),
          lte(schema.proposals.claimedAt, Date.now() - ABANDONED_CLAIM_MS),
        ),
      )
      .limit(MAX_TELLS_PER_ALARM)
      .all();
    for (const row of abandoned) await this.#settleAbandoned(row);
    const now = Date.now();
    const due = this.#db
      .select({ id: schema.proposals.id })
      .from(schema.proposals)
      .where(and(eq(schema.proposals.status, "pending"), lte(schema.proposals.expiresAt, now)))
      .all();
    for (const { id } of due) this.#settle(id, "expired", null, now);
    const untold = this.#db
      .select()
      .from(schema.proposals)
      .where(and(isNotNull(schema.proposals.nextTellAt), lte(schema.proposals.nextTellAt, now)))
      .limit(MAX_TELLS_PER_ALARM)
      .all();
    for (const row of untold) await this.#tell(row);
    await this.#wake();
  }

  /**
   * An approval no finish followed (#302): applied when the target holds the change, since a
   * change applies in one step, and back to pending otherwise, for the owner to decide again. One
   * whose target can't be read waits for the next alarm.
   */
  async #settleAbandoned(row: typeof schema.proposals.$inferSelect): Promise<void> {
    const now = Date.now();
    const target = this.get(row.targetId);
    if (!target || !this.get(row.proposerId)) {
      this.#settle(row.id, "void", null, now);
      return;
    }
    let holds: boolean;
    if ("chat" in row.changes) {
      holds = target.chat === row.changes.chat;
    } else {
      try {
        const { settings } = await this.env.AGENT_HOST.getByName(row.targetId).config();
        holds = Object.entries(row.changes).every(([field, value]) =>
          sameValue(value, settings[field as keyof typeof settings]),
        );
      } catch (error) {
        console.error("Registry: an abandoned approval's target wasn't read", errorName(error));
        this.#db
          .update(schema.proposals)
          .set({ claimedAt: Date.now() })
          .where(eq(schema.proposals.id, row.id))
          .run();
        return;
      }
    }
    if (!holds) {
      this.#release(row.id, null, Date.now());
      return;
    }
    // The owner who approved it decided it.
    const claimer = this.#db
      .select({ userId: schema.proposalEvents.userId })
      .from(schema.proposalEvents)
      .where(
        and(
          eq(schema.proposalEvents.proposalId, row.id),
          eq(schema.proposalEvents.kind, "claimed"),
        ),
      )
      .orderBy(desc(schema.proposalEvents.id))
      .get()?.userId;
    const by = claimer ? { userId: claimer, role: "owner" as const, via: "kelpie" } : null;
    this.#settle(row.id, "applied", by, Date.now());
  }

  /** Tells the proposer one outcome, through its AgentHost; a try that fails waits for the next. */
  async #tell(row: typeof schema.proposals.$inferSelect): Promise<void> {
    const status = row.status;
    if (
      status !== "applied" &&
      status !== "refused" &&
      status !== "expired" &&
      status !== "conflict" &&
      status !== "void"
    ) {
      return;
    }
    // A proposer deleted since hears nothing, and no object is made for it.
    if (!this.get(row.proposerId)) {
      this.#db.transaction((tx) => {
        tx.update(schema.proposals)
          .set({ nextTellAt: null })
          .where(eq(schema.proposals.id, row.id))
          .run();
        tx.insert(schema.proposalEvents)
          .values({ proposalId: row.id, at: Date.now(), kind: "untold", via: "kelpie" })
          .run();
      });
      return;
    }
    const outcome: ProposalOutcome = {
      id: row.id,
      target: row.targetId,
      taskId: row.taskId,
      actingUserId: row.actingUserId,
      status,
      fields: Object.keys(row.changes),
    };
    let told = false;
    try {
      told = await this.env.AGENT_HOST.getByName(row.proposerId).proposalOutcome(outcome);
    } catch (error) {
      console.error("Registry: a proposal's outcome wasn't told", errorName(error));
    }
    const now = Date.now();
    const attempts = row.tellAttempts + 1;
    const last = !told && attempts >= MAX_TELLS;
    this.#db.transaction((tx) => {
      tx.update(schema.proposals)
        .set(
          told
            ? { toldAt: now, tellAttempts: attempts, nextTellAt: null }
            : {
                tellAttempts: attempts,
                nextTellAt: last ? null : now + TELL_RETRY_MS * 2 ** (attempts - 1),
              },
        )
        .where(eq(schema.proposals.id, row.id))
        .run();
      if (told || last) {
        tx.insert(schema.proposalEvents)
          .values({ proposalId: row.id, at: now, kind: told ? "told" : "untold", via: "kelpie" })
          .run();
      }
    });
  }

  /**
   * Sets the alarm for the next proposal due to expire, or outcome due to be told; none when
   * there is neither.
   */
  async #wake(): Promise<void> {
    const next = (
      column:
        | typeof schema.proposals.expiresAt
        | typeof schema.proposals.nextTellAt
        | typeof schema.proposals.claimedAt,
      where: ReturnType<typeof and>,
    ) =>
      this.#db
        .select({ at: column })
        .from(schema.proposals)
        .where(where)
        .orderBy(asc(column))
        .limit(1)
        .get()?.at ?? null;
    const expiry = next(schema.proposals.expiresAt, eq(schema.proposals.status, "pending"));
    const tell = next(schema.proposals.nextTellAt, isNotNull(schema.proposals.nextTellAt));
    const claimed = next(schema.proposals.claimedAt, eq(schema.proposals.status, "applying"));
    const at = [expiry, tell, claimed === null ? null : claimed + ABANDONED_CLAIM_MS].filter(
      (time): time is number => time !== null,
    );
    if (at.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.max(Math.min(...at), Date.now()));
  }

  /** The proposal to step on, after checking the input, as this RPC boundary must. */
  #open(
    id: string,
    actor: Actor,
  ):
    | { ok: true; row: typeof schema.proposals.$inferSelect }
    | { ok: false; reason: "invalid_input" | "unknown_proposal" } {
    if (!isProposalId(id) || !isOwnerActor(actor)) return { ok: false, reason: "invalid_input" };
    const row = this.#proposalRow(id);
    return row ? { ok: true, row } : { ok: false, reason: "unknown_proposal" };
  }

  /**
   * Settles an open proposal in one conditional step, and audits it. `by` is null for Kelpie's
   * own steps, as an expiry. Every outcome waits for the alarm to tell the proposer.
   */
  #settle(
    id: string,
    status: "applied" | "refused" | "expired" | "conflict" | "void",
    by: Actor | null,
    now: number,
  ): ProposalResult {
    const settled = this.#db.transaction((tx) => {
      const changed = tx
        .update(schema.proposals)
        .set({
          status,
          decidedAt: now,
          decidedBy: by?.userId ?? null,
          nextTellAt: now,
        })
        .where(and(eq(schema.proposals.id, id), inArray(schema.proposals.status, OPEN_PROPOSALS)))
        .returning({ id: schema.proposals.id })
        .all();
      if (changed.length === 0) return false;
      this.#event(tx, id, now, status, by);
      return true;
    });
    return settled ? this.#result(id) : { ok: false, reason: "not_pending" };
  }

  /** A settled outcome, once the alarm is set to tell its proposer. */
  async #settled(result: ProposalResult): Promise<ProposalResult> {
    await this.#wake();
    return result;
  }

  #event(
    tx: Transaction,
    proposalId: string,
    at: number,
    kind: typeof schema.proposalEvents.$inferInsert.kind,
    by: Actor | null,
  ): void {
    tx.insert(schema.proposalEvents)
      .values({ proposalId, at, kind, userId: by?.userId ?? null, via: by?.via ?? "kelpie" })
      .run();
  }

  #proposalRow(id: string): typeof schema.proposals.$inferSelect | undefined {
    return this.#db.select().from(schema.proposals).where(eq(schema.proposals.id, id)).get();
  }

  #result(id: string): ProposalResult {
    const proposal = this.proposal(id);
    return proposal ? { ok: true, value: proposal } : { ok: false, reason: "unknown_proposal" };
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
  const role = schema.readRole(row.role) ?? "specialist";
  const chat = role === "master" || (role === "specialist" && row.chat);
  return { id: row.id, name: row.name, role, owner: row.ownerId, chat };
}

/** A proposal as callers see it: a pending one past its expiry shows as expired. */
function proposalOf(row: typeof schema.proposals.$inferSelect, now: number): Proposal {
  const due = row.status === "pending" && row.expiresAt <= now;
  return {
    id: row.id,
    proposer: row.proposerId,
    target: row.targetId,
    actingUserId: row.actingUserId,
    taskId: row.taskId,
    changes: row.changes,
    before: row.before,
    reason: row.reason,
    status: due ? "expired" : row.status,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    decidedAt: row.decidedAt,
    decidedBy: row.decidedBy,
  };
}

/** A new proposal's fields, checked as an RPC boundary must; its changes by the target's role later. */
function parseNewProposal(input: unknown): NewProposal | null {
  if (typeof input !== "object" || input === null) return null;
  const { proposer, target, actingUserId, taskId, changes, before, reason } =
    input as Partial<NewProposal>;
  const why = parseProposalReason(reason);
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (
    !isAgentId(proposer) ||
    !isAgentId(target) ||
    typeof actingUserId !== "string" ||
    actingUserId === "" ||
    actingUserId.length > 128 ||
    !(taskId === null || isTaskId(taskId)) ||
    !isRecord(changes) ||
    !isRecord(before) ||
    why === null ||
    JSON.stringify([changes, before]).length > MAX_PROPOSAL_JSON
  ) {
    return null;
  }
  return { proposer, target, actingUserId, taskId, changes, before, reason: why };
}

/** The owner, as the commands build the actor (ADR-0015). */
function isOwnerActor(actor: unknown): actor is Actor {
  const { userId, role, via } = (actor ?? {}) as Partial<Actor>;
  return (
    typeof userId === "string" &&
    userId !== "" &&
    userId.length <= 128 &&
    role === "owner" &&
    typeof via === "string" &&
    via !== "" &&
    via.length <= 128
  );
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown error";
}
