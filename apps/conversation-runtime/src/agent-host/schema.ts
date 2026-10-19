import { TASK_STATUSES } from "@kelpie/config";
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

// One agent's configuration, in its AgentHost's SQLite (ADR-0002, ADR-0012).

/** Small values: the settings and the prompt version. */
export const state = sqliteTable("state", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }),
});

/**
 * Every configuration change: who asked, through what, which settings changed and the prompt
 * version after it (ADR-0013). Values aren't copied here; the system prompt can be long.
 */
export const auditLog = sqliteTable("audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: integer("at").notNull(),
  action: text("action", { enum: ["settings.changed"] }).notNull(),
  userId: text("user_id").notNull(),
  via: text("via").notNull(),
  fields: text("fields", { mode: "json" }).$type<string[]>().notNull(),
  promptVersion: integer("prompt_version").notNull(),
});

/**
 * The conversations waiting for a setup step of this agent (#206): each sent the owner the link to
 * it, and is told when the owner finishes it, once, until its wait runs out.
 */
export const setupWaits = sqliteTable(
  "setup_waits",
  {
    /** The conversation object's name. */
    conversation: text("conversation").notNull(),
    step: text("step", {
      enum: ["telegram_connected", "telegram_paired", "runner_connected"],
    }).notNull(),
    until: integer("until").notNull(),
  },
  (table) => [primaryKey({ columns: [table.conversation, table.step] })],
);

/**
 * This agent's conversations, by their object's name (#303): each records itself when it starts a
 * turn, so deleting the agent erases them. Nothing else lists them.
 */
export const conversations = sqliteTable("conversations", {
  name: text("name").primaryKey(),
  /**
   * When it last started a turn (#335): the owner's latest conversation with the agent is where
   * Kelpie tells the agent a task's news. Null for one not seen since that release.
   */
  lastTurnAt: integer("last_turn_at"),
});

/**
 * The agent's tasks (ADR-0011, #54). This object is their only writer. Their assignee is this
 * agent; `creator` is who made the task, and `actingUserId` the person it acts for (ADR-0015).
 */
export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    status: text("status", { enum: TASK_STATUSES }).notNull(),
    scheduledStartAt: integer("scheduled_start_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    creatorKind: text("creator_kind", { enum: ["user", "agent"] }).notNull(),
    creatorId: text("creator_id").notNull(),
    actingUserId: text("acting_user_id").notNull(),
    waitingReason: text("waiting_reason", { enum: ["needs_input", "dependency", "failed"] }),
    /** How many times it went to Waiting, for #335's loop guard. */
    waits: integer("waits").notNull().default(0),
    /** Its runs so far. */
    attempt: integer("attempt").notNull().default(0),
    /** Failed runs in a row: two put it in Waiting. */
    failures: integer("failures").notNull().default(0),
    /** While In progress, when the run's lease runs out. */
    leaseUntil: integer("lease_until"),
    stopRequestedAt: integer("stop_requested_at"),
    result: text("result"),
  },
  (table) => [index("tasks_status").on(table.status)],
);

/** A task's comments: its history, with each author, time and source (ADR-0011). */
export const taskComments = sqliteTable(
  "task_comments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: text("task_id").notNull(),
    at: integer("at").notNull(),
    // Kelpie writes too, as when it tells a proposal's outcome (#302).
    authorKind: text("author_kind", { enum: ["user", "agent", "kelpie"] }).notNull(),
    authorId: text("author_id").notNull(),
    source: text("source", { enum: ["board", "chat", "agent", "kelpie"] }).notNull(),
    text: text("text").notNull(),
  },
  (table) => [index("task_comments_task").on(table.taskId)],
);

/** Every change to a task, append-only: who, through what, and the move. */
export const taskEvents = sqliteTable(
  "task_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: text("task_id").notNull(),
    at: integer("at").notNull(),
    /** Null for Kelpie's own steps, such as a lease that ran out. */
    actorKind: text("actor_kind", { enum: ["user", "agent"] }),
    actorId: text("actor_id"),
    via: text("via").notNull(),
    kind: text("kind").notNull(),
    fromStatus: text("from_status", { enum: TASK_STATUSES }),
    toStatus: text("to_status", { enum: TASK_STATUSES }),
  },
  (table) => [index("task_events_task").on(table.taskId)],
);

/** One row per attempt at a task: its lease's start and how it ended. */
export const taskRuns = sqliteTable(
  "task_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: text("task_id").notNull(),
    /** Random: only the run that got it can report on the task (#54). */
    token: text("token").notNull(),
    attempt: integer("attempt").notNull(),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at"),
    outcome: text("outcome", { enum: ["done", "waiting", "cancelled", "failed", "expired"] }),
  },
  (table) => [index("task_runs_task").on(table.taskId)],
);
