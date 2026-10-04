import type { ChannelId } from "@kelpie/channels";

// The access contract between channel routes and the Directory (ADR-0004). Phase 1 serves only the
// owner (ADR-0015); these types already carry what multi-user needs. They move to a shared package
// when another Worker needs them.

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
