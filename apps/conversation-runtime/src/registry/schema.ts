import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Which agents exist (ADR-0015 left it to Story 3.10). Each AgentHost owns its own configuration.

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const auditLog = sqliteTable("audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: integer("at").notNull(),
  action: text("action", { enum: ["agent.created", "agent.renamed"] }).notNull(),
  agentId: text("agent_id").notNull(),
  userId: text("user_id").notNull(),
  via: text("via").notNull(),
});
