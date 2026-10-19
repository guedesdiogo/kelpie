import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Which agents exist (ADR-0015 left it to Story 3.10). Each AgentHost owns its own configuration.

/**
 * How a row stores Master's role: the value from before ADR-0060, kept so a rollback reads it. The
 * Registry maps it to `master`, so no caller sees it.
 */
export const STORED_MASTER_ROLE = "main";

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  // ADR-0036 §1 (#288). The retired id's row says `specialist`, and is never read
  // (ADR-0048).
  role: text("role", { enum: [STORED_MASTER_ROLE, "specialist", "subagent"] })
    .notNull()
    .default("specialist"),
  ownerId: text("owner_id"),
  // On for the agents that existed before roles, so they keep chatting.
  chat: integer("chat", { mode: "boolean" }).notNull().default(true),
});

export const auditLog = sqliteTable("audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: integer("at").notNull(),
  action: text("action", {
    // `agent.main_set` records a new Master: the stored name from before ADR-0060, kept as written.
    enum: ["agent.created", "agent.renamed", "agent.main_set", "agent.chat_set", "agent.deleted"],
  }).notNull(),
  agentId: text("agent_id").notNull(),
  userId: text("user_id").notNull(),
  via: text("via").notNull(),
});
