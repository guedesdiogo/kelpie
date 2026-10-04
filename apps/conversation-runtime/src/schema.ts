import type { AssistantMessage, ChatMessage } from "@kelpie/llm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// One conversation's state, in its ConversationAgent's SQLite (ADR-0002, ADR-0012). The Agents SDK
// keeps its own tables (schedules, fibers) alongside these.

/** Every message received, deduplicated by the provider's id. `turnId` is set once a turn claims it. */
export const inbound = sqliteTable("inbound", {
  providerMessageId: text("provider_message_id").primaryKey(),
  userId: text("user_id").notNull(),
  text: text("text").notNull(),
  receivedAt: integer("received_at").notNull(),
  turnId: integer("turn_id"),
});

export const turns = sqliteTable("turns", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** The conversation's generation when the turn started; a newer one means it was interrupted. */
  generation: integer("generation").notNull(),
  status: text("status", {
    enum: ["running", "delivered", "interrupted", "refused", "failed"],
  }).notNull(),
  attempts: integer("attempts").notNull(),
  /** The model's reply, kept until delivery settles what history records. */
  reply: text("reply", { mode: "json" }).$type<AssistantMessage>(),
  createdAt: integer("created_at").notNull(),
});

/**
 * What the model sees, append-only: earlier messages are never rewritten, so replayed reasoning
 * stays valid. Each message carries its author's `userId` (ADR-0015).
 */
export const history = sqliteTable("history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  turnId: integer("turn_id").notNull(),
  role: text("role", { enum: ["user", "assistant"] }).notNull(),
  userId: text("user_id"),
  /** The system prompt version the message was produced under. */
  systemVersion: integer("system_version").notNull(),
  message: text("message", { mode: "json" }).$type<ChatMessage>().notNull(),
  createdAt: integer("created_at").notNull(),
});

/** The bubbles of each reply. Only `pending` ones are ever sent, so recovery can resend safely. */
export const outbox = sqliteTable(
  "outbox",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    turnId: integer("turn_id").notNull(),
    seq: integer("seq").notNull(),
    text: text("text").notNull(),
    delayMs: integer("delay_ms").notNull(),
    status: text("status", { enum: ["pending", "sent", "cancelled"] }).notNull(),
    sentAt: integer("sent_at"),
  },
  (table) => [index("outbox_turn").on(table.turnId, table.seq)],
);

/** Small conversation-wide values: settings, the generation counter, the pending flush. */
export const state = sqliteTable("state", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }),
});
