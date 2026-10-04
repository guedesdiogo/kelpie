import type { SendOptions } from "./adapter.ts";
import type { ChannelId } from "./events.ts";

// The contracts of the channel-egress Worker (ADR-0002), the only place that reads a channel's
// secrets. Other Workers reach it through service bindings, and every answer is a value: thrown
// errors lose their type and fields on the way across.

export interface EgressDestination {
  channel: ChannelId;
  threadId: string;
  /** Reply to (quote) this provider message, where the channel supports it. */
  replyToMessageId?: string;
}

export type DeliveryFailure =
  | { ok: false; reason: "not_connected" | "recipient_unavailable" | "failed" }
  | { ok: false; reason: "rate_limited"; retryAfterMs: number };

export type SendOutcome = { ok: true; providerMessageId: string } | DeliveryFailure;
export type TypingOutcome = { ok: true } | DeliveryFailure;

/** What the conversation runtime calls to reach a person. */
export interface ChannelEgressContract {
  send(
    agentId: string,
    destination: EgressDestination,
    text: string,
    options?: SendOptions,
  ): Promise<SendOutcome>;
  typing(agentId: string, destination: EgressDestination): Promise<TypingOutcome>;
}

/** What the admin API calls to take a channel's secrets through a one-time secure form (ADR-0013). */
export interface ChannelFormsContract {
  createTelegramForm(
    agentId: string,
  ): Promise<
    | { ok: true; token: string; expiresAt: number }
    | { ok: false; reason: "invalid_input" | "store_unavailable" }
  >;
  describeForm(
    token: string,
  ): Promise<
    | { ok: true; agentId: string; kind: "telegram" }
    | { ok: false; reason: "unknown_form" | "store_unavailable" }
  >;
  redeemTelegramForm(
    token: string,
    botToken: string,
  ): Promise<
    | { ok: true; agentId: string; bot: { id: number; username: string } }
    | {
        ok: false;
        reason: "unknown_form" | "invalid_token" | "token_refused" | "store_unavailable";
      }
  >;
}
