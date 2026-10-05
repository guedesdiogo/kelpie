import type { AgentSettings } from "@kelpie/config";
import type { AssistantMessage, ChatMessage, Usage } from "@kelpie/llm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// One conversation's state, in its ConversationAgent's SQLite (ADR-0002, ADR-0012). The Agents SDK
// keeps its own tables (schedules, fibers) alongside these.

/**
 * Every message received, deduplicated by the provider's id, in arrival order (`id`). Once a turn
 * claims a message its text lives in history, so the row keeps only what dedupe needs.
 */
export const inbound = sqliteTable(
  "inbound",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    providerMessageId: text("provider_message_id").notNull(),
    userId: text("user_id").notNull(),
    text: text("text").notNull(),
    receivedAt: integer("received_at").notNull(),
    /** When the provider says the message was sent. */
    sentAt: integer("sent_at"),
    /**
     * That time in the author's zone, rendered when the message arrived and never again, so a later
     * zone change doesn't rewrite it (Story 3.12). History gets it in front of the text.
     */
    stamp: text("stamp"),
    turnId: integer("turn_id"),
  },
  (table) => [uniqueIndex("inbound_provider_message").on(table.providerMessageId)],
);

export const turns = sqliteTable("turns", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** The conversation's generation when the turn started; a newer one means it was interrupted. */
  generation: integer("generation").notNull(),
  status: text("status", {
    enum: ["running", "delivered", "interrupted", "refused", "failed"],
  }).notNull(),
  attempts: integer("attempts").notNull(),
  /** The agent's prompt version when the turn started. */
  systemVersion: integer("system_version").notNull(),
  /** The conversation's latest checkpoint when the turn started (ADR-0017), or null for none. */
  checkpointId: integer("checkpoint_id"),
  /**
   * The agent's settings when the turn started, system prompt included, so a retry or a recovery
   * runs with the same ones. Cleared when the turn settles.
   */
  settings: text("settings", { mode: "json" }).$type<AgentSettings>(),
  /** The model's reply, kept only until delivery settles what history records. */
  reply: text("reply", { mode: "json" }).$type<AssistantMessage>(),
  /**
   * The tokens the model call used, one entry per attempt, once it answered (#64): what bounding
   * the history will be measured against.
   */
  usage: text("usage", { mode: "json" }).$type<Usage[]>(),
  createdAt: integer("created_at").notNull(),
});

/**
 * What the model sees, append-only: earlier messages are never rewritten, so replayed reasoning
 * stays valid. Each user message carries its author's `userId` (ADR-0015).
 */
export const history = sqliteTable("history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  turnId: integer("turn_id").notNull(),
  role: text("role", { enum: ["user", "assistant"] }).notNull(),
  userId: text("user_id"),
  /** The system prompt version the message was produced under. */
  systemVersion: integer("system_version").notNull(),
  /**
   * For a reply, the checkpoint its turn ran under (ADR-0017); null on user rows. A reply is
   * replayed with its native output only under the same one, because its reasoning is bound to the
   * prompt that came before it.
   */
  checkpointId: integer("checkpoint_id"),
  message: text("message", { mode: "json" }).$type<ChatMessage>().notNull(),
  createdAt: integer("created_at").notNull(),
});

/**
 * Summaries that bound a long conversation (ADR-0017). History stays append-only: the model sees
 * the system prompt, then the latest checkpoint's summary, then history from `keptFromHistoryId`
 * on. Summaries hold conversation content, so the erasure workflow (ADR-0006) must cover them.
 */
export const checkpoints = sqliteTable("checkpoints", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  summary: text("summary").notNull(),
  /** The first history row kept verbatim; every row before it is in the summary. */
  keptFromHistoryId: integer("kept_from_history_id").notNull(),
  /** What the summary call used. */
  usage: text("usage", { mode: "json" }).$type<Usage[]>(),
  createdAt: integer("created_at").notNull(),
});

/**
 * The bubbles of each reply. Only `pending` ones are ever sent; `sending` marks a send in flight,
 * which counts as sent if the turn ends before it returns.
 */
export const outbox = sqliteTable(
  "outbox",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    turnId: integer("turn_id").notNull(),
    seq: integer("seq").notNull(),
    text: text("text").notNull(),
    delayMs: integer("delay_ms").notNull(),
    status: text("status", { enum: ["pending", "sending", "sent", "cancelled"] }).notNull(),
    sentAt: integer("sent_at"),
  },
  (table) => [index("outbox_turn").on(table.turnId, table.seq)],
);

/** Small conversation-wide values: settings, counters, the destination, the pending flush. */
export const state = sqliteTable("state", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }),
});
