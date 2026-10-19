import type { ModelSettings } from "@kelpie/llm/models";
import type { AgentRole } from "./commands.ts";
import { type AgentSettings, parseSettings } from "./settings.ts";

// Proposals (ADR-0036 §3, ADR-0060, #302): an owner agent asks for a change to an agent it owns,
// and only the owner's act on the admin API's page applies it. A proposal is a typed pending
// change, never a command.

/**
 * A proposal's life: `pending` until the owner decides or it expires; `applying` while an approval
 * runs; then `applied`, `refused`, `expired`, `conflict` (the target changed since, so nothing was
 * applied) or `void` (its proposer or target is gone).
 */
export const PROPOSAL_STATUSES = [
  "pending",
  "applying",
  "applied",
  "refused",
  "expired",
  "conflict",
  "void",
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/** How long a proposal waits for the owner (ADR-0060). */
export const PROPOSAL_TTL_MS = 72 * 60 * 60_000;

/** The caps the Registry holds proposals to (ADR-0060). */
export const PROPOSAL_CAPS = {
  /** Pending at once, per proposer and target. */
  perTarget: 1,
  /** Pending at once, per proposer. */
  perProposer: 3,
  /** Made in a day, per proposer. */
  perDay: 10,
  /** Pending at once, in all. */
  pending: 20,
} as const;

/** The longest reason an agent gives. */
export const MAX_PROPOSAL_REASON = 500;

/**
 * What a proposal may change, by the target's role (ADR-0036 §3): a specialist's `spawn`, tools,
 * remit, trio and chat, which Master owns; a subagent's trio, tools, remit, soul and skills, which
 * its creator owns. A specialist's soul, rules and skills live in the vault (ADR-0020 §5).
 */
export const PROPOSABLE = {
  specialist: ["model", "tools", "remit", "spawn", "chat"],
  subagent: ["model", "tools", "remit", "systemPrompt", "skills"],
} as const satisfies Record<Exclude<AgentRole, "main">, readonly string[]>;

/** The settings a proposal may change on the target's AgentHost. */
export type ProposedSettings = Partial<
  Pick<AgentSettings, "model" | "tools" | "remit" | "spawn" | "systemPrompt" | "skills">
>;

/**
 * A proposal's change: one object's, so it applies in one step. The Registry's chat for a
 * specialist, or settings on the target's AgentHost.
 */
export type ProposalChanges = { chat: boolean } | ProposedSettings;

/** The same fields' values at some moment: when a proposal was made, or now. */
export type ProposalSnapshot = ProposedSettings & { chat?: boolean };

/** A proposal as the Registry keeps it. */
export interface Proposal {
  id: string;
  proposer: string;
  target: string;
  /** The person the proposer's turn acted for (ADR-0015). */
  actingUserId: string;
  /** The proposer's task whose run made it, if one did. */
  taskId: string | null;
  /** The change as it applies: a trio is the whole result, merged into the target's own. */
  changes: ProposalChanges;
  /** The same fields as they were when it was made: it applies only while they still are. */
  before: ProposalSnapshot;
  /** The proposer's words: data, never instructions. */
  reason: string;
  status: ProposalStatus;
  createdAt: number;
  expiresAt: number;
  decidedAt: number | null;
  /** The person who decided it, by user id. */
  decidedBy: string | null;
}

/** What the Registry records for a new proposal. */
export type NewProposal = Pick<
  Proposal,
  "proposer" | "target" | "actingUserId" | "taskId" | "changes" | "before" | "reason"
>;

/** A proposal with its target's values now, for the owner's page. */
export interface ProposalDetail extends Proposal {
  /** The changed fields' values now; null when the target is gone. */
  current: ProposalSnapshot | null;
  /** Whether the target changed since the proposal, so approving it would apply nothing. */
  stale: boolean;
}

/** How the Registry answers a step on a proposal. */
export type ProposalResult =
  | { ok: true; value: Proposal }
  | {
      ok: false;
      reason:
        | "invalid_input"
        | "unknown_agent"
        | "not_allowed"
        | "unknown_proposal"
        | "not_pending"
        | "too_many";
    };

/** The outcome a proposer hears (ADR-0060): every one but `void`, whose proposer or target went. */
export type ProposalOutcome = Pick<Proposal, "id" | "target" | "taskId" | "actingUserId"> & {
  status: "applied" | "refused" | "expired" | "conflict";
  fields: string[];
};

/** Kelpie's notice of a new proposal, for the owner's conversation with Master (ADR-0060). */
export type ProposalNotice = Pick<
  Proposal,
  "id" | "proposer" | "target" | "actingUserId" | "reason" | "expiresAt"
> & { fields: string[] };

/** Proposal ids are random UUIDs, as task ids are. */
export function isProposalId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  );
}

/**
 * The change, when the target's role takes every field it names and they parse as settings do; null
 * for anything else, an empty change, or chat beside settings.
 */
export function parseProposalChanges(role: AgentRole, input: unknown): ProposalChanges | null {
  if (role === "main" || typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const fields = Object.keys(input);
  const allowed: readonly string[] = PROPOSABLE[role];
  if (fields.length === 0 || !fields.every((field) => allowed.includes(field))) return null;
  const { chat, ...settings } = input as Record<string, unknown>;
  if (chat !== undefined) {
    return typeof chat === "boolean" && fields.length === 1 ? { chat } : null;
  }
  return parseSettings(settings) as ProposedSettings | null;
}

/** A proposed trio merged into the agent's own, area by area, so the owner approves the result. */
export function mergeModel(current: ModelSettings, proposed: ModelSettings): ModelSettings {
  const merged: ModelSettings = { ...current, ...proposed };
  for (const area of ["conversation", "memory"] as const) {
    if (proposed[area]) merged[area] = { ...current[area], ...proposed[area] };
  }
  return merged;
}

/** The agent's reason: up to MAX_PROPOSAL_REASON characters, with something that shows. */
export function parseProposalReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const reason = value.trim();
  const shows = /[^\p{White_Space}\p{Default_Ignorable_Code_Point}]/u.test(reason);
  return shows && reason.length <= MAX_PROPOSAL_REASON ? reason : null;
}

/** Whether two values are the same, as JSON with every object's keys sorted. */
export function sameValue(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  if (value === undefined) return "undefined";
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
}
