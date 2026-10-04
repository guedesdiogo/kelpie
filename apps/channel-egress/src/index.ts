import { WorkerEntrypoint } from "cloudflare:workers";
import {
  type ChannelEgressContract,
  type ChannelFormsContract,
  ChannelRateLimitedError,
  type DeliveryFailure,
  type EgressDestination,
  RecipientUnavailableError,
  type SendOptions,
  type SendOutcome,
  type TypingOutcome,
} from "@kelpie/channels";
import { TelegramAdapter } from "@kelpie/channels/telegram";
import { isAgentId } from "@kelpie/config";
import { randomToken } from "./secrets/crypto.ts";
import { type ReadResult, SECRET_STORE_NAME, SecretStore } from "./secrets/secret-store.ts";
import { parseTelegramSecret, type TelegramSecret } from "./telegram-secret.ts";

export { SecretStore };

/** A bot token as BotFather issues it: the bot's id, a colon, then the secret part. */
const BOT_TOKEN = /^\d{5,12}:[A-Za-z0-9_-]{30,90}$/;
/** Telegram's own limit on one message. */
const MAX_TEXT_LENGTH = 4_096;

const store = (env: Env) => env.SECRET_STORE.getByName(SECRET_STORE_NAME);

const unavailable = { ok: false as const, reason: "store_unavailable" as const };

/**
 * The secure forms that take a channel's secrets (ADR-0013), for the admin API. Nothing here
 * returns a secret, and every answer is a value.
 */
export class ChannelForms extends WorkerEntrypoint<Env> implements ChannelFormsContract {
  async createTelegramForm(agentId: string) {
    if (!isAgentId(agentId)) return { ok: false as const, reason: "invalid_input" as const };
    try {
      return { ok: true as const, ...(await store(this.env).createForm(agentId, "telegram")) };
    } catch (error) {
      console.error("channel-egress: creating a form failed", errorName(error));
      return unavailable;
    }
  }

  async describeForm(token: string) {
    try {
      const form = await store(this.env).describeForm(token);
      return form
        ? { ok: true as const, ...form }
        : { ok: false as const, reason: "unknown_form" as const };
    } catch (error) {
      console.error("channel-egress: reading a form failed", errorName(error));
      return unavailable;
    }
  }

  /**
   * Checks the token with Telegram (`getMe`), then stores it with a new random webhook secret.
   * A refused token leaves the form open for another try, up to a few.
   */
  async redeemTelegramForm(token: string, botToken: string) {
    try {
      const forms = store(this.env);
      const form = await forms.describeForm(token);
      if (form?.kind !== "telegram") return { ok: false as const, reason: "unknown_form" as const };
      const candidate = typeof botToken === "string" ? botToken.trim() : "";
      if (!BOT_TOKEN.test(candidate)) {
        await forms.refuseValue(token);
        return { ok: false as const, reason: "invalid_token" as const };
      }
      // A closed store couldn't keep the token, so it isn't sent to Telegram either.
      if (!(await forms.ready())) return unavailable;
      let bot: { id: number; username: string };
      try {
        bot = await new TelegramAdapter({ botToken: candidate, webhookSecret: "" }).me();
      } catch (error) {
        console.warn("channel-egress: Telegram refused a token", errorName(error));
        await forms.refuseValue(token);
        return { ok: false as const, reason: "token_refused" as const };
      }
      const secret: TelegramSecret = {
        botToken: candidate,
        webhookSecret: randomToken(),
        botId: bot.id,
        username: bot.username,
      };
      const stored = await forms.redeemForm(token, JSON.stringify(secret));
      return stored.ok ? { ok: true as const, agentId: stored.agentId, bot } : stored;
    } catch (error) {
      console.error("channel-egress: redeeming a form failed", errorName(error));
      return unavailable;
    }
  }
}

/** Sends and shows typing for an agent, with that agent's channel secrets (ADR-0002). */
export class ChannelEgress extends WorkerEntrypoint<Env> implements ChannelEgressContract {
  async send(
    agentId: string,
    destination: EgressDestination,
    text: string,
    options: SendOptions = {},
  ): Promise<SendOutcome> {
    if (typeof text !== "string" || text.length > MAX_TEXT_LENGTH || !isThread(destination)) {
      return { ok: false, reason: "failed" };
    }
    const adapter = await this.#telegram(agentId, destination);
    if (!adapter) return { ok: false, reason: "not_connected" };
    try {
      const { providerMessageId } = await adapter.send(destination, text, options);
      return { ok: true, providerMessageId };
    } catch (error) {
      return failure(error);
    }
  }

  async typing(agentId: string, destination: EgressDestination): Promise<TypingOutcome> {
    if (!isThread(destination)) return { ok: false, reason: "failed" };
    const adapter = await this.#telegram(agentId, destination);
    if (!adapter) return { ok: false, reason: "not_connected" };
    try {
      await adapter.typing(destination);
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  }

  async #telegram(
    agentId: string,
    destination: EgressDestination,
  ): Promise<TelegramAdapter | null> {
    if (destination?.channel !== "telegram" || !isAgentId(agentId)) return null;
    let read: ReadResult;
    try {
      read = await store(this.env).read("telegram", agentId);
    } catch (error) {
      console.error("channel-egress: the secret store failed", errorName(error));
      return null;
    }
    if (!read.ok) {
      if (read.reason !== "missing")
        console.error("channel-egress: secret unreadable", read.reason);
      return null;
    }
    const secret = parseTelegramSecret(read.value);
    return secret
      ? new TelegramAdapter({ botToken: secret.botToken, webhookSecret: secret.webhookSecret })
      : null;
  }
}

/** A thread id is a short string; so is a reply id, when there is one. */
function isThread(destination: EgressDestination): boolean {
  const short = (value: unknown) =>
    typeof value === "string" && value.length > 0 && value.length <= 64;
  return (
    short(destination?.threadId) &&
    (destination.replyToMessageId === undefined || short(destination.replyToMessageId))
  );
}

function failure(error: unknown): DeliveryFailure {
  if (error instanceof ChannelRateLimitedError) {
    return { ok: false, reason: "rate_limited", retryAfterMs: error.retryAfterMs };
  }
  if (error instanceof RecipientUnavailableError) {
    return { ok: false, reason: "recipient_unavailable" };
  }
  console.error("channel-egress: delivery failed", errorName(error));
  return { ok: false, reason: "failed" };
}

/** Error names only: messages can quote what was sent. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export default {
  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
