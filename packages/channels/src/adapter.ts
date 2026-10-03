import type { ChannelCapabilities } from "./capabilities.ts";
import type { CanonicalEvent, ChannelId } from "./events.ts";

/** An inbound webhook as plain data, so adapters stay independent of the Workers runtime. */
export interface InboundWebhook {
  headers: Record<string, string>;
  body: string;
}

/** Where an outbound message goes. */
export interface Destination {
  threadId: string;
}

export interface SendResult {
  providerMessageId: string;
}

/**
 * What every channel implements (ADR-0003). Buffering, splitting, pacing and interruption live in
 * the conversation Durable Object, not here, so every channel behaves the same way.
 */
export interface ChannelAdapter {
  readonly id: ChannelId;
  readonly capabilities: ChannelCapabilities;
  /** Checks the provider's signature or secret before anything else runs. */
  verify(webhook: InboundWebhook): Promise<boolean>;
  /** Turns a verified webhook into zero or more events; delivery receipts yield none. */
  normalize(webhook: InboundWebhook, agentId: string): CanonicalEvent[];
  /** Sends one message, already split and formatted for this channel. */
  send(destination: Destination, text: string): Promise<SendResult>;
  /** Shows "typing" once; callers renew it with typingRenewIntervalMs. */
  typing(destination: Destination): Promise<void>;
}
