import type { ChannelIdentity } from "@kelpie/access";
import type { ChannelId } from "@kelpie/channels";
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
    /** The user's IANA time zone, in its canonical spelling; null until they set one. */
    timeZone: text("time_zone"),
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

/**
 * One live pairing code per user and channel (Story 3.6), stored only as a salted SHA-256. The
 * owner gets the code on the admin API and sends it to the bot with `/start <code>`.
 */
export const pairingCodes = sqliteTable(
  "pairing_codes",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.userId),
    channel: text("channel").$type<ChannelId>().notNull(),
    salt: text("salt").notNull(),
    hash: text("hash").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.channel] })],
);

/**
 * Wrong codes per sender. Redemption arrives through the public bot, so the lock is per sender: a
 * stranger's guesses never lock the owner out. Senders' ids are personal data; a row goes once it
 * is an hour stale.
 */
export const pairingFailures = sqliteTable(
  "pairing_failures",
  {
    channel: text("channel").$type<ChannelId>().notNull(),
    channelUserId: text("channel_user_id").notNull(),
    count: integer("count").notNull(),
    lastFailureAt: integer("last_failure_at", { mode: "timestamp_ms" }).notNull(),
    lockedUntil: integer("locked_until", { mode: "timestamp_ms" }),
  },
  (table) => [primaryKey({ columns: [table.channel, table.channelUserId] })],
);

/** Strangers the owner was told about, so each is told once. A row goes after 30 days. */
export const noticedSenders = sqliteTable(
  "noticed_senders",
  {
    channel: text("channel").$type<ChannelId>().notNull(),
    channelUserId: text("channel_user_id").notNull(),
    noticedAt: integer("noticed_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.channel, table.channelUserId] }),
    index("noticed_senders_noticed_at").on(table.channel, table.noticedAt),
  ],
);

export const auditLog = sqliteTable("audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: integer("at", { mode: "timestamp_ms" }).notNull(),
  action: text("action", {
    enum: [
      "owner.registered",
      "identity.added",
      "identity.enabled",
      "identity.disabled",
      "identity.paired",
      "pairing.code_issued",
      "pairing.locked",
      "user.time_zone_changed",
    ],
  }).notNull(),
  userId: text("user_id"),
  /** The channel only: the identity value is personal data. */
  channel: text("channel"),
});
