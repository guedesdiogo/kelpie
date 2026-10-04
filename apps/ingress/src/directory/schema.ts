import type { ChannelIdentity } from "@kelpie/access";
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// Who may reach the agents. In phase 1 the Directory is the source of truth and holds only the
// owner (ADR-0015); multi-user moves the source of truth to Postgres (Epic 7).

export const users = sqliteTable(
  "users",
  {
    userId: text("user_id").primaryKey(),
    role: text("role", { enum: ["owner", "admin", "member"] }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [uniqueIndex("users_one_owner").on(table.role).where(sql`role = 'owner'`)],
);

export const identities = sqliteTable(
  "identities",
  {
    channel: text("channel").$type<ChannelIdentity["channel"]>().notNull(),
    /** Personal data (a phone number on WhatsApp), so it never goes into the audit log. */
    channelUserId: text("channel_user_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.userId),
    /** Only enabled identities are admitted. Pairing moves an identity to enabled. */
    status: text("status", { enum: ["pending", "enabled", "disabled"] }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.channel, table.channelUserId] }),
    index("identities_user_id").on(table.userId),
  ],
);

export const auditLog = sqliteTable("audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: integer("at", { mode: "timestamp_ms" }).notNull(),
  action: text("action", {
    enum: ["owner.registered", "identity.added", "identity.enabled", "identity.disabled"],
  }).notNull(),
  userId: text("user_id"),
  /** The channel only: the identity value is personal data. */
  channel: text("channel"),
});
