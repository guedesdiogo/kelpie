// An agent's task board (ADR-0011, #54): what its `AgentHost` holds, and the inputs people and the
// agent give it. The commands parse them, and the `AgentHost` parses them again: an RPC boundary.

/** A task's status (ADR-0011). From In progress on, only the agent moves it. */
export const TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "waiting",
  "done",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * Why a task waits: input from a person, another task, or two failed attempts in a row, which
 * Kelpie decides, never a run.
 */
export type WaitingReason = "needs_input" | "dependency" | "failed";

/**
 * Where a comment was written: on the board, in a chat, by an agent, or by Kelpie itself, as when
 * it tells a proposal's outcome (#302).
 */
export type CommentSource = "board" | "chat" | "agent" | "kelpie";

/** Who wrote something: a person, by their user id, or an agent, by its id. */
export interface TaskAuthor {
  kind: "user" | "agent";
  id: string;
}

/** Who wrote a comment: a person, an agent, or Kelpie itself (ADR-0061, #302). */
export type CommentAuthor = TaskAuthor | { kind: "kelpie"; id: "kelpie" };

/** A task as a list shows it. */
export interface TaskSummary {
  id: string;
  title: string;
  status: TaskStatus;
  scheduledStartAt: number | null;
  createdAt: number;
  updatedAt: number;
  creator: TaskAuthor;
}

export interface TaskView extends TaskSummary {
  body: string;
  waitingReason: WaitingReason | null;
  /** How many runs it had. */
  attempt: number;
  stopRequested: boolean;
  /** What its last run ended with; Done always has one. */
  result: string | null;
}

export interface TaskComment {
  at: number;
  author: CommentAuthor;
  source: CommentSource;
  text: string;
}

/** One line of a task's history: who did what, and the move it made, if any. */
export interface TaskEvent {
  at: number;
  /** Null for Kelpie's own steps, such as a lease that ran out. */
  actor: TaskAuthor | null;
  via: string;
  kind: string;
  from: TaskStatus | null;
  to: TaskStatus | null;
}

/** How a run ended: as the agent reported it, or as Kelpie saw it, its lease run out. */
export type RunEnd = "done" | "waiting" | "cancelled" | "failed" | "expired";

export interface TaskRun {
  attempt: number;
  startedAt: number;
  endedAt: number | null;
  outcome: RunEnd | null;
}

export interface TaskDetail extends TaskView {
  comments: TaskComment[];
  events: TaskEvent[];
  runs: TaskRun[];
}

/** Why a task change was refused: a move the rules don't allow, or a full board, is `not_allowed`. */
export type TaskFailure = "invalid_input" | "unknown_task" | "not_allowed";
export type TaskResult<T> = { ok: true; value: T } | { ok: false; reason: TaskFailure };

/** A task people create: in Backlog or To do (ADR-0011). */
export interface NewTask {
  title: string;
  body: string;
  status: "backlog" | "todo";
  scheduledStartAt: number | null;
}

/** What people may edit while a task is in Backlog or To do. */
export interface TaskEdit {
  title?: string;
  body?: string;
  scheduledStartAt?: number | null;
}

/** A run's end, as the agent reports it. Done needs a result. */
export type RunOutcome =
  | { status: "done"; result: string }
  | { status: "waiting"; reason: "needs_input" | "dependency" }
  | { status: "cancelled"; result?: string }
  | { status: "failed" };

export const MAX_TASK_TITLE = 200;
export const MAX_TASK_BODY = 20_000;
export const MAX_TASK_COMMENT = 8_000;
export const MAX_TASK_RESULT = 20_000;
/** A scheduled start is at most a year and a day ahead. */
export const MAX_SCHEDULE_AHEAD_MS = 366 * 24 * 60 * 60_000;

/** Task ids are the random UUIDs the `AgentHost` gives them. */
export function isTaskId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  );
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}

/** One line of printable text: a title shows in lists and in a model's context. */
const parseTitle = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const title = value.trim();
  return title !== "" && title.length <= MAX_TASK_TITLE && !/\p{C}/u.test(title) ? title : null;
};
const isBody = (value: unknown): value is string =>
  typeof value === "string" && value.length <= MAX_TASK_BODY;
/** A start: a whole number of milliseconds, past or within a year and a day; null for none. */
const parseStart = (value: unknown, now: number): number | null | undefined =>
  value === null
    ? null
    : typeof value === "number" &&
        Number.isInteger(value) &&
        value > 0 &&
        value <= now + MAX_SCHEDULE_AHEAD_MS
      ? value
      : undefined;
const fieldsOf = (input: unknown): Record<string, unknown> | null =>
  typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;

export function parseNewTask(input: unknown, now: number): NewTask | null {
  const fields = fieldsOf(input);
  if (!fields) return null;
  const { title, body = "", status = "backlog", scheduledStartAt = null, ...rest } = fields;
  const parsedTitle = parseTitle(title);
  const start = parseStart(scheduledStartAt, now);
  if (
    Object.keys(rest).length > 0 ||
    parsedTitle === null ||
    !isBody(body) ||
    (status !== "backlog" && status !== "todo") ||
    start === undefined
  ) {
    return null;
  }
  return { title: parsedTitle, body, status, scheduledStartAt: start };
}

/** An edit names at least one field, and only fields people may edit. */
export function parseTaskEdit(input: unknown, now: number): TaskEdit | null {
  const fields = fieldsOf(input);
  if (!fields || Object.keys(fields).length === 0) return null;
  const edit: TaskEdit = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key === "title") {
      const title = parseTitle(value);
      if (title === null) return null;
      edit.title = title;
    } else if (key === "body") {
      if (!isBody(value)) return null;
      edit.body = value;
    } else if (key === "scheduledStartAt") {
      const start = parseStart(value, now);
      if (start === undefined) return null;
      edit.scheduledStartAt = start;
    } else {
      return null;
    }
  }
  return edit;
}

export function parseCommentText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text !== "" && text.length <= MAX_TASK_COMMENT ? text : null;
}

export function parseRunOutcome(input: unknown): RunOutcome | null {
  const fields = fieldsOf(input);
  if (!fields) return null;
  const result =
    typeof fields.result === "string" && fields.result.length <= MAX_TASK_RESULT
      ? fields.result.trim()
      : undefined;
  switch (fields.status) {
    case "done":
      return result ? { status: "done", result } : null;
    case "waiting":
      return fields.reason === "needs_input" || fields.reason === "dependency"
        ? { status: "waiting", reason: fields.reason }
        : null;
    case "cancelled":
      if (fields.result !== undefined && result === undefined) return null;
      return result ? { status: "cancelled", result } : { status: "cancelled" };
    case "failed":
      return { status: "failed" };
    default:
      return null;
  }
}
