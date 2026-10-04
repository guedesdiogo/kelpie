import type { CanonicalEvent } from "@kelpie/channels";
import type { Admission } from "./access.ts";

/** Kelpie runs one Directory (ADR-0004). */
export const DIRECTORY_NAME = "directory";

/**
 * Decides whether an inbound event may reach its agent. Channel routes call this before anything
 * else wakes. On a refusal they still answer the webhook with a 2xx, so the provider doesn't retry,
 * and store, forward and reply nothing. Phase 1 handles direct conversations only (ADR-0015).
 */
export async function admitSender(env: Env, event: CanonicalEvent): Promise<Admission> {
  if (event.chatType === "group") return { admitted: false, reason: "group_chat" };
  return env.DIRECTORY.getByName(DIRECTORY_NAME).admit(
    { channel: event.channel, channelUserId: event.sender.channelUserId },
    event.agentId,
  );
}
