import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Kelpie's secret store (ADR-0013), in its SecretStore's SQLite. Values are encrypted at the
// application level; nothing here is readable without the Worker secret.

/** One secret per slot, such as `telegram:<agentId>`. */
export const secrets = sqliteTable("secrets", {
  slot: text("slot").primaryKey(),
  keyVersion: integer("key_version").notNull(),
  iv: text("iv").notNull(),
  ciphertext: text("ciphertext").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * One-time secure forms. Only the token's SHA-256 is kept: the token itself lives in the link the
 * owner opens.
 */
export const forms = sqliteTable("forms", {
  tokenHash: text("token_hash").primaryKey(),
  agentId: text("agent_id").notNull(),
  kind: text("kind", { enum: ["telegram"] }).notNull(),
  expiresAt: integer("expires_at").notNull(),
  /** Values refused so far; the form closes after a few, so a link can't probe tokens forever. */
  refusals: integer("refusals").notNull().default(0),
  /**
   * When the form stored its value. A used form is kept a while, until `expiresAt`, so the same
   * value sent again, as a double click sends it, is answered with what it connected.
   */
  redeemedAt: integer("redeemed_at"),
});
