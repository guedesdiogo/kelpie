import type {
  Actor,
  CommentAuthor,
  CommentSource,
  NewTask,
  RunOutcome,
  TaskAuthor,
  TaskDetail,
  TaskEdit,
  TaskResult,
  TaskStatus,
  TaskSummary,
  TaskView,
} from "@kelpie/config";
import { and, asc, count, desc, eq, inArray, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import * as schema from "./schema.ts";

// One agent's task board (ADR-0011, #54), in its AgentHost's SQLite. The AgentHost is the only
// writer: people's changes come through the admin API's commands, and the agent's through its runs.
// Each step here is synchronous, so a check and its write can't interleave with another call.

/** A claimed task's lease; the run's heartbeat extends it. */
export const LEASE_MS = 15 * 60_000;
/** The longest a run may hold its task: past it, its lease runs out whatever its heartbeat. */
export const MAX_RUN_MS = 2 * 60 * 60_000;
/** After the owner's stop, the run's lease lasts at most this long, whatever its heartbeat. */
export const STOP_GRACE_MS = 2 * 60_000;
/** Failed runs in a row that put a task in Waiting. */
export const MAX_FAILURES = 2;
/** Tasks not yet Done or Cancelled an agent holds; a full board refuses new ones. */
export const MAX_OPEN_TASKS = 500;
/** Of those, the most other agents may have open on it (#335): the rest of the board is the owner's. */
export const MAX_OPEN_AGENT_TASKS = 20;
/** The most times a task goes to Waiting: one more ends it in Cancelled, so no loop runs on. */
export const MAX_WAITS = 5;
export const MAX_COMMENTS = 500;
/** The most a list returns, most recently changed first. */
export const LIST_LIMIT = 200;

/** Where a step comes from: a person, the agent's run, or Kelpie itself, as when a lease ran out. */
type Step = { actor: TaskAuthor | null; via: string };

/**
 * Who writes a task or a comment (#335): a person on the board, or an agent in a chat or a task.
 * `actingUserId` is the person the work is for (ADR-0015).
 */
export interface TaskWriter {
  author: TaskAuthor;
  via: string;
  actingUserId: string;
  source: CommentSource;
}

/** Who writes a comment: a task's writer, or Kelpie itself, as when it tells an outcome (#302). */
export type CommentWriter = Omit<TaskWriter, "author"> & { author: CommentAuthor };

const KELPIE: CommentAuthor = { kind: "kelpie", id: "kelpie" };

/** Kelpie, commenting in its own words through `via`, for the person the task acts for. */
export const kelpieWriter = (via: string, actingUserId: string): CommentWriter => ({
  author: KELPIE,
  via,
  actingUserId,
  source: "kelpie",
});

/** The owner, writing on the board through the admin API. */
export const personWriter = (actor: Actor): TaskWriter => ({
  author: { kind: "user", id: actor.userId },
  via: actor.via,
  actingUserId: actor.userId,
  source: "board",
});

const OPEN: TaskStatus[] = ["backlog", "todo", "in_progress", "waiting"];
const notFound = { ok: false, reason: "unknown_task" } as const;
const notAllowed = { ok: false, reason: "not_allowed" } as const;

export class TaskBoard {
  readonly #db: DrizzleSqliteDODatabase<typeof schema>;
  readonly #agent: Step;
  readonly #kelpie: Step = { actor: null, via: "kelpie" };

  constructor(db: DrizzleSqliteDODatabase<typeof schema>, agentId: string) {
    this.#db = db;
    this.#agent = { actor: { kind: "agent", id: agentId }, via: `agent:${agentId}` };
  }

  create(input: NewTask, writer: TaskWriter, id: string, now: number): TaskResult<TaskView> {
    const open = this.#db
      .select({ n: count() })
      .from(schema.tasks)
      .where(inArray(schema.tasks.status, OPEN))
      .get();
    if ((open?.n ?? 0) >= MAX_OPEN_TASKS) return notAllowed;
    if (writer.author.kind === "agent") {
      const byAgents = this.#db
        .select({ n: count() })
        .from(schema.tasks)
        .where(and(inArray(schema.tasks.status, OPEN), eq(schema.tasks.creatorKind, "agent")))
        .get();
      if ((byAgents?.n ?? 0) >= MAX_OPEN_AGENT_TASKS) return notAllowed;
    }
    const step = stepOf(writer);
    this.#db.transaction((tx) => {
      tx.insert(schema.tasks)
        .values({
          id,
          ...input,
          createdAt: now,
          updatedAt: now,
          creatorKind: writer.author.kind,
          creatorId: writer.author.id,
          actingUserId: writer.actingUserId,
        })
        .run();
      tx.insert(schema.taskEvents)
        .values(event(id, now, step, "created", null, input.status))
        .run();
    });
    return this.#view(id);
  }

  /** People edit a task while it waits in Backlog or To do (ADR-0011). */
  edit(id: string, changes: TaskEdit, actor: Actor, now: number): TaskResult<TaskView> {
    const task = this.#row(id);
    if (!task) return notFound;
    if (task.status !== "backlog" && task.status !== "todo") return notAllowed;
    this.#db.transaction((tx) => {
      tx.update(schema.tasks)
        .set({ ...changes, updatedAt: now })
        .where(eq(schema.tasks.id, id))
        .run();
      tx.insert(schema.taskEvents)
        .values(event(id, now, person(actor), "edited", null, null))
        .run();
    });
    return this.#view(id);
  }

  /** People move a task between Backlog and To do, and nowhere else. */
  move(id: string, to: "backlog" | "todo", actor: Actor, now: number): TaskResult<TaskView> {
    const task = this.#row(id);
    if (!task) return notFound;
    if (task.status !== "backlog" && task.status !== "todo") return notAllowed;
    if (task.status !== to) this.#set(id, { status: to }, now, person(actor), "moved", task.status);
    return this.#view(id);
  }

  /**
   * Adds a comment, at any status. A comment on a task in Waiting is the answer it waited for
   * (#335): the task goes back to To do, its failures forgotten.
   */
  comment(id: string, text: string, writer: CommentWriter, now: number): TaskResult<TaskView> {
    const task = this.#row(id);
    if (!task) return notFound;
    const comments = this.#db
      .select({ n: count() })
      .from(schema.taskComments)
      .where(eq(schema.taskComments.taskId, id))
      .get();
    if ((comments?.n ?? 0) >= MAX_COMMENTS) return notAllowed;
    const step = stepOf(writer);
    // Its answer comes from someone else: the agent's own comment never resumes its task. Kelpie's
    // resumes only a task waiting on other work, as a proposal's outcome (#302): a question or two
    // failures wait for a person.
    const own = writer.author.kind === "agent" && this.#agent.actor?.id === writer.author.id;
    const kelpie = writer.author.kind === "kelpie";
    const resumes =
      task.status === "waiting" && !own && (!kelpie || task.waitingReason === "dependency");
    this.#db.transaction((tx) => {
      tx.insert(schema.taskComments)
        .values({
          taskId: id,
          at: now,
          authorKind: writer.author.kind,
          authorId: writer.author.id,
          source: writer.source,
          text,
        })
        .run();
      tx.update(schema.tasks)
        .set(
          resumes
            ? { status: "todo", waitingReason: null, failures: 0, updatedAt: now }
            : { updatedAt: now },
        )
        .where(eq(schema.tasks.id, id))
        .run();
      tx.insert(schema.taskEvents)
        .values(event(id, now, step, "commented", null, null))
        .run();
      if (resumes) {
        tx.insert(schema.taskEvents)
          .values(event(id, now, step, "resumed", "waiting", "todo"))
          .run();
      }
    });
    return this.#view(id);
  }

  /**
   * The owner asks the agent to stop (ADR-0011). A waiting task has no run, so it ends in
   * Cancelled at once. A running one ends there when its run does, unless the run finishes it
   * first, and at the latest when its lease runs out, STOP_GRACE_MS after the request.
   */
  requestStop(id: string, actor: Actor, now: number): TaskResult<TaskView> {
    const task = this.#row(id);
    if (!task) return notFound;
    if (task.status === "waiting") {
      this.#set(
        id,
        { status: "cancelled", stopRequestedAt: now, waitingReason: null },
        now,
        person(actor),
        "stopped",
        "waiting",
      );
    } else if (task.status === "in_progress") {
      // The run gets STOP_GRACE_MS to end; then its lease runs out and the sweep cancels it.
      if (task.stopRequestedAt === null) {
        const leaseUntil = Math.min(task.leaseUntil ?? now, now + STOP_GRACE_MS);
        this.#set(
          id,
          { stopRequestedAt: now, leaseUntil },
          now,
          person(actor),
          "stop_requested",
          null,
        );
      }
    } else {
      return notAllowed;
    }
    return this.#view(id);
  }

  list(status?: TaskStatus): TaskSummary[] {
    return this.#db
      .select({
        id: schema.tasks.id,
        title: schema.tasks.title,
        status: schema.tasks.status,
        scheduledStartAt: schema.tasks.scheduledStartAt,
        createdAt: schema.tasks.createdAt,
        updatedAt: schema.tasks.updatedAt,
        creatorKind: schema.tasks.creatorKind,
        creatorId: schema.tasks.creatorId,
      })
      .from(schema.tasks)
      .where(status ? eq(schema.tasks.status, status) : undefined)
      .orderBy(desc(schema.tasks.updatedAt), desc(schema.tasks.createdAt))
      .limit(LIST_LIMIT)
      .all()
      .map(summaryOf);
  }

  get(id: string): TaskResult<TaskDetail> {
    const task = this.#row(id);
    if (!task) return notFound;
    const comments = this.#db
      .select()
      .from(schema.taskComments)
      .where(eq(schema.taskComments.taskId, id))
      .orderBy(asc(schema.taskComments.id))
      .all();
    const events = this.#db
      .select()
      .from(schema.taskEvents)
      .where(eq(schema.taskEvents.taskId, id))
      .orderBy(asc(schema.taskEvents.id))
      .all();
    const runs = this.#db
      .select()
      .from(schema.taskRuns)
      .where(eq(schema.taskRuns.taskId, id))
      .orderBy(asc(schema.taskRuns.id))
      .all();
    return {
      ok: true,
      value: {
        ...viewOf(task),
        comments: comments.map((row) => ({
          at: row.at,
          author: row.authorKind === "kelpie" ? KELPIE : { kind: row.authorKind, id: row.authorId },
          source: row.source,
          text: row.text,
        })),
        events: events.map((row) => ({
          at: row.at,
          actor:
            row.actorKind && row.actorId !== null ? { kind: row.actorKind, id: row.actorId } : null,
          via: row.via,
          kind: row.kind,
          from: row.fromStatus,
          to: row.toStatus,
        })),
        runs: runs.map((row) => ({
          attempt: row.attempt,
          startedAt: row.startedAt,
          endedAt: row.endedAt,
          outcome: row.outcome,
        })),
      },
    };
  }

  /**
   * Claims the next eligible task while fewer than `max` run, in order: the earliest scheduled
   * start, or creation, first, leaving out `skip`. A task in Waiting holds no slot (#54). The run's
   * token is random, so only the run that got it can report on the task.
   */
  claimNext(
    max: number,
    now: number,
    skip: ReadonlySet<string> = new Set(),
  ): { task: TaskView; run: string } | null {
    return this.#db.transaction((tx) => {
      const running = tx
        .select({ n: count() })
        .from(schema.tasks)
        .where(eq(schema.tasks.status, "in_progress"))
        .get();
      if ((running?.n ?? 0) >= max) return null;
      const next = tx
        .select()
        .from(schema.tasks)
        .where(
          and(
            eq(schema.tasks.status, "todo"),
            or(isNull(schema.tasks.scheduledStartAt), lte(schema.tasks.scheduledStartAt, now)),
            skip.size > 0 ? notInArray(schema.tasks.id, [...skip]) : undefined,
          ),
        )
        .orderBy(
          asc(sql`coalesce(${schema.tasks.scheduledStartAt}, ${schema.tasks.createdAt})`),
          asc(schema.tasks.createdAt),
        )
        .limit(1)
        .get();
      if (!next) return null;
      const attempt = next.attempt + 1;
      tx.update(schema.tasks)
        .set({ status: "in_progress", attempt, leaseUntil: now + LEASE_MS, updatedAt: now })
        .where(eq(schema.tasks.id, next.id))
        .run();
      const token = crypto.randomUUID();
      tx.insert(schema.taskRuns).values({ taskId: next.id, token, attempt, startedAt: now }).run();
      tx.insert(schema.taskEvents)
        .values(event(next.id, now, this.#agent, "claimed", "todo", "in_progress"))
        .run();
      const task = tx.select().from(schema.tasks).where(eq(schema.tasks.id, next.id)).get();
      if (!task) throw new Error("A claimed task disappeared");
      return { task: viewOf(task), run: token };
    });
  }

  /**
   * The run's heartbeat: extends its lease, up to MAX_RUN_MS from its start and STOP_GRACE_MS from
   * the owner's stop, and says whether to stop. Only the task's current run counts.
   */
  heartbeat(
    id: string,
    run: string,
    now: number,
  ): { ok: true; leaseUntil: number; stop: boolean } | { ok: false; reason: "not_running" } {
    const current = this.#currentRun(id, run);
    if (!current) return { ok: false, reason: "not_running" };
    const { stopRequestedAt } = current.task;
    const leaseUntil = Math.min(
      now + LEASE_MS,
      current.run.startedAt + MAX_RUN_MS,
      stopRequestedAt === null ? Number.POSITIVE_INFINITY : stopRequestedAt + STOP_GRACE_MS,
    );
    if (leaseUntil <= now) return { ok: false, reason: "not_running" };
    this.#db.update(schema.tasks).set({ leaseUntil }).where(eq(schema.tasks.id, id)).run();
    return { ok: true, leaseUntil, stop: stopRequestedAt !== null };
  }

  /**
   * Ends the task's current run as the agent reports it. A stop the owner asked for turns any end
   * but Done into Cancelled. A failure sends the task back to To do, and the second in a row to
   * Waiting.
   */
  finish(
    id: string,
    run: string,
    outcome: RunOutcome,
    now: number,
    kind = "finished",
  ): TaskResult<TaskView> {
    const current = this.#currentRun(id, run);
    if (!current) return notAllowed;
    const step = kind === "finished" ? this.#agent : this.#kelpie;
    this.#end(current.task, current.run.id, outcome.status, outcome, now, step, kind);
    return this.#view(id);
  }

  /**
   * Ends every run whose lease ran out (ADR-0011): each counts as a failed attempt, unless the
   * owner asked it to stop, which ends it in Cancelled. Every wake runs it, not only a lookup.
   */
  sweep(now: number): string[] {
    const expired = this.#db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.status, "in_progress"), lte(schema.tasks.leaseUntil, now)))
      .all();
    for (const task of expired) {
      const run = this.#db
        .select({ id: schema.taskRuns.id })
        .from(schema.taskRuns)
        .where(and(eq(schema.taskRuns.taskId, task.id), isNull(schema.taskRuns.endedAt)))
        .orderBy(desc(schema.taskRuns.id))
        .get();
      this.#end(
        task,
        run?.id ?? null,
        "expired",
        { status: "failed" },
        now,
        this.#kelpie,
        "lease_expired",
      );
    }
    return expired.map((task) => task.id);
  }

  /**
   * Ends a stopped task's run in Cancelled at once (#335), once its conversation stopped the turn.
   */
  endStopped(id: string, now: number): void {
    const task = this.#row(id);
    if (task?.status !== "in_progress" || task.stopRequestedAt === null) return;
    const run = this.#db
      .select({ id: schema.taskRuns.id })
      .from(schema.taskRuns)
      .where(and(eq(schema.taskRuns.taskId, id), isNull(schema.taskRuns.endedAt)))
      .orderBy(desc(schema.taskRuns.id))
      .get();
    this.#end(
      task,
      run?.id ?? null,
      "cancelled",
      { status: "cancelled" },
      now,
      this.#kelpie,
      "stopped",
    );
  }

  /** The person a task acts for (ADR-0015): its run's turns act as them. */
  actingUserOf(id: string): string | null {
    return this.#row(id)?.actingUserId ?? null;
  }

  /**
   * When the board next needs its AgentHost awake: the earliest lease to run out, and, while a
   * runner can take tasks, the next scheduled start. Null when nothing waits on time.
   */
  nextWake(now: number, canRun: boolean): number | null {
    const lease = this.#db
      .select({ at: sql<number | null>`min(${schema.tasks.leaseUntil})` })
      .from(schema.tasks)
      .where(eq(schema.tasks.status, "in_progress"))
      .get();
    const times = [lease?.at ?? null];
    if (canRun) {
      const start = this.#db
        .select({ at: sql<number | null>`min(${schema.tasks.scheduledStartAt})` })
        .from(schema.tasks)
        .where(and(eq(schema.tasks.status, "todo"), sql`${schema.tasks.scheduledStartAt} > ${now}`))
        .get();
      times.push(start?.at ?? null);
    }
    const due = times.filter((at): at is number => at !== null);
    return due.length === 0 ? null : Math.max(Math.min(...due), now);
  }

  #end(
    task: typeof schema.tasks.$inferSelect,
    run: number | null,
    ended: "done" | "waiting" | "cancelled" | "failed" | "expired",
    outcome: RunOutcome,
    now: number,
    step: Step,
    kind: string,
  ): void {
    const failures = outcome.status === "failed" ? task.failures + 1 : 0;
    let changes: Partial<typeof schema.tasks.$inferInsert> = { waitingReason: null };
    if (task.stopRequestedAt !== null && outcome.status !== "done") {
      changes.status = "cancelled";
      changes.result = outcome.status === "cancelled" ? (outcome.result ?? null) : null;
    } else if (outcome.status === "done") {
      changes = { ...changes, status: "done", result: outcome.result };
    } else if (outcome.status === "waiting" && task.waits >= MAX_WAITS) {
      changes = { ...changes, status: "cancelled", result: "It waited too many times." };
    } else if (outcome.status === "waiting") {
      changes = { status: "waiting", waitingReason: outcome.reason, waits: task.waits + 1 };
    } else if (outcome.status === "cancelled") {
      changes = { ...changes, status: "cancelled", result: outcome.result ?? null };
    } else if (failures >= MAX_FAILURES) {
      changes = { status: "waiting", waitingReason: "failed", waits: task.waits + 1 };
    } else {
      changes.status = "todo";
    }
    this.#db.transaction((tx) => {
      tx.update(schema.tasks)
        .set({ ...changes, failures, leaseUntil: null, updatedAt: now })
        .where(eq(schema.tasks.id, task.id))
        .run();
      if (run !== null) {
        tx.update(schema.taskRuns)
          .set({ endedAt: now, outcome: ended })
          .where(eq(schema.taskRuns.id, run))
          .run();
      }
      tx.insert(schema.taskEvents)
        .values(event(task.id, now, step, kind, task.status, changes.status ?? null))
        .run();
    });
  }

  #currentRun(id: string, token: string) {
    const task = this.#row(id);
    if (task?.status !== "in_progress") return null;
    const current = this.#db
      .select()
      .from(schema.taskRuns)
      .where(and(eq(schema.taskRuns.taskId, id), isNull(schema.taskRuns.endedAt)))
      .orderBy(desc(schema.taskRuns.id))
      .get();
    return current && current.token === token ? { task, run: current } : null;
  }

  #set(
    id: string,
    changes: Partial<typeof schema.tasks.$inferInsert>,
    now: number,
    step: Step,
    kind: string,
    from: TaskStatus | null,
  ): void {
    this.#db.transaction((tx) => {
      tx.update(schema.tasks)
        .set({ ...changes, updatedAt: now })
        .where(eq(schema.tasks.id, id))
        .run();
      tx.insert(schema.taskEvents)
        .values(event(id, now, step, kind, from, changes.status ?? null))
        .run();
    });
  }

  #row(id: string) {
    return this.#db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get();
  }

  /** A task as it is now, as the RPC methods answer once pickup ran. */
  view(id: string): TaskResult<TaskView> {
    return this.#view(id);
  }

  #view(id: string): TaskResult<TaskView> {
    const task = this.#row(id);
    return task ? { ok: true, value: viewOf(task) } : notFound;
  }
}

