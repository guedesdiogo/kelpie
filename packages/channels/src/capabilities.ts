import type { ChannelId } from "./events.ts";

export type Formatting = "plain" | "markdown" | "telegram-html" | "whatsapp" | "slack-mrkdwn";

export interface ChannelCapabilities {
  /** The longest message the channel accepts, in characters. */
  maxMessageLength: number;
  /** Whether the bot can show "typing", and how long one indicator lasts (null: until cleared). */
  typing: { supported: boolean; ttlMs: number | null };
  /**
   * Whether the channel can show what a turn is doing (reading memory, thinking, using a tool), not
   * only "typing" (#141).
   */
  status: boolean;
  /** The minimum gap between two messages to the same conversation. */
  minGapMs: number;
  /** A stricter gap for group conversations, when the channel limits groups separately. */
  groupMinGapMs?: number;
  /** The most bubbles one reply should become in conversational mode. */
  maxBubblesPerReply: number;
  formatting: Formatting;
}

/** Channel limits from research note 06; more channels are added as they arrive (ADR-0003). */
export const CAPABILITIES = {
  webchat: {
    maxMessageLength: 16_000,
    typing: { supported: true, ttlMs: null },
    status: true,
    minGapMs: 0,
    maxBubblesPerReply: 6,
    formatting: "markdown",
  },
  telegram: {
    maxMessageLength: 4_096,
    typing: { supported: true, ttlMs: 5_000 },
    // Telegram's chat actions have no "thinking".
    status: false,
    minGapMs: 1_000,
    // About 20 messages per minute in a group.
    groupMinGapMs: 3_000,
    maxBubblesPerReply: 5,
    formatting: "telegram-html",
  },
} as const satisfies Partial<Record<ChannelId, ChannelCapabilities>>;

/** Re-send "typing" after this fraction of its lifetime, so it never lapses between renewals. */
const TYPING_RENEW_FRACTION = 0.8;

/** How often to re-send "typing" so it never lapses, or null when no renewal is needed. */
export function typingRenewIntervalMs({
  typing,
}: Pick<ChannelCapabilities, "typing">): number | null {
  if (!typing.supported || typing.ttlMs === null) return null;
  return Math.floor(typing.ttlMs * TYPING_RENEW_FRACTION);
}
