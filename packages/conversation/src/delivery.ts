import type { ChannelCapabilities } from "@kelpie/channels";
import { paceBubbles } from "./pacing.ts";
import { splitReply } from "./split.ts";

export interface PlannedBubble {
  text: string;
  /** How long to wait (showing "typing" in conversational mode) before sending this bubble. */
  delayMs: number;
}

/**
 * Turns a reply into the messages to send. Conversational: paragraphs as paced bubbles with a
 * typing delay. Off: as few messages as the channel allows, the first at once and the rest at
 * the channel's minimum gap.
 */
export function planDelivery(
  text: string,
  conversational: boolean,
  capabilities: ChannelCapabilities,
): PlannedBubble[] {
  const bubbles = splitReply(text, {
    maxLength: capabilities.maxMessageLength,
    maxBubbles: capabilities.maxBubblesPerReply,
    conversational,
  });
  const delays = conversational
    ? paceBubbles(bubbles, { minGapMs: capabilities.minGapMs })
    : bubbles.map((_, index) => (index === 0 ? 0 : capabilities.minGapMs));
  return bubbles.map((bubble, index) => ({ text: bubble, delayMs: delays[index] ?? 0 }));
}
