import { type Admission, DIRECTORY_NAME } from "@kelpie/access";
import type { CanonicalEvent } from "@kelpie/channels";

/**
 * Decides whether an inbound event may reach its agent. Channel routes call this before any
 * conversation or model runs. On a refusal they still answer the webhook with a 2xx, so the provider
 * doesn't retry, and store, forward and reply nothing. If this throws (the Directory is unreachable),
 * the route fails closed with a non-2xx, so the provider retries later.
 *
 * Only direct conversations are handled until multi-user lands (ADR-0015); any other chat type is
 * refused.
 */
export async function admitSender(env: Env, event: CanonicalEvent): Promise<Admission> {
  if (event.chatType !== "direct") return { admitted: false, reason: "group_chat" };
  return env.DIRECTORY.getByName(DIRECTORY_NAME).admit(
    { channel: event.channel, channelUserId: event.sender.channelUserId },
    event.agentId,
  );
}
