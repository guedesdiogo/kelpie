/** The channels Kelpie supports, in the order they arrive (ADR-0003). */
export type ChannelId = "webchat" | "telegram" | "whatsapp" | "slack" | "discord";

export type MessagePart =
  | { type: "text"; text: string }
  | {
      type: "media";
      kind: "image" | "audio" | "video" | "file";
      /** The provider's media id; adapters download the bytes to R2 separately. */
      mediaId: string;
      mimeType?: string;
      caption?: string;
    };

/** One inbound message, normalized from any channel. */
export interface CanonicalEvent {
  agentId: string;
  channel: ChannelId;
  /** The conversation on the channel: a chat, a DM or a thread. */
  threadId: string;
  sender: { channelUserId: string; displayName?: string };
  /** The provider's id for the message; unique only within its thread on some channels. */
  providerMessageId: string;
  /** When the provider says the message was sent (epoch ms). */
  providerTimestamp: number;
  parts: MessagePart[];
}

/** Identifies a provider message across channels and threads, for dedupe of webhook retries. */
export function dedupeKey(
  event: Pick<CanonicalEvent, "channel" | "threadId" | "providerMessageId">,
): string {
  return `${event.channel}:${event.threadId}:${event.providerMessageId}`;
}
