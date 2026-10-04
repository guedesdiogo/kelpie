import type { Admission } from "@kelpie/access";
import type { CanonicalEvent } from "@kelpie/channels";

/** Kelpie runs one Directory (ADR-0004). */
export const DIRECTORY_NAME = "directory";

/**
 * Asks the Directory whether an inbound event's sender may reach its agent. Channel routes call
 * this before anything else wakes. On a refusal they still answer the webhook with a 2xx, so the
 * provider doesn't retry, and store, forward and reply nothing.
 */
export function admitSender(env: Env, event: CanonicalEvent): Promise<Admission> {
  return env.DIRECTORY.getByName(DIRECTORY_NAME).admit(
    { channel: event.channel, channelUserId: event.sender.channelUserId },
    event.agentId,
  );
}
