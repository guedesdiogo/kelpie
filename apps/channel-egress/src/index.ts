import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { maskIdentityValue } from "@kelpie/access";
import {
  type BotPhotoRequest,
  type ChannelEgressContract,
  type ChannelFormsContract,
  ChannelRateLimitedError,
  ChannelRequestError,
  type ChannelWebhooksContract,
  type DeliveryFailure,
  type EgressDestination,
  isLocale,
  type Localized,
  RecipientUnavailableError,
  type RunnerAnswer,
  type RunnerChatContract,
  type RunnerClose,
  type RunnerToolResult,
  type RunnerTurnRequest,
  type SendOptions,
  type SendOutcome,
  type SetupFormsContract,
  type TelegramDisconnection,
  type TypingOutcome,
  type WebhookNotice,
  type WebhookRegistration,
} from "@kelpie/channels";
import { TELEGRAM_SECRET_HEADER, TelegramAdapter } from "@kelpie/channels/telegram";
import { isAgentId, type Mascot, parseMascot } from "@kelpie/config";
import { drawPhotos, type Photos } from "./photo/draw.ts";
import {
  checkedResult,
  checkRunner,
  closeSession,
  giveResult,
  isSessionId,
  parseRunnerSecret,
  RUNNER_NAME,
  RUNNER_SECRET,
  type RunnerCheck,
  runnerOf,
  startTurn,
  type TurnStart,
  turnBody,
} from "./runner.ts";
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

/**
 * The secret store's stub. Its results are typed `& Disposable`, so a spread of one has
 * `[Symbol.dispose]` in its type, which the RPC types won't return: an answer built from one names
 * its fields, or callers' types lose that branch.
 */
const store = (env: Env) => env.SECRET_STORE.getByName(SECRET_STORE_NAME);

const unavailable = { ok: false as const, reason: "store_unavailable" as const };

