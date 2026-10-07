import type { Role } from "@kelpie/access";
import type { RecallOptions } from "@kelpie/context-store/contract";
import type { ChatType, Destination } from "@kelpie/conversation/contract";
import { conversationScope } from "@kelpie/memory";

// Which memory a turn may see, from who wrote it and where (#131). Ingress may run another version
// than this Worker, so what it says is checked here, and anything unknown fails closed.

/** Most privileged first. */
const ROLES: readonly Role[] = ["owner", "admin", "member"];
const CHAT_TYPES: readonly ChatType[] = ["direct", "group"];

/** A turn's authors, as the least of them: it answers every message, so for every author. */
export interface TurnAccess {
  /** Null when a message named no role ingress admits, as an ingress from before #131 sends. */
  role: Role | null;
  chatType: ChatType | null;
}

export function roleOf(value: unknown): Role | null {
  return ROLES.find((role) => role === value) ?? null;
}

export function chatTypeOf(value: unknown): ChatType | null {
  return CHAT_TYPES.find((chatType) => chatType === value) ?? null;
}

/** The least privileged of each, where an unknown one is less than any. */
export function leastAccess(messages: readonly TurnAccess[]): TurnAccess {
  return {
    role: least(
      ROLES,
      messages.map((message) => message.role),
    ),
    chatType: least(
      CHAT_TYPES,
      messages.map((message) => message.chatType),
    ),
  };
}

function least<T>(order: readonly T[], values: readonly (T | null)[]): T | null {
  let low: T | null = null;
  for (const value of values) {
    if (value === null) return null;
    if (low === null || order.indexOf(value) > order.indexOf(low)) low = value;
  }
  return low;
}

/**
 * Every scope for the owner in a direct chat (ADR-0015). Any other turn sees only its own
 * conversation, the memory every participant may see (ADR-0004).
 */
export function turnScopes(access: TurnAccess, destination: Destination): RecallOptions["scopes"] {
  return access.role === "owner" && access.chatType === "direct"
    ? "all"
    : [conversationScope(destination.channel, destination.threadId)];
}
