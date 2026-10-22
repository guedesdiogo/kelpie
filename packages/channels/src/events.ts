/**
 * The channels Kelpie supports, in the order they arrive (ADR-0003), and `task`: a task's own
 * conversation (#335), which reaches no person and sends nothing anywhere.
 */
export type ChannelId = "webchat" | "telegram" | "whatsapp" | "slack" | "discord" | "task";

export type MessagePart =
  | { type: "text"; text: string }
  | {
      type: "media";
      kind: "image" | "audio" | "video" | "file";
      /** The provider's media id. */
      mediaId: string;
      /**
       * Where the bytes live once stored. `normalize` can't download, so ingress fetches the media
       * into R2 and sets this before the event reaches the conversation.
       */
      r2Key?: string;
      mimeType?: string;
      caption?: string;
    };

/** One inbound message, normalized from any channel. */
export interface CanonicalEvent {
  agentId: string;
  channel: ChannelId;
  /** The conversation on the channel: a chat, a DM or a thread. */
  threadId: string;
  /** Direct messages and groups get different rules for replying and for memory (ADR-0004). */
  chatType: "direct" | "group";
  /**
   * Who sent it. `languageCode` is the language their app is set to, when the channel says
   * (Telegram's `language_code`): what Kelpie's fixed texts fall back to (#187).
   */
  sender: { channelUserId: string; displayName?: string; languageCode?: string };
  /** The provider's id for the message; unique only within its thread on some channels. */
  providerMessageId: string;
  /** When the provider says the message was sent (epoch ms). */
  providerTimestamp: number;
  parts: MessagePart[];
  /** The message this one replies to, when the user replied to a specific message. */
  replyTo?: { providerMessageId: string };
  /** Whether the message mentions the bot; set by adapters whose channel reports mentions. */
  mentionsBot?: boolean;
}

/**
 * A tap on a button under one of Kelpie's own notices, normalized from any channel (ADR-0067 §3).
 * Only Kelpie's notices carry buttons, and `data` is what Kelpie wrote on the one tapped.
 */
export interface CanonicalPress {
  agentId: string;
  channel: ChannelId;
  /** The conversation the notice is in. */
  threadId: string;
  chatType: "direct" | "group";
  /** Who tapped, with the language their app is set to when the channel says (#187). */
  sender: { channelUserId: string; languageCode?: string };
  /** The provider's id for the tap, which Kelpie answers. */
  pressId: string;
  /** The notice the button is on. */
  providerMessageId: string;
  data: string;
}

/** Identifies a provider message across channels and threads, for dedupe of webhook retries. */
export function dedupeKey(
  event: Pick<CanonicalEvent, "channel" | "threadId" | "providerMessageId">,
): string {
  // JSON keeps the parts apart even when an id contains the separator.
  return JSON.stringify([event.channel, event.threadId, event.providerMessageId]);
}
