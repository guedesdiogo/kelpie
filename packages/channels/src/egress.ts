import type { SendOptions } from "./adapter.ts";
import type { ChannelId } from "./events.ts";
import type { Locale } from "./locale.ts";
import type { RunnerAnswered, RunnerState } from "./runner.ts";

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

/**
 * Why a bot's webhook couldn't be registered: no bot is stored for the agent, ingress's public
 * origin isn't configured, or the channel refused or couldn't be reached.
 */
export type WebhookRegistrationFailure =
  | "invalid_input"
  | "not_connected"
  | "not_configured"
  | "channel_refused"
  | "store_unavailable";

export type WebhookRegistration = { ok: true } | { ok: false; reason: WebhookRegistrationFailure };

/**
 * What disconnecting a deleted agent's bot did (#303). Its secret is gone in every `ok` case; the
 * webhook was removed at Telegram, refused there for good (as with a revoked token), or there was
 * no bot. `channel_unavailable`: Telegram failed for now, so the secret is kept for another try.
 */
export type TelegramDisconnection =
  | { ok: true; webhook: "removed" | "refused" | "none" }
  | { ok: false; reason: "invalid_input" | "store_unavailable" | "channel_unavailable" };

/**
 * A fixed notice ingress may have the bot send (Story 3.6): "paired" to an account that just paired,
 * or "stranger" to the owner about a sender who was dropped. channel-egress writes the text, in
 * `locale` (#187), or in English when an older ingress names none.
 */
export type WebhookNotice =
  | { kind: "paired"; locale?: Locale }
  | { kind: "stranger"; senderId: string; displayName?: string; locale?: Locale };

/**
 * What ingress calls: check that a webhook came from the agent's own bot, and send one of the fixed
 * notices. It can't send text of its own.
 */
export interface ChannelWebhooksContract {
  verifyTelegram(
    agentId: string,
    presentedSecret: string | null,
  ): Promise<{ ok: true } | { ok: false; reason: "refused" | "store_unavailable" }>;
  notice(
    agentId: string,
    destination: EgressDestination,
    notice: WebhookNotice,
  ): Promise<TypingOutcome>;
}

/** What the admin API calls to take a channel's secrets through a one-time secure form (ADR-0013). */
export interface ChannelFormsContract {
  createTelegramForm(
    agentId: string,
  ): Promise<
    | { ok: true; token: string; expiresAt: number }
    | { ok: false; reason: "invalid_input" | "store_unavailable" }
  >;
  /** An open form, or one used in the last few minutes with the bot it connected. */
  describeForm(
    token: string,
  ): Promise<
    | { ok: true; agentId: string; kind: "telegram" | "runner" }
    | { ok: false; reason: "redeemed"; agentId: string; username: string }
    | { ok: false; reason: "unknown_form" | "store_unavailable" }
  >;
  redeemTelegramForm(
    token: string,
    botToken: string,
  ): Promise<
    | {
        ok: true;
        agentId: string;
        bot: { id: number; username: string };
        /** The token is stored either way; a failed registration can be repeated on its own. */
        webhook: "registered" | WebhookRegistrationFailure;
      }
    | {
        ok: false;
        reason: "unknown_form" | "invalid_token" | "token_refused" | "store_unavailable";
      }
  >;
  /** Points the agent's bot at ingress again: safe to repeat, as after a hostname change. */
  registerTelegramWebhook(agentId: string): Promise<WebhookRegistration>;
  /**
   * For a deleted agent (#303): removes its bot's webhook at Telegram, then its secret and forms.
   * Safe to repeat; an agent without a bot answers `none`. Admin's id is `invalid_input`.
   */
  disconnectTelegram(agentId: string): Promise<TelegramDisconnection>;
  /** The agent's bot, for its `t.me` link. Never its token. */
  describeTelegramBot(
    agentId: string,
  ): Promise<
    | { ok: true; username: string }
    | { ok: false; reason: "invalid_input" | "not_connected" | "store_unavailable" }
  >;
  /** Opens a one-time form for the runner's secret, when `channel-egress` has the runner's binding. */
  createRunnerForm(): Promise<
    | { ok: true; token: string; expiresAt: number }
    | { ok: false; reason: "not_configured" | "store_unavailable" }
  >;
  /**
   * Checks the secret against the runner's `/health`, then stores it. A runner that can't be
   * reached leaves the form open, without counting the attempt.
   */
  redeemRunnerForm(
    token: string,
    secret: string,
  ): Promise<
    | { ok: true; runner: RunnerAnswered }
    | {
        ok: false;
        reason:
          | "unknown_form"
          | "invalid_secret"
          | "secret_refused"
          | "unreachable"
          | "not_configured"
          | "store_unavailable";
      }
  >;
  /** The runner's state, from its `/health` with the stored secret. */
  describeRunner(): Promise<
    { ok: true; runner: RunnerState } | { ok: false; reason: "store_unavailable" }
  >;
}

/**
 * What the setup agent's Worker calls (Story 3.11): it opens a form, and reads the runner's state,
 * which holds no secret. It disconnects a deleted agent's bot (#303), which reads nothing back.
 * Describing, redeeming and registering stay with the admin API.
 */
export type SetupFormsContract = Pick<
  ChannelFormsContract,
  "createTelegramForm" | "createRunnerForm" | "describeRunner" | "disconnectTelegram"
>;
