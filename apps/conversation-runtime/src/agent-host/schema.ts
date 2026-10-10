import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
    step: text("step", { enum: ["telegram_connected", "telegram_paired"] }).notNull(),
    until: integer("until").notNull(),
  },
  (table) => [primaryKey({ columns: [table.conversation, table.step] })],
);
