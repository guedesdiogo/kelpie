import { WorkerEntrypoint } from "cloudflare:workers";
import { maskIdentityValue } from "@kelpie/access";
import {
  type ChannelEgressContract,
  type ChannelFormsContract,
  ChannelRateLimitedError,
  type ChannelWebhooksContract,
  type DeliveryFailure,
  type EgressDestination,
  RecipientUnavailableError,
  type SendOptions,
  type SendOutcome,
  type TypingOutcome,
  type WebhookNotice,
  type WebhookRegistration,
} from "@kelpie/channels";
import { TELEGRAM_SECRET_HEADER, TelegramAdapter } from "@kelpie/channels/telegram";
import { isAgentId } from "@kelpie/config";
import { randomToken } from "./secrets/crypto.ts";
import { type ReadResult, SECRET_STORE_NAME, SecretStore } from "./secrets/secret-store.ts";
import { parseTelegramSecret, type TelegramSecret, telegramWebhookUrl } from "./telegram-secret.ts";

export { SecretStore };

/** A bot token as BotFather issues it: the bot's id, a colon, then the secret part. */
const BOT_TOKEN = /^\d{5,12}:[A-Za-z0-9_-]{30,90}$/;
/** Telegram's own limit on one message. */
const MAX_TEXT_LENGTH = 4_096;
/** A Telegram user id: digits, a few more than today's ten. */
const TELEGRAM_USER_ID = /^\d{1,20}$/;
/** A stranger's display name, as the owner sees it in a notice. */
const MAX_DISPLAY_NAME_LENGTH = 64;

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
   * Checks the token with Telegram (`getMe`), stores it with a new random webhook secret, then
   * registers the webhook with that secret. A refused token leaves the form open for another try,
   * up to a few.
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
      if (!stored.ok) return stored;
      // A new secret makes every update refused until Telegram has it, so it registers now.
      const webhook = await this.#register(stored.agentId, secret);
      return {
        ok: true as const,
        agentId: stored.agentId,
        bot,
        webhook: webhook.ok ? ("registered" as const) : webhook.reason,
      };
    } catch (error) {
      console.error("channel-egress: redeeming a form failed", errorName(error));
      return unavailable;
    }
  }

  async describeTelegramBot(agentId: string) {
    if (!isAgentId(agentId)) return { ok: false as const, reason: "invalid_input" as const };
    const found = await telegramSecret(this.env, agentId);
    return found.ok ? { ok: true as const, username: found.secret.username } : found;
  }

  async registerTelegramWebhook(agentId: string): Promise<WebhookRegistration> {
    if (!isAgentId(agentId)) return { ok: false, reason: "invalid_input" };
    const found = await telegramSecret(this.env, agentId);
    return found.ok ? this.#register(agentId, found.secret) : found;
  }

  async #register(agentId: string, secret: TelegramSecret): Promise<WebhookRegistration> {
    const url = telegramWebhookUrl(this.env.INGRESS_ORIGIN, agentId);
    if (!url) return { ok: false, reason: "not_configured" };
    try {
      await new TelegramAdapter(secret).setWebhook(url);
      return { ok: true };
    } catch (error) {
      console.warn("channel-egress: Telegram refused a webhook", errorName(error));
      return { ok: false, reason: "channel_refused" };
    }
  }
}

/**
 * Checks webhooks for ingress, and sends its fixed notices. A separate entrypoint, so the Worker
 * that takes public requests can't send text of its own: only the two notices written here.
 */
export class ChannelWebhooks extends WorkerEntrypoint<Env> implements ChannelWebhooksContract {
  async verifyTelegram(agentId: string, presentedSecret: string | null) {
    const refused = { ok: false as const, reason: "refused" as const };
    if (!isAgentId(agentId) || typeof presentedSecret !== "string") return refused;
    const found = await telegramSecret(this.env, agentId);
    if (!found.ok) return found.reason === "store_unavailable" ? unavailable : refused;
    const verified = await new TelegramAdapter(found.secret).verify({
      headers: { [TELEGRAM_SECRET_HEADER]: presentedSecret },
      body: "",
    });
    return verified ? { ok: true as const } : refused;
  }

  async notice(
    agentId: string,
    destination: EgressDestination,
    notice: WebhookNotice,
  ): Promise<TypingOutcome> {
    const text = noticeText(notice);
    if (text === null || destination?.channel !== "telegram" || !isThread(destination)) {
      return { ok: false, reason: "failed" };
    }
    if (!isAgentId(agentId)) return { ok: false, reason: "not_connected" };
    const found = await telegramSecret(this.env, agentId);
    if (!found.ok) return { ok: false, reason: "not_connected" };
    try {
      await new TelegramAdapter(found.secret).send(destination, text);
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  }
}

/** The text of a notice, or null for one that isn't known or well formed. */
function noticeText(notice: WebhookNotice): string | null {
  if (notice?.kind === "paired") {
    return "Paired. This Telegram account can now talk to this agent.";
  }
  if (notice?.kind !== "stranger" || !TELEGRAM_USER_ID.test(String(notice.senderId))) return null;
  const name = displayName(notice.displayName);
  const who = name
    ? `${name} (${maskIdentityValue(notice.senderId)})`
    : maskIdentityValue(notice.senderId);
  return `Someone who isn't paired messaged this bot: ${who}. They got no answer.`;
}

/**
 * A stranger's name, as Hermes shows it: control and format characters (bidi overrides included)
 * and mention, link and markup sigils removed, then cut short. It can't break the line, ping
 * anyone or look like a link.
 */
function displayName(value: unknown): string {
  if (typeof value !== "string") return "";
  const cleaned = value
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/[@<>[\]()`*_~#]/g, "")
    .replace(/https?:\/\/\S*/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return [...cleaned].slice(0, MAX_DISPLAY_NAME_LENGTH).join("").trim();
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
    const found = await telegramSecret(this.env, agentId);
    return found.ok ? new TelegramAdapter(found.secret) : null;
  }
}

/** The agent's stored bot. A secret that doesn't decrypt or parse counts as no bot. */
async function telegramSecret(
  env: Env,
  agentId: string,
): Promise<
  | { ok: true; secret: TelegramSecret }
  | { ok: false; reason: "not_connected" | "store_unavailable" }
> {
  let read: ReadResult;
  try {
    read = await store(env).read("telegram", agentId);
  } catch (error) {
    console.error("channel-egress: the secret store failed", errorName(error));
    return unavailable;
  }
  if (!read.ok) {
    if (read.reason !== "missing") console.error("channel-egress: secret unreadable", read.reason);
    return read.reason === "store_unavailable"
      ? unavailable
      : { ok: false, reason: "not_connected" };
  }
  const secret = parseTelegramSecret(read.value);
  return secret ? { ok: true, secret } : { ok: false, reason: "not_connected" };
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
