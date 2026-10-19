import {
  type AgentRole,
  PROPOSAL_STATUSES,
  type ProposalChanges,
  type ProposalSnapshot,
} from "@kelpie/config";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Which agents exist (ADR-0015 left it to Story 3.10). Each AgentHost owns its own configuration.

/**
 * How a row stores Master's role: the value from before ADR-0060, kept so a rollback reads it. The
 * Registry maps it to `master`, so no caller sees it.
 */
export const STORED_MASTER_ROLE = "main";

/**
 * A role as callers see it: Master's stored value, or one cached from before ADR-0060, reads as
 * `master`.
 */
export function readRole(role: string | null | undefined): AgentRole | null {
  return role === STORED_MASTER_ROLE ? "master" : ((role ?? null) as AgentRole | null);
}

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

/**
 * Proposals (ADR-0061, #302): a change an owner agent asked for about an agent it owns, which only
 * the owner's act on the admin API's page applies. A row is never deleted: its status says how it
 * ended, and `proposal_events` how it got there.
 */
export const proposals = sqliteTable(
  "proposals",
  {
    id: text("id").primaryKey(),
    proposerId: text("proposer_id").notNull(),
    targetId: text("target_id").notNull(),
    /** The person the proposer's turn acted for (ADR-0015). */
    actingUserId: text("acting_user_id").notNull(),
    /** The proposer's task whose run made it; null for a chat turn. */
    taskId: text("task_id"),
    changes: text("changes", { mode: "json" }).$type<ProposalChanges>().notNull(),
    before: text("before", { mode: "json" }).$type<ProposalSnapshot>().notNull(),
    reason: text("reason").notNull(),
    status: text("status", { enum: PROPOSAL_STATUSES }).notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    /**
     * When an approval claimed it, then when the alarm last looked at it; the alarm looks again
     * five minutes after this. Once its target couldn't be read past expiry, the alarm stores a
     * time 55 minutes ahead instead, so it looks again an hour later.
     */
    claimedAt: integer("claimed_at"),
    decidedAt: integer("decided_at"),
    /** The person who decided it; null when it expired or went void by itself. */
    decidedBy: text("decided_by"),
    /** When its proposer heard the outcome; null until then. */
    toldAt: integer("told_at"),
    tellAttempts: integer("tell_attempts").notNull().default(0),
    /** When the alarm tries telling the proposer next; null while there is nothing to tell. */
    nextTellAt: integer("next_tell_at"),
  },
  (table) => [
    index("proposals_status").on(table.status),
    index("proposals_proposer").on(table.proposerId),
  ],
);

/** Every step of a proposal, append-only: who, through what, and what happened. */
export const proposalEvents = sqliteTable(
  "proposal_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    proposalId: text("proposal_id").notNull(),
    at: integer("at").notNull(),
    kind: text("kind", {
      enum: [
        "proposed",
        "claimed",
        "released",
        "applied",
        "refused",
        "expired",
        "conflict",
        "void",
        "told",
        "untold",
      ],
    }).notNull(),
    /** Null for Kelpie's own steps, such as an expiry. */
    userId: text("user_id"),
    via: text("via").notNull(),
  },
  (table) => [index("proposal_events_proposal").on(table.proposalId)],
);
