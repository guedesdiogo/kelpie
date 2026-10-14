import type {
  Actor,
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
import { and, asc, count, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import * as schema from "./schema.ts";

// One agent's task board (ADR-0011, #54), in its AgentHost's SQLite. The AgentHost is the only
// writer: people's changes come through the admin API's commands, and the agent's through its runs.
// Each step here is synchronous, so a check and its write can't interleave with another call.

/** A claimed task's lease; the run's heartbeat extends it. */
export const LEASE_MS = 15 * 60_000;
/** The longest a run may hold its task: past it, its lease runs out whatever its heartbeat. */
export const MAX_RUN_MS = 2 * 60 * 60_000;
/** Failed runs in a row that put a task in Waiting, and tell its creator. */
export const MAX_FAILURES = 2;
/** Tasks not yet Done or Cancelled an agent holds; a full board refuses new ones. */
export const MAX_OPEN_TASKS = 500;
export const MAX_COMMENTS = 500;
/** The most a list returns, most recently changed first. */
export const LIST_LIMIT = 200;

/** Where a step comes from: a person, the agent's run, or Kelpie itself, as when a lease ran out. */
type Step = { actor: TaskAuthor | null; via: string };

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

  create(input: NewTask, actor: Actor, id: string, now: number): TaskResult<TaskView> {
    const open = this.#db
      .select({ n: count() })
      .from(schema.tasks)
      .where(inArray(schema.tasks.status, OPEN))
      .get();
    if ((open?.n ?? 0) >= MAX_OPEN_TASKS) return notAllowed;
    const step = person(actor);
    this.#db.transaction((tx) => {
      tx.insert(schema.tasks)
        .values({
          id,
          ...input,
          createdAt: now,
          updatedAt: now,
          creatorKind: "user",
          creatorId: actor.userId,
          actingUserId: actor.userId,
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

  comment(id: string, text: string, actor: Actor, now: number): TaskResult<TaskView> {
    if (!this.#row(id)) return notFound;
    const comments = this.#db
      .select({ n: count() })
      .from(schema.taskComments)
      .where(eq(schema.taskComments.taskId, id))
      .get();
    if ((comments?.n ?? 0) >= MAX_COMMENTS) return notAllowed;
    this.#db.transaction((tx) => {
      tx.insert(schema.taskComments)
        .values({
          taskId: id,
          at: now,
          authorKind: "user",
          authorId: actor.userId,
          source: "board",
          text,
        })
        .run();
      tx.update(schema.tasks).set({ updatedAt: now }).where(eq(schema.tasks.id, id)).run();
      tx.insert(schema.taskEvents)
        .values(event(id, now, person(actor), "commented", null, null))
        .run();
    });
    return this.#view(id);
  }

  /**
   * The owner asks the agent to stop (ADR-0011). A waiting task has no run, so it ends in
   * Cancelled at once; a running one ends there when its run does, or when its lease runs out.
   */
  requestStop(id: string, actor: Actor, now: number): TaskResult<TaskView> {
    const task = this.#row(id);
    if (!task) return notFound;
    if (task.status === "waiting") {
      this.#set(
        id,
        { status: "cancelled", stopRequestedAt: now },
        now,
        person(actor),
        "stopped",
        "waiting",
      );
    } else if (task.status === "in_progress") {
      if (task.stopRequestedAt === null) {
        this.#set(id, { stopRequestedAt: now }, now, person(actor), "stop_requested", null);
      }
    } else {
      return notAllowed;
    }
    return this.#view(id);
  }

  list(status?: TaskStatus): TaskSummary[] {
    return this.#db
      .select()
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
          author: { kind: row.authorKind, id: row.authorId },
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
   * start, or creation, first. A task in Waiting holds no slot (#54).
   */
  claimNext(max: number, now: number): { task: TaskView; run: number } | null {
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
      const run = tx
        .insert(schema.taskRuns)
        .values({ taskId: next.id, attempt, startedAt: now })
        .returning({ id: schema.taskRuns.id })
        .get();
      tx.insert(schema.taskEvents)
        .values(event(next.id, now, this.#agent, "claimed", "todo", "in_progress"))
        .run();
      const task = tx.select().from(schema.tasks).where(eq(schema.tasks.id, next.id)).get();
      if (!task) throw new Error("A claimed task disappeared");
      return { task: viewOf(task), run: run.id };
    });
  }

  /**
   * The run's heartbeat: extends its lease, up to MAX_RUN_MS from its start, and says whether the
   * owner asked it to stop. Only the task's current run counts.
   */
  heartbeat(
    id: string,
    run: number,
    now: number,
  ): { ok: true; leaseUntil: number; stop: boolean } | { ok: false; reason: "not_running" } {
    const current = this.#currentRun(id, run);
    if (!current) return { ok: false, reason: "not_running" };
    const leaseUntil = Math.min(now + LEASE_MS, current.run.startedAt + MAX_RUN_MS);
    if (leaseUntil <= now) return { ok: false, reason: "not_running" };
    this.#db.update(schema.tasks).set({ leaseUntil }).where(eq(schema.tasks.id, id)).run();
    return { ok: true, leaseUntil, stop: current.task.stopRequestedAt !== null };
  }

  /**
   * Ends the task's current run as the agent reports it. A stop the owner asked for turns any end
   * but Done into Cancelled. A failure sends the task back to To do, and the second in a row to
   * Waiting.
   */
  finish(
    id: string,
    run: number,
    outcome: RunOutcome,
    now: number,
    kind = "finished",
  ): TaskResult<TaskView> {
    const current = this.#currentRun(id, run);
    if (!current) return notAllowed;
    const step = kind === "finished" ? this.#agent : this.#kelpie;
    this.#end(current.task, run, outcome.status, outcome, now, step, kind);
    return this.#view(id);
  }

  /**
   * Ends every run whose lease ran out (ADR-0011): each counts as a failed attempt, unless the
   * owner asked it to stop, which ends it in Cancelled. Every wake runs it, not only a lookup.
   */
  sweep(now: number): number {
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
    return expired.length;
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
    let changes: Partial<typeof schema.tasks.$inferInsert>;
    if (task.stopRequestedAt !== null && outcome.status !== "done") {
      changes = {
        status: "cancelled",
        result: outcome.status === "cancelled" ? (outcome.result ?? null) : null,
      };
    } else if (outcome.status === "done") {
      changes = { status: "done", result: outcome.result, waitingReason: null };
    } else if (outcome.status === "waiting") {
      changes = { status: "waiting", waitingReason: outcome.reason, waits: task.waits + 1 };
    } else if (outcome.status === "cancelled") {
      changes = { status: "cancelled", result: outcome.result ?? null };
    } else if (failures >= MAX_FAILURES) {
      changes = { status: "waiting", waitingReason: "failed", waits: task.waits + 1 };
    } else {
      changes = { status: "todo" };
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

  #currentRun(id: string, run: number) {
    const task = this.#row(id);
    if (task?.status !== "in_progress") return null;
    const current = this.#db
      .select()
      .from(schema.taskRuns)
      .where(and(eq(schema.taskRuns.taskId, id), isNull(schema.taskRuns.endedAt)))
      .orderBy(desc(schema.taskRuns.id))
      .get();
    return current && current.id === run ? { task, run: current } : null;
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

  #view(id: string): TaskResult<TaskView> {
    const task = this.#row(id);
    return task ? { ok: true, value: viewOf(task) } : notFound;
  }
}

const person = (actor: Actor): Step => ({
  actor: { kind: "user", id: actor.userId },
  via: actor.via,
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

function summaryOf(row: typeof schema.tasks.$inferSelect): TaskSummary {
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
