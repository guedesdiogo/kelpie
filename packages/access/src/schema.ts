import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  check,
  jsonb,
  pgSequence,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

// The system of record for who may reach which agent (ADR-0004, ADR-0007). The Directory Durable
// Object holds the hot-path copy.

/** Orders every user's access state. A sequence never rolls back, so versions only grow. */
export const accessVersion = pgSequence("access_version");

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    displayName: text("display_name").notNull(),
    role: text("role", { enum: ["owner", "admin", "member"] }).notNull(),
    /** The version of the last access change, taken from `access_version`. */
    version: bigint("version", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("users_role", sql`${table.role} in ('owner', 'admin', 'member')`)],
);

export const channelIdentities = pgTable(
  "channel_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    /** Personal data (a phone number on WhatsApp), so it never goes into the audit log. */
    channelUserId: text("channel_user_id").notNull(),
    /** Only enabled identities reach the Directory. Pairing moves an identity to enabled. */
    status: text("status", { enum: ["pending", "enabled", "disabled"] })
      .notNull()
      .default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("channel_identities_channel_user").on(table.channel, table.channelUserId),
    check("channel_identities_status", sql`${table.status} in ('pending', 'enabled', 'disabled')`),
  ],
);

export const agents = pgTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const grants = pgTable(
  "grants",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.agentId] })],
);

/**
 * Every access change. Rows reference users by id without a foreign key, so erasing a user doesn't
 * rewrite history, and `details` holds ids, never identity values.
 */
export const auditLog = pgTable("audit_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  actorUserId: uuid("actor_user_id"),
  action: text("action").notNull(),
  targetUserId: uuid("target_user_id"),
  details: jsonb("details").$type<Record<string, string>>().notNull().default({}),
});
