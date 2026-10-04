import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// One agent's configuration, in its AgentHost's SQLite (ADR-0002, ADR-0012).

/** Small values: the settings and the prompt version. */
export const state = sqliteTable("state", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }),
});

/** Every configuration change: who asked, through what, and which settings changed (ADR-0013). */
export const auditLog = sqliteTable("audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: integer("at").notNull(),
  action: text("action", { enum: ["settings.changed"] }).notNull(),
  userId: text("user_id").notNull(),
  via: text("via").notNull(),
  fields: text("fields", { mode: "json" }).$type<string[]>().notNull(),
});
