import type { ChannelId } from "@kelpie/channels";

// The access contract shared by ingress, the conversation runtime and the configuration commands
// (ADR-0004). Kelpie serves only the owner until multi-user lands (ADR-0015); these types already
// carry what multi-user needs.

export type Role = "owner" | "admin" | "member";

export type IdentityStatus = "pending" | "enabled" | "disabled";

/** Kelpie runs one Directory (ADR-0004). */
export const DIRECTORY_NAME = "directory";

/** Every channel an identity can belong to. */
export const CHANNEL_IDS: readonly ChannelId[] = [
  "webchat",
  "telegram",
  "whatsapp",
  "slack",
  "discord",
];

/**
 * The owner's Cloudflare Access login, which the admin API admits. It is an identity source, not a
 * channel: only the first-run bootstrap adds one, and no configuration command can.
 */
export const ACCESS_SOURCE = "cloudflare-access";

/**
 * The agent id an admin API call is admitted for. It names no agent, because no agent id can equal
 * it. Multi-user decides what admin admission means for each role (ADR-0015).
 */
export const ADMIN_AGENT_ID = "*";

export interface ChannelIdentity {
  channel: ChannelId | typeof ACCESS_SOURCE;
  /** The same string a `CanonicalEvent` carries in `sender.channelUserId`, or an Access `sub`. */
  channelUserId: string;
}

/**
 * Whether a sender may reach an agent. A refusal is a normal outcome, not an error: the channel
 * route acknowledges the webhook and drops the message, so the provider doesn't retry it. An
 * admission carries the user's IANA time zone, or null while they haven't set one.
 */
export type Admission =
  | { admitted: true; userId: string; role: Role; timeZone: string | null }
  | { admitted: false; reason: "unknown_identity" | "no_grant" | "group_chat" };

/**
 * An identity value is personal data (a phone number on WhatsApp), so anything shown to people or
 * returned by an API masks it: the first two and last two characters stay, the rest becomes "•".
 */
export function maskIdentityValue(value: string): string {
  const characters = [...value];
  if (characters.length <= 4) return "•".repeat(characters.length);
  return `${characters.slice(0, 2).join("")}${"•".repeat(characters.length - 4)}${characters.slice(-2).join("")}`;
}

/**
 * The canonical IANA name for a time zone (`america/sao_paulo` becomes `America/Sao_Paulo`), or
 * null if it isn't one. UTC offsets such as `+03:00` are refused: a zone also knows its daylight
 * saving rules.
 */
export function canonicalTimeZone(value: unknown): string | null {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(value)) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

export type TimeZoneResult =
  | { ok: true; timeZone: string }
  | { ok: false; reason: "unknown_user" | "invalid_time_zone" };

/** How another Worker sees an object's methods: every call returns a promise. */
export type Remote<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

/**
 * Outcomes of a change to the Directory. Refusals are values, not exceptions: the configuration
 * commands turn them into answers for the owner.
 */
export type OwnerResult = { ok: true } | { ok: false; reason: "owner_exists" | "invalid_user" };
export type IdentityResult =
  | { ok: true; status: IdentityStatus }
  | {
      ok: false;
      reason: "unknown_identity" | "invalid_identity" | "not_paired";
    };

/** A one-time code the owner sends to a channel's bot to pair their account there (Story 3.6). */
export type PairingCodeResult =
  | { ok: true; code: string; expiresAt: number }
  | { ok: false; reason: "unknown_user" | "invalid_channel" };

/**
 * A `/start <code>` from an unpaired sender. Five wrong codes from one sender, with no hour-long
 * pause between them, lock that sender out for an hour; nobody else.
 */
export type PairingResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "invalid_code" | "locked" | "identity_taken" | "invalid_identity" };

/** Whether to tell the owner about a dropped stranger, and where: the owner's own account there. */
export type StrangerNotice = { notify: true; ownerChannelUserId: string } | { notify: false };

/**
 * The `Directory` methods other Workers call. The object implements it, and callers bind it as
 * `Remote<DirectoryContract>`, so a change on either side fails the type check.
 */
export interface DirectoryContract {
  admit(identity: ChannelIdentity, agentId: string): Admission;
  ownerExists(): boolean;
  bootstrapOwner(userId: string, accessSub: string): OwnerResult;
  issuePairingCode(userId: string, channel: ChannelId): Promise<PairingCodeResult>;
  redeemPairingCode(code: string, identity: ChannelIdentity): Promise<PairingResult>;
  noticeStranger(sender: ChannelIdentity): StrangerNotice;
  releaseStrangerNotice(sender: ChannelIdentity): void;
  enableIdentity(identity: ChannelIdentity): IdentityResult;
  disableIdentity(identity: ChannelIdentity): IdentityResult;
  listIdentities(): (ChannelIdentity & { status: IdentityStatus })[];
  setTimeZone(userId: string, timeZone: string): TimeZoneResult;
}
