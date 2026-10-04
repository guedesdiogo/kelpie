import type { ChannelId } from "@kelpie/channels";

// The access contract shared by ingress, the conversation runtime and the configuration commands
// (ADR-0004). Kelpie serves only the owner until multi-user lands (ADR-0015); these types already
// carry what multi-user needs.

export type Role = "owner" | "admin" | "member";

export type IdentityStatus = "pending" | "enabled" | "disabled";

/** Every channel an identity can belong to. */
export const CHANNEL_IDS: readonly ChannelId[] = [
  "webchat",
  "telegram",
  "whatsapp",
  "slack",
  "discord",
];

export interface ChannelIdentity {
  channel: ChannelId;
  /** The same string a `CanonicalEvent` carries in `sender.channelUserId`. */
  channelUserId: string;
}

/**
 * Whether a sender may reach an agent. A refusal is a normal outcome, not an error: the channel
 * route acknowledges the webhook and drops the message, so the provider doesn't retry it.
 */
export type Admission =
  | { admitted: true; userId: string; role: Role }
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
 * Outcomes of a change to the Directory. Refusals are values, not exceptions: the configuration
 * commands turn them into answers for the owner.
 */
export type OwnerResult = { ok: true } | { ok: false; reason: "owner_exists" | "invalid_user" };
export type IdentityResult =
  | { ok: true; status: IdentityStatus }
  | {
      ok: false;
      reason: "unknown_user" | "unknown_identity" | "identity_taken" | "invalid_identity";
    };
