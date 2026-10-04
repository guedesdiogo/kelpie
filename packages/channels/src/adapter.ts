import type { ChannelCapabilities } from "./capabilities.ts";
import type { CanonicalEvent, ChannelId } from "./events.ts";

/** An inbound webhook as plain data, so adapters stay independent of the Workers runtime. */
export interface InboundWebhook {
  /** Header names are lower-cased by ingress, because providers vary their case. */
  headers: Record<string, string>;
  body: string;
}

/** Where an outbound message goes. */
export interface Destination {
  threadId: string;
  /** Reply to (quote) this provider message, where the channel supports it. */
  replyToMessageId?: string;
}

/**
 * Thrown by `normalize` for a body it can't parse. Ingress acknowledges such webhooks so the
 * provider stops retrying a poisoned payload, and logs them for inspection.
 */
export class InvalidWebhookError extends Error {
  override readonly name = "InvalidWebhookError";
}

export interface SendResult {
  providerMessageId: string;
}

export interface SendOptions {
  /** Deliver without a notification; a reply notifies only on its last bubble. */
  silent?: boolean;
}

/** The channel asked to slow down. Retrying before `retryAfterMs` fails again. */
export class ChannelRateLimitedError extends Error {
  override readonly name = "ChannelRateLimitedError";
  constructor(readonly retryAfterMs: number) {
    super(`The channel asked to retry after ${retryAfterMs} ms`);
  }
}

/** The recipient can't be reached, for example because they blocked the bot. Retrying won't help. */
export class RecipientUnavailableError extends Error {
  override readonly name = "RecipientUnavailableError";
}

/**
 * Any other failed call. It names the method and the status only: a request URL can carry the bot
 * token, and a provider's description can quote the message.
 */
export class ChannelRequestError extends Error {
  override readonly name = "ChannelRequestError";
  constructor(
    readonly method: string,
    readonly status: number | null,
  ) {
    super(
      status === null
        ? `${method} got no usable answer from the channel`
        : `${method} failed with ${status}`,
    );
  }
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
  /**
   * Turns a verified webhook into zero or more events; delivery receipts yield none. An edited
   * message yields none either: it is neither a new message nor a retry of one (#70).
   * Throws `InvalidWebhookError` for a body it can't parse.
   */
  normalize(webhook: InboundWebhook, agentId: string): CanonicalEvent[];
  /**
   * Sends one message, already split for this channel. Throws `ChannelRateLimitedError`,
   * `RecipientUnavailableError` or `ChannelRequestError`.
   */
  send(destination: Destination, text: string, options?: SendOptions): Promise<SendResult>;
  /** Shows "typing" once; callers renew it with typingRenewIntervalMs. */
  typing(destination: Destination): Promise<void>;
}