const person = (actor: Actor): Step => stepOf(personWriter(actor));
/** Kelpie's own steps carry no actor, as a lease that ran out doesn't. */
const stepOf = (writer: CommentWriter): Step => ({
  actor: writer.author.kind === "kelpie" ? null : writer.author,
  via: writer.via,
});

function event(
  taskId: string,
  at: number,
  { actor, via }: Step,
  kind: string,
  from: TaskStatus | null,
  to: TaskStatus | null,
) {
  return {
    taskId,
    at,
    actorKind: actor?.kind ?? null,
    actorId: actor?.id ?? null,
    via,
    kind,
    fromStatus: from,
    toStatus: to,
  };
}

function summaryOf(
  row: Pick<
    typeof schema.tasks.$inferSelect,
    | "id"
    | "title"
    | "status"
    | "scheduledStartAt"
    | "createdAt"
    | "updatedAt"
    | "creatorKind"
    | "creatorId"
  >,
): TaskSummary {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    scheduledStartAt: row.scheduledStartAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    creator: { kind: row.creatorKind, id: row.creatorId },
  };
}

function viewOf(row: typeof schema.tasks.$inferSelect): TaskView {
  return {
    ...summaryOf(row),
    body: row.body,
    waitingReason: row.waitingReason,
    attempt: row.attempt,
    stopRequested: row.stopRequestedAt !== null,
    result: row.result,
  };
}
