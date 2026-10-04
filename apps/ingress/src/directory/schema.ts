import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

// The Directory's copy of each user's access state. Postgres is the system of record (ADR-0004).

export const users = sqliteTable("users", {
  userId: text("user_id").primaryKey(),
  /** The newest version applied. A deleted user stays as a tombstone so older pushes can't revive it. */
  version: integer("version").notNull(),
  role: text("role", { enum: ["owner", "admin", "member"] }),
  deleted: integer("deleted", { mode: "boolean" }).notNull(),
});

export const identities = sqliteTable(
  "identities",
  {
    channel: text("channel").notNull(),
    channelUserId: text("channel_user_id").notNull(),
    userId: text("user_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.channel, table.channelUserId] })],
);

export const grants = sqliteTable(
  "grants",
  {
    userId: text("user_id").notNull(),
    agentId: text("agent_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.agentId] })],
);
