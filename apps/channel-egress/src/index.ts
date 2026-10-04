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
import { SECRET_STORE_NAME, SecretStore } from "./secrets/secret-store.ts";
import { parseTelegramSecret, type TelegramSecret } from "./telegram-secret.ts";

export { SecretStore };

/** A bot token as BotFather issues it: the bot's id, a colon, then the secret part. */
const BOT_TOKEN = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;

const store = (env: Env) => env.SECRET_STORE.getByName(SECRET_STORE_NAME);

/**
 * The secure forms that take a channel's secrets (ADR-0013), for the admin API. Nothing here
 * returns a secret.
 */
export class ChannelForms extends WorkerEntrypoint<Env> implements ChannelFormsContract {
  async createTelegramForm(agentId: string) {
    if (!isAgentId(agentId)) return { ok: false as const, reason: "invalid_input" as const };
    return { ok: true as const, ...(await store(this.env).createForm(agentId, "telegram")) };
  }

  async describeForm(token: string) {
    const form = typeof token === "string" ? await store(this.env).describeForm(token) : null;
    return form
      ? { ok: true as const, ...form }
      : { ok: false as const, reason: "unknown_form" as const };
  }

  /**
   * Checks the token with Telegram (`getMe`), then stores it with a new random webhook secret.
   * A refused token leaves the form open, so the owner can paste the right one.
   */
  async redeemTelegramForm(token: string, botToken: string) {
    if (typeof botToken !== "string" || !BOT_TOKEN.test(botToken.trim())) {
      return { ok: false as const, reason: "invalid_token" as const };
    }
    const form = await this.describeForm(token);
    if (!form.ok || form.kind !== "telegram") {
      return { ok: false as const, reason: "unknown_form" as const };
    }
    let bot: { id: number; username: string };
    try {
      bot = await new TelegramAdapter({ botToken: botToken.trim(), webhookSecret: "" }).me();
    } catch (error) {
      console.warn("channel-egress: Telegram refused a token", errorName(error));
      return { ok: false as const, reason: "token_refused" as const };
    }
    const secret: TelegramSecret = {
      botToken: botToken.trim(),
      webhookSecret: randomToken(),
      botId: bot.id,
      username: bot.username,
    };
    const stored = await store(this.env).redeemForm(token, JSON.stringify(secret));
    return stored.ok ? { ok: true as const, agentId: stored.agentId, bot } : stored;
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
    const read = await store(this.env).read("telegram", agentId);
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

function failure(error: unknown): DeliveryFailure {
  if (error instanceof ChannelRateLimitedError) {
    return { ok: false, reason: "rate_limited", retryAfterMs: error.retryAfterMs };
  }
  if (error instanceof RecipientUnavailableError)
    return { ok: false, reason: "recipient_unavailable" };
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
