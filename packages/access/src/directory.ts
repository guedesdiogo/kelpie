import type { ChannelId } from "@kelpie/channels";

export type Role = "owner" | "admin" | "member";

export interface ChannelIdentity {
  channel: ChannelId;
  /** The same string a `CanonicalEvent` carries in `sender.channelUserId`. */
  channelUserId: string;
}

/**
 * A user's complete access state as the `Directory` holds it: enabled identities only, and the
 * agents granted. `version` comes from a Postgres sequence, so it only grows; the `Directory`
 * ignores an entry older than the one it has, which makes pushes safe to repeat or reorder.
 */
export type DirectoryEntry =
  | {
      userId: string;
      version: number;
      deleted: false;
      role: Role;
      identities: ChannelIdentity[];
      agentIds: string[];
    }
  | { userId: string; version: number; deleted: true };

/** Where the access service pushes each change. The `Directory` Durable Object implements it. */
export interface DirectoryPort {
  putUser(entry: DirectoryEntry): Promise<unknown>;
}

/**
 * Whether a sender may reach an agent. A refusal is a normal outcome, not an error: the channel
 * route acknowledges the webhook and drops the message, so the provider doesn't retry it.
 */
export type Admission =
  | { admitted: true; userId: string; role: Role }
  | { admitted: false; reason: "unknown_identity" | "no_grant" };
