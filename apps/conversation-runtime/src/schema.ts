import type { AgentSettings } from "@kelpie/config";
import type { AssistantMessage, ChatMessage, Usage } from "@kelpie/llm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { HostLink } from "./tools.ts";

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
    /** The author's role and the chat, as ingress admitted them; null for none it named (#131). */
    role: text("role", { enum: ["owner", "admin", "member"] }),
    chatType: text("chat_type", { enum: ["direct", "group"] }),
    turnId: integer("turn_id"),
    /**
     * A note Kelpie wrote, not the person (#206): that the owner finished a setup step. It is
     * authored as that owner, so its turn keeps their role, but it is never read as their words.
     */
    fromKelpie: integer("from_kelpie", { mode: "boolean" }).notNull().default(false),
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
  /**
   * The memories the turn's request carried (#110), as the attempt that answered sent them. Later
   * requests send them again after the turn's last user message, so the prefix before its reply
   * stays what the model saw (#137). History rows never hold them.
   */
  context: text("context"),
  /**
   * The notes in `context` that Kelpie wrote itself, by path (#126): their text may be the model's,
   * so their links never count as the turn's inputs for a preview (#130).
   */
  kelpieNotes: text("kelpie_notes", { mode: "json" }).$type<string[]>(),
  /**
   * A digest of the tools the turn's requests sent, null for none (ADR-0025). A reply is replayed
   * with its native output only to a turn with the same tools: its reasoning is bound to them.
   */
  toolsKey: text("tools_key"),
  /**
   * A digest of the system prompt the turn's requests sent and the heading that leads a
   * checkpoint's summary, null before it was kept (#211). A reply is replayed with its native
   * output only to a turn with the same key, so a deploy that edits built-in text drops it.
   */
  promptKey: text("prompt_key"),
  /**
   * The least-privileged role and chat type among the turn's messages, null where one wasn't
   * known (#131). Recall, the tools and the actor read them, so a retry sees the same memory.
   */
  role: text("role", { enum: ["owner", "admin", "member"] }),
  chatType: text("chat_type", { enum: ["direct", "group"] }),
  /**
   * The links the turn's tools had Kelpie send after its reply (#186), until the reply's bubbles
   * are written and they follow it as notices. Cleared when the turn settles.
   */
  links: text("links", { mode: "json" }).$type<HostLink[]>(),
  createdAt: integer("created_at").notNull(),
});

/**
 * What the model sees, append-only: earlier messages are never rewritten, so replayed reasoning
 * stays valid. Each user message carries its author's `userId` (ADR-0015). A turn that runs tools
 * adds a reply asking for them, then a `tool` row with every call's result (ADR-0025).
 */
export const history = sqliteTable("history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  turnId: integer("turn_id").notNull(),
  role: text("role", { enum: ["user", "assistant", "tool"] }).notNull(),
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
  /**
   * A user row holding Kelpie's own note (#206), as on `inbound`: the model reads it, and nothing
   * that reads the person's words does (the code gate, allowed links, the replay, session pages,
   * the conversation's language, recall).
   */
  fromKelpie: integer("from_kelpie", { mode: "boolean" }).notNull().default(false),
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
    /**
     * A notice the host adds after the reply: a confirmation (ADR-0013) or a tool's link (#186).
     * History keeps only the reply's bubbles: the model never sees a notice's code or link.
     */
    notice: integer("notice", { mode: "boolean" }).notNull().default(false),
    /** A link notice's one link, the only text in it that shows as a link (#186). */
    link: text("link"),
    /** The confirmation a notice is for: the webchat shows it with a Confirm button (#186). */
    confirmationId: integer("confirmation_id"),
  },
  (table) => [index("outbox_turn").on(table.turnId, table.seq)],
);

/**
 * Changes waiting for the owner's yes (ADR-0013, Story 3.11). A code confirms exactly one command
 * and input, for the user who asked, from a message of theirs written after the code was made.
 */
export const confirmations = sqliteTable(
  "confirmations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    code: text("code").notNull(),
    userId: text("user_id").notNull(),
    command: text("command").notNull(),
    /** The parsed input, as canonical JSON. */
    input: text("input").notNull(),
    /** What the owner is shown, written by the tool's code. */
    summary: text("summary").notNull(),
    /** Only the requester's messages after this history row can confirm. */
    afterHistoryId: integer("after_history_id").notNull(),
    /** The turn whose reply shows the notice: the latest that asked. */
    turnId: integer("turn_id").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    /** When a call went ahead on it: a code confirms once. */
    usedAt: integer("used_at"),
  },
  (table) => [index("confirmations_request").on(table.userId, table.command, table.input)],
);

/** Small conversation-wide values: settings, counters, the destination, the pending flush. */
export const state = sqliteTable("state", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }),
});