/** Compares two strings in constant time, through their digests. */
async function sameText(a: string, b: string): Promise<boolean> {
  const digest = (text: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const [left, right] = await Promise.all([digest(a), digest(b)]);
  return crypto.subtle.timingSafeEqual(left, right);
}

/**
 * The secure forms that take a channel's secrets (ADR-0013), for the admin API. Nothing here
 * returns a secret, and every answer is a value.
 */
/** Opens a one-time form for an agent's Telegram bot token. */
async function openTelegramForm(env: Env, agentId: string) {
  if (!isAgentId(agentId)) return { ok: false as const, reason: "invalid_input" as const };
  try {
    const { token, expiresAt } = await store(env).createForm(agentId, "telegram");
    return { ok: true as const, token, expiresAt };
  } catch (error) {
    console.error("channel-egress: creating a form failed", errorName(error));
    return unavailable;
  }
}

/** Opens a one-time form for the runner's secret (#294). Without the runner's binding, there is none to check. */
async function openRunnerForm(env: Env) {
  if (!runnerOf(env)) return { ok: false as const, reason: "not_configured" as const };
  try {
    const { token, expiresAt } = await store(env).createForm(RUNNER_NAME, "runner");
    return { ok: true as const, token, expiresAt };
  } catch (error) {
    console.error("channel-egress: creating a form failed", errorName(error));
    return unavailable;
  }
}

/** The runner's state, from its `/health` with the stored secret. Never the secret. */
async function describeRunnerOf(env: Env) {
  const runner = runnerOf(env);
  if (!runner) return { ok: true as const, runner: { state: "not_configured" as const } };
  const found = await runnerSecret(env);
  if (!found.ok) {
    return found.reason === "store_unavailable"
      ? unavailable
      : { ok: true as const, runner: { state: "not_connected" as const } };
  }
  return { ok: true as const, runner: await checkRunner(runner, found.secret) };
}

/**
 * What the configuration tools' Worker binds (Story 3.11): it opens a form, whose link the owner
 * then opens on the admin API, and reads the runner's state, which holds no secret. It also
 * disconnects a deleted agent's bot (#303), which reads nothing back. Binding `ChannelForms` there
 * would also let a model-driven Worker describe, redeem and register.
 */
export class SetupForms extends WorkerEntrypoint<Env> implements SetupFormsContract {
  async createTelegramForm(agentId: string) {
    return openTelegramForm(this.env, agentId);
  }

  async createRunnerForm() {
    return openRunnerForm(this.env);
  }

  async describeRunner() {
    return describeRunnerOf(this.env);
  }

  async disconnectTelegram(agentId: string) {
    return disconnectTelegramOf(this.env, agentId);
  }
}

export class ChannelForms extends WorkerEntrypoint<Env> implements ChannelFormsContract {
  async createTelegramForm(agentId: string) {
    return openTelegramForm(this.env, agentId);
  }

  /**
   * What a form is for while it is open; for a form used in the last few minutes, the bot it
   * connected, so a page opened again says so instead of "no longer works".
   */
  async describeForm(token: string) {
    try {
      const forms = store(this.env);
      const form = await forms.describeForm(token);
      if (form) return { ok: true as const, agentId: form.agentId, kind: form.kind };
      const used = await this.#used(token);
      return used
        ? {
            ok: false as const,
            reason: "redeemed" as const,
            agentId: used.agentId,
            username: used.secret.username,
          }
        : { ok: false as const, reason: "unknown_form" as const };
    } catch (error) {
      console.error("channel-egress: reading a form failed", errorName(error));
      return unavailable;
    }
  }

  /**
   * Checks the token with Telegram (`getMe`), stores it with a new random webhook secret, then
   * registers the webhook with that secret. A refused token leaves the form open for another try,
   * up to a few. The same token sent again to a form just used, as a double click sends it, gets
   * the same answer, and the webhook is registered again. The work finishes even when the caller
   * goes away, as a browser's second click cancels its first.
   */
  async redeemTelegramForm(token: string, botToken: string) {
    const work = this.#redeemTelegramForm(token, botToken);
    this.ctx.waitUntil(work);
    return work;
  }

  async #redeemTelegramForm(token: string, botToken: string) {
    try {
      const forms = store(this.env);
      const form = await forms.describeForm(token);
      const candidate = typeof botToken === "string" ? botToken.trim() : "";
      if (!form) return await this.#redeemAgain(token, candidate);
      if (form.kind !== "telegram") return { ok: false as const, reason: "unknown_form" as const };
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
      // Another submission of the same link claimed it meanwhile: answer as for a resubmission.
      if (!stored.ok) {
        return stored.reason === "unknown_form"
          ? await this.#redeemAgain(token, candidate)
          : stored;
      }
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

  /** A form used in the last few minutes, with the secret it stored. */
  async #used(token: string): Promise<{ agentId: string; secret: TelegramSecret } | null> {
    const used = await store(this.env).redeemedForm(token);
    if (used?.kind !== "telegram") return null;
    const found = await telegramSecret(this.env, used.agentId);
    if (found.ok) return { agentId: used.agentId, secret: found.secret };
    // The callers answer an unreachable store as such, not as a closed link.
    if (found.reason === "store_unavailable") throw new Error("The secret store is unavailable");
    return null;
  }

  /** The answer for a form just used, when its own token comes again; any other value is refused. */
  async #redeemAgain(token: string, candidate: string) {
    const used = await this.#used(token);
    if (!used || !(await sameText(used.secret.botToken, candidate))) {
      return { ok: false as const, reason: "unknown_form" as const };
    }
    const webhook = await this.#register(used.agentId, used.secret);
    return {
      ok: true as const,
      agentId: used.agentId,
      bot: { id: used.secret.botId, username: used.secret.username },
      webhook: webhook.ok ? ("registered" as const) : webhook.reason,
    };
  }

  async createRunnerForm() {
    return openRunnerForm(this.env);
  }

  /**
   * Checks the secret with the runner's `/health`, then stores it, as a bot token is checked with
   * `getMe`. A refused secret counts against the form; a runner that can't answer doesn't, since the
   * fault is elsewhere. The same secret sent again, as a double click sends it, gets the same answer.
   */
  async redeemRunnerForm(token: string, secret: string) {
    const work = this.#redeemRunnerForm(token, secret);
    this.ctx.waitUntil(work);
    return work;
  }

  async #redeemRunnerForm(token: string, secret: string) {
    try {
      const runner = runnerOf(this.env);
      if (!runner) return { ok: false as const, reason: "not_configured" as const };
      const forms = store(this.env);
      const form = await forms.describeForm(token);
      const candidate = typeof secret === "string" ? secret.trim() : "";
      if (!form) return await this.#redeemRunnerAgain(token, candidate, runner);
      if (form.kind !== "runner") return { ok: false as const, reason: "unknown_form" as const };
      if (!RUNNER_SECRET.test(candidate)) {
        await forms.refuseValue(token);
        return { ok: false as const, reason: "invalid_secret" as const };
      }
      // A closed store couldn't keep the secret, so it isn't sent to the runner either.
      if (!(await forms.ready())) return unavailable;
      const check = await checkRunner(runner, candidate);
      if (!answered(check)) {
        if (check.state === "unreachable") {
          return { ok: false as const, reason: "unreachable" as const };
        }
        await forms.refuseValue(token);
        return { ok: false as const, reason: "secret_refused" as const };
      }
      const stored = await forms.redeemForm(token, JSON.stringify({ secret: candidate }));
      // Another submission of the same link claimed it meanwhile: answer as for a resubmission.
      if (!stored.ok) {
        return stored.reason === "unknown_form"
          ? await this.#redeemRunnerAgain(token, candidate, runner)
          : stored;
      }
      return { ok: true as const, runner: check };
    } catch (error) {
      console.error("channel-egress: redeeming a form failed", errorName(error));
      return unavailable;
    }
  }

  /** The answer for a runner form just used, when its own secret comes again. */
  async #redeemRunnerAgain(token: string, candidate: string, runner: Fetcher) {
    const used = await store(this.env).redeemedForm(token);
    const found = used?.kind === "runner" ? await runnerSecret(this.env) : null;
    // The caller answers an unreachable store as such, not as a closed link, as for Telegram.
    if (found?.ok === false && found.reason === "store_unavailable") {
      throw new Error("The secret store is unavailable");
    }
    if (!found?.ok || !(await sameText(found.secret, candidate))) {
      return { ok: false as const, reason: "unknown_form" as const };
    }
    const check = await checkRunner(runner, candidate);
    return answered(check)
      ? { ok: true as const, runner: check }
      : {
          ok: false as const,
          reason:
            check.state === "refused" ? ("secret_refused" as const) : ("unreachable" as const),
        };
  }

  async describeRunner() {
    return describeRunnerOf(this.env);
  }

  async disconnectTelegram(agentId: string) {
    return disconnectTelegramOf(this.env, agentId);
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

const invalidInput = { ok: false as const, reason: "invalid_input" as const };

/**
 * The `claude-code` route's way to the runner (#295, #420), which llm-gateway binds: a turn, a
 * tool's result and a close, each sent with the stored secret, which never leaves this Worker. A
 * separate entrypoint, so that Worker can't open forms or read a secret. Each input is checked
 * again, since this is an RPC boundary, and each answer is a value.
 */
export class RunnerChat extends WorkerEntrypoint<Env> implements RunnerChatContract {
  async turn(sessionId: string, request: RunnerTurnRequest): Promise<TurnStart> {
    const body = turnBody(sessionId, request);
    if (!body) return invalidInput;
    const found = await this.#runner();
    return found.ok ? startTurn(found.runner, found.secret, sessionId, body) : found;
  }

  async answer(sessionId: string, result: RunnerToolResult): Promise<RunnerAnswer> {
    const checked = checkedResult(sessionId, result);
    if (!checked) return invalidInput;
    const found = await this.#runner();
    return found.ok ? giveResult(found.runner, found.secret, sessionId, checked) : found;
  }

  async close(sessionId: string): Promise<RunnerClose> {
    if (!isSessionId(sessionId)) return invalidInput;
    const found = await this.#runner();
    return found.ok ? closeSession(found.runner, found.secret, sessionId) : found;
  }

  /** The runner's binding and its stored secret. */
  async #runner() {
    const runner = runnerOf(this.env);
    if (!runner) return { ok: false as const, reason: "not_configured" as const };
    const found = await runnerSecret(this.env);
    return found.ok ? { ok: true as const, runner, secret: found.secret } : found;
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

/** The notices' texts (#187). */
const NOTICES: Localized<{ paired: string; stranger: (who: string) => string }> = {
  en: {
    paired: "Paired. This Telegram account can now talk to this agent.",
    stranger: (who) => `Someone who isn't paired messaged this bot: ${who}. They got no answer.`,
  },
  "pt-BR": {
    paired: "Pareado. Esta conta do Telegram já pode falar com este agente.",
    stranger: (who) =>
      `Alguém que não está pareado mandou uma mensagem para este bot: ${who}. Não recebeu resposta.`,
  },
  es: {
    paired: "Vinculado. Esta cuenta de Telegram ya puede hablar con este agente.",
    stranger: (who) =>
      `Alguien que no está vinculado escribió a este bot: ${who}. No recibió respuesta.`,
  },
};

/**
 * The text of a notice, in its locale or English, or null for one that isn't known or well
 * formed.
 */
function noticeText(notice: WebhookNotice): string | null {
  const texts = NOTICES[isLocale(notice?.locale) ? notice.locale : "en"];
  if (notice?.kind === "paired") return texts.paired;
  if (notice?.kind !== "stranger" || !TELEGRAM_USER_ID.test(String(notice.senderId))) return null;
  const name = displayName(notice.displayName);
  const who = name
    ? `${name} (${maskIdentityValue(notice.senderId)})`
    : maskIdentityValue(notice.senderId);
  return texts.stranger(who);
}

/**
 * A stranger's name, kept to letters, digits, spaces, apostrophes and hyphens, then cut short.
 * Everything else becomes a space, so the name can't break the line, ping anyone, or read as a
 * link, an address or a command, which Telegram would make tappable (`evil.example`, `t.me/x`,
 * `/start`).
 */
function displayName(value: unknown): string {
  if (typeof value !== "string") return "";
  const cleaned = value
    .normalize("NFKC")
    .replace(/[^\p{L}\p{M}\p{N}' -]/gu, " ")
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

  /**
   * Has the agent's bot show `mascot` as its photo (ADR-0046). Its `BotPhoto` draws and sends it
   * soon after; an agent without a bot gets nothing.
   */
  async updateBotPhoto(agentId: string, mascot: unknown): Promise<BotPhotoRequest> {
    const parsed = parseMascot(mascot);
    if (!isAgentId(agentId) || !parsed) return { ok: false, reason: "invalid_input" };
    const found = await telegramSecret(this.env, agentId);
    if (!found.ok) return { ok: false, reason: found.reason };
    try {
      await this.env.BOT_PHOTO.getByName(agentId).request(agentId, parsed);
      return { ok: true };
    } catch (error) {
      console.error("channel-egress: a bot's photo wasn't asked for", errorName(error));
      return unavailable;
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

/** How long a bot's photo waits, so a mascot changed several times in a row is drawn once. */
const PHOTO_DELAY_MS = 5_000;
/** A new mascot is drawn this long after the last drawing began, at the soonest. */
const PHOTO_SPACING_MS = 5 * 60_000;
/** Tries for one mascot before it is given up. A try after a failed send reuses what was drawn. */
const PHOTO_TRIES = 5;
/** The least a 429 waits: one without `retry_after` reads as 1 s. */
const MIN_RATE_LIMIT_MS = 30_000;

/** The mascot a `BotPhoto` is to show next. */
interface WantedPhoto {
  agentId: string;
  mascot: Mascot;
}

/** Photos drawn and not sent yet, for the bot and mascot `shown` names: about 0.6 MB. */
interface DrawnPhotos extends Photos {
  shown: string;
}

/**
 * Puts the agent's mascot on its Telegram bot, as its profile photo (ADR-0046): one per agent. It
 * keeps the newest mascot asked for, and its alarm draws and sends it, since drawing takes longer
 * than a request may wait. A mascot already on that bot isn't sent again. Browser Run's cost has a
 * ceiling: a new mascot is drawn 5 min after the last drawing began at the soonest, photos drawn
 * are kept until sent so a failed send isn't drawn again, and a mascot gets 5 tries at most. A
 * failure is thrown, so the runtime runs the alarm again, a little later each time.
 */
export class BotPhoto extends DurableObject<Env> {
  /** Keeps `mascot` as the one to show. A mascot changed again within a few seconds is drawn once. */
  async request(agentId: string, mascot: Mascot): Promise<void> {
    await this.ctx.storage.put<WantedPhoto>("wanted", { agentId, mascot });
    await this.ctx.storage.delete("tries");
    if ((await this.ctx.storage.getAlarm()) === null) {
      const drawnAt = (await this.ctx.storage.get<number>("drawnAt")) ?? 0;
      await this.ctx.storage.setAlarm(
        Math.max(Date.now() + PHOTO_DELAY_MS, drawnAt + PHOTO_SPACING_MS),
      );
    }
  }

  override async alarm(): Promise<void> {
    const wanted = await this.ctx.storage.get<WantedPhoto>("wanted");
    if (!wanted) return;
    const tries = ((await this.ctx.storage.get<number>("tries")) ?? 0) + 1;
    await this.ctx.storage.put("tries", tries);
    try {
      const found = await telegramSecret(this.env, wanted.agentId);
      if (!found.ok && found.reason === "store_unavailable") {
        throw new Error("The secret store is unavailable");
      }
      // A bot disconnected meanwhile needs no photo.
      if (found.ok) {
        const shown = `${found.secret.botId}:${JSON.stringify(wanted.mascot)}`;
        if (shown !== (await this.ctx.storage.get<string>("shown"))) {
          let drawn = await this.ctx.storage.get<DrawnPhotos>("drawn");
          if (drawn?.shown !== shown) {
            await this.ctx.storage.put("drawnAt", Date.now());
            drawn = { shown, ...(await drawPhotos(this.env.BROWSER, wanted.mascot)) };
            // Kept for a retry only: a photo storage can't hold is still sent now.
            await this.ctx.storage.put("drawn", drawn).catch((error) => {
              console.warn("channel-egress: a bot's photo wasn't kept", errorName(error));
            });
          }
          await sendPhoto(new TelegramAdapter(found.secret), drawn);
          await this.ctx.storage.put("shown", shown);
        }
      }
    } catch (error) {
      const last = tries >= PHOTO_TRIES;
      if (error instanceof ChannelRateLimitedError && !last) {
        await this.ctx.storage.setAlarm(
          Date.now() + Math.max(error.retryAfterMs, MIN_RATE_LIMIT_MS),
        );
        return;
      }
      if (!last && !refusedForGood(error)) {
        console.warn("channel-egress: a bot's photo failed, for now", errorName(error));
        throw error;
      }
      console.warn("channel-egress: a bot's photo was given up", errorName(error));
    }
    await this.ctx.storage.delete("drawn");
    // A newer mascot asked for while this one was drawn keeps its turn: `request` set the alarm.
    const latest = await this.ctx.storage.get<WantedPhoto>("wanted");
    if (JSON.stringify(latest) === JSON.stringify(wanted)) {
      await this.ctx.storage.delete(["wanted", "tries"]);
    }
  }
}

/**
 * Sends the loop, or the still when there is no loop or Telegram refuses it (400) or finds it too
 * large (413): the Bot API doesn't say which MP4s it takes, and MediaRecorder writes a fragmented
 * one (#368).
 */
async function sendPhoto(bot: TelegramAdapter, photos: Photos): Promise<void> {
  if (photos.loop) {
    try {
      await bot.setProfilePhoto({ type: "animated", mp4: photos.loop });
      return;
    } catch (error) {
      const refused =
        error instanceof ChannelRequestError && [400, 413].includes(error.status ?? 0);
      if (!refused) throw error;
      console.warn("channel-egress: Telegram refused the bot's loop; sending its still");
    }
  }
  await bot.setProfilePhoto({ type: "static", jpg: photos.still });
}

/** The agent's stored bot. A secret that doesn't decrypt or parse counts as no bot. */
/**
 * Removes a deleted agent's bot (#303): its webhook first, while the token is there to do it, then
 * the secret and forms. A webhook Telegram refuses to remove for good, as with a revoked token,
 * doesn't keep the secret: without it ingress refuses every update for the agent. A failure for
 * now keeps it, so the deletion's next run removes the webhook.
 */
async function disconnectTelegramOf(env: Env, agentId: string): Promise<TelegramDisconnection> {
  if (!isAgentId(agentId)) return { ok: false, reason: "invalid_input" };
  const found = await telegramSecret(env, agentId);
  if (!found.ok && found.reason === "store_unavailable") return unavailable;
  let webhook: "removed" | "refused" | "none" = "none";
  if (found.ok) {
    try {
      await new TelegramAdapter(found.secret).deleteWebhook();
      webhook = "removed";
    } catch (error) {
      if (!refusedForGood(error)) {
        console.warn("channel-egress: Telegram didn't remove a webhook, for now", errorName(error));
        return { ok: false, reason: "channel_unavailable" };
      }
      console.warn("channel-egress: Telegram refused to remove a webhook", errorName(error));
      webhook = "refused";
    }
  }
  try {
    await store(env).remove("telegram", agentId);
  } catch (error) {
    console.error("channel-egress: the secret store failed", errorName(error));
    return unavailable;
  }
  return { ok: true, webhook };
}

/**
 * A refusal that asking again won't change: the bot's token revoked, or the bot gone (4xx). A 429
 * comes as a `ChannelRateLimitedError`, a failure for now.
 */
function refusedForGood(error: unknown): boolean {
  if (error instanceof RecipientUnavailableError) return true;
  return (
    error instanceof ChannelRequestError &&
    error.status !== null &&
    error.status >= 400 &&
    error.status < 500
  );
}

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

/** The runner's stored secret. A value that doesn't decrypt or parse counts as none. */
async function runnerSecret(
  env: Env,
): Promise<
  { ok: true; secret: string } | { ok: false; reason: "not_connected" | "store_unavailable" }
> {
  let read: ReadResult;
  try {
    read = await store(env).read("runner", RUNNER_NAME);
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
  const secret = parseRunnerSecret(read.value);
  return secret ? { ok: true, secret } : { ok: false, reason: "not_connected" };
}

function answered(check: RunnerCheck): check is Extract<RunnerCheck, { version: string }> {
  return check.state === "ready" || check.state === "outdated";
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
