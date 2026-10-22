import {
  type ChannelAdapter,
  ChannelRateLimitedError,
  ChannelRequestError,
  type Destination,
  type InboundWebhook,
  type InlineKeyboard,
  InvalidWebhookError,
  RecipientUnavailableError,
  type SendOptions,
  type SendResult,
} from "./adapter.ts";
import { CAPABILITIES } from "./capabilities.ts";
import type { CanonicalEvent, CanonicalPress, MessagePart } from "./events.ts";
import { MAX_LANGUAGE_TAG_CHARS } from "./locale.ts";
import { fitsTelegram, formatReply, toTelegramHtml, toTelegramPlain } from "./markdown.ts";

// Telegram through the Bot API (https://core.telegram.org/bots/api), webhooks only (ADR-0003).

export interface TelegramConfig {
  /** The bot's token from BotFather. It goes in the request path, so no error or log carries a URL. */
  botToken: string;
  /**
   * The `secret_token` given to `setWebhook`, one per bot: 1 to 256 characters of `A-Z`, `a-z`,
   * `0-9`, `_` and `-`. Telegram sends it back in every webhook.
   */
  webhookSecret: string;
  fetch?: typeof fetch;
}

const API = "https://api.telegram.org";
/** The header Telegram echoes the webhook secret in. Ingress lower-cases header names. */
export const TELEGRAM_SECRET_HEADER = "x-telegram-bot-api-secret-token";
/** Where ingress takes a bot's updates: this path, then the agent's id. */
export const TELEGRAM_WEBHOOK_PATH = "/webhooks/telegram";
/** Telegram's service account, the sender of posts a linked channel relays into a group. */
const TELEGRAM_SERVICE_ACCOUNT = 777_000;
const CHAT_TYPES: readonly string[] = ["private", "group", "supergroup", "channel"];
/** The longest data Telegram takes on a button, in bytes. */
export const MAX_BUTTON_DATA_BYTES = 64;
/** The updates the bot's webhook takes: new messages, and taps on its notices' buttons. */
const WEBHOOK_UPDATES = ["message", "callback_query"];

interface TelegramFile {
  file_id: string;
  mime_type?: string;
}

interface TelegramMessage {
  message_id: number;
  from?: { id: number; is_bot: boolean; first_name?: string; language_code?: string };
  chat: { id: number; type: "private" | "group" | "supergroup" | "channel" };
  /** Unix time, in seconds. */
  date: number;
  text?: string;
  caption?: string;
  /** The same photo in several sizes, smallest first. */
  photo?: TelegramFile[];
  document?: TelegramFile;
  voice?: TelegramFile;
  audio?: TelegramFile;
  video?: TelegramFile;
  reply_to_message?: { message_id: number };
  /** Set on a post a linked channel relayed into its discussion group. */
  is_automatic_forward?: boolean;
}

/** A bot's profile photo: a still JPG, or a looping MPEG4. */
export type ProfilePhoto =
  | { type: "static"; jpg: Uint8Array<ArrayBuffer> }
  | { type: "animated"; mp4: Uint8Array<ArrayBuffer> };

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export class TelegramAdapter implements ChannelAdapter {
  readonly id = "telegram";
  readonly capabilities = CAPABILITIES.telegram;
  readonly #config: TelegramConfig;
  readonly #fetch: typeof fetch;

  constructor(config: TelegramConfig) {
    this.#config = config;
    // Called through a wrapper: Workers' fetch throws "Illegal invocation" when `this` isn't global.
    this.#fetch = config.fetch ?? ((input, init) => fetch(input, init));
  }

  /** The secret Telegram echoes, compared in constant time. A missing or empty one never matches. */
  async verify(webhook: InboundWebhook): Promise<boolean> {
    const presented = webhook.headers[TELEGRAM_SECRET_HEADER];
    const expected = this.#config.webhookSecret;
    if (!presented || !expected) return false;
    return constantTimeEqual(presented, expected);
  }

  /** See `normalizeTelegramUpdate`. */
  normalize(webhook: InboundWebhook, agentId: string): CanonicalEvent[] {
    return normalizeTelegramUpdate(webhook, agentId);
  }

  /** The bot behind the token (`getMe`): proof the token works, and the username for links. */
  async me(): Promise<{ id: number; username: string }> {
    const bot = await this.#call<{ id: number; username?: string }>("getMe", {});
    if (typeof bot.id !== "number" || typeof bot.username !== "string") {
      throw new ChannelRequestError("getMe", null);
    }
    return { id: bot.id, username: bot.username };
  }

  async send(
    destination: Destination,
    text: string,
    options: SendOptions = {},
  ): Promise<SendResult> {
    // A reply is formatted (#188). A notice goes as typed, and so does a reply Telegram can't read,
    // but with every address in code: a notice can quote what the model wrote, and Telegram would
    // make it tappable.
    const html =
      options.links === undefined
        ? null
        : toTelegramHtml(formatReply(text, new Set(options.links)));
    // A reply with more formatting than Telegram reads goes plainer, so no code span is dropped.
    const formatted = html !== null && fitsTelegram(html) ? html : null;
    const sendAs = (html: string) =>
      this.#call<{ message_id: number }>("sendMessage", {
        chat_id: destination.threadId,
        text: html,
        parse_mode: "HTML",
        disable_notification: options.silent === true,
        // Checked against the text as written: formatting escapes the `&` in a link.
        link_preview_options: linkPreview(text, options.previewUrl),
        ...replyParameters(destination.replyToMessageId),
        ...(options.buttons === undefined || options.buttons.length === 0
          ? {}
          : { reply_markup: keyboard(options.buttons) }),
      });
    let result: { message_id: number };
    try {
      result = await sendAs(formatted ?? toTelegramPlain(text));
    } catch (error) {
      if (formatted === null || !(error instanceof ChannelRequestError) || error.status !== 400) {
        throw error;
      }
      result = await sendAs(toTelegramPlain(text));
    }
    return { providerMessageId: String(result.message_id) };
  }

  /**
   * Replaces a notice's text, sent as typed, and its buttons; without `buttons` it keeps none
   * (ADR-0067 §3). Only the bot's own messages can be edited.
   */
  async edit(
    destination: Destination,
    providerMessageId: string,
    text: string,
    options: { buttons?: InlineKeyboard } = {},
  ): Promise<void> {
    await this.#call("editMessageText", {
      chat_id: destination.threadId,
      message_id: Number(providerMessageId),
      text: toTelegramPlain(text),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: keyboard(options.buttons ?? []),
    });
  }

  /** Answers a tap, so Telegram stops its spinner; `text` shows briefly at the top of the chat. */
  async answer(pressId: string, text?: string): Promise<void> {
    await this.#call("answerCallbackQuery", {
      callback_query_id: pressId,
      ...(text === undefined ? {} : { text }),
    });
  }

  /**
   * Where the bot's webhook points, empty when it has none, and whether it takes taps. A webhook
   * set before taps existed takes messages only.
   */
  async webhookInfo(): Promise<{ url: string; takesPresses: boolean }> {
    const info = await this.#call<{ url?: unknown; allowed_updates?: unknown }>(
      "getWebhookInfo",
      {},
    );
    const updates = info.allowed_updates;
    if (
      typeof info.url !== "string" ||
      !isOptional(updates, (list) => Array.isArray(list) && list.every(isString))
    ) {
      throw new ChannelRequestError("getWebhookInfo", null);
    }
    // Without a list, Telegram sends every kind of update but a few, taps among them.
    return {
      url: info.url,
      takesPresses: updates === undefined || (updates as string[]).includes("callback_query"),
    };
  }

  async typing(destination: Destination): Promise<void> {
    await this.#call("sendChatAction", { chat_id: destination.threadId, action: "typing" });
  }

  /**
   * Points the bot's updates at `url`, with this bot's secret to echo back. Only new messages and
   * taps on buttons are asked for, because edits and the rest yield no event. Registering again
   * replaces the last one.
   */
  async setWebhook(url: string): Promise<void> {
    await this.#call("setWebhook", {
      url,
      secret_token: this.#config.webhookSecret,
      allowed_updates: WEBHOOK_UPDATES,
    });
  }

  /** Stops the bot's updates, and drops the ones still waiting, when its agent is deleted (#303). */
  async deleteWebhook(): Promise<void> {
    await this.#call("deleteWebhook", { drop_pending_updates: true });
  }

  /**
   * Sets the bot's own profile photo (`setMyProfilePhoto`), the agent's mascot (ADR-0046). Telegram
   * reuses no photo, so each one goes up as a new file. A loop's still is its first frame.
   */
  async setProfilePhoto(photo: ProfilePhoto): Promise<void> {
    const form = new FormData();
    if (photo.type === "static") {
      form.set("photo", JSON.stringify({ type: "static", photo: "attach://file" }));
      form.set("file", new Blob([photo.jpg], { type: "image/jpeg" }), "mascot.jpg");
    } else {
      form.set(
        "photo",
        JSON.stringify({ type: "animated", animation: "attach://file", main_frame_timestamp: 0 }),
      );
      form.set("file", new Blob([photo.mp4], { type: "video/mp4" }), "mascot.mp4");
    }
    await this.#call("setMyProfilePhoto", form);
  }

  async #call<T>(method: string, body: Record<string, unknown> | FormData): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetch(`${API}/bot${this.#config.botToken}/${method}`, {
        method: "POST",
        // A form sets its own multipart type, with the boundary.
        ...(body instanceof FormData
          ? { body }
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        // The token is in the path; a redirect would carry it elsewhere. Workers' fetch only takes
        // "follow" or "manual", so a redirect comes back as an answer and fails below.
        redirect: "manual",
      });
    } catch {
      // The runtime's error can quote the URL, and with it the token.
      throw new ChannelRequestError(method, null);
    }
    const payload = (await response.json().catch(() => null)) as TelegramResponse<T> | null;
    if (response.ok && payload?.ok) {
      if (payload.result != null) return payload.result;
      throw new ChannelRequestError(method, null);
    }
    const status = typeof payload?.error_code === "number" ? payload.error_code : response.status;
    if (status === 429) {
      const seconds = payload?.parameters?.retry_after;
      const wait =
        typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds : 1;
      throw new ChannelRateLimitedError(wait * 1_000);
    }
    if (status === 403) throw new RecipientUnavailableError(`${method} was refused with 403`);
    throw new ChannelRequestError(method, status);
  }
}

/**
 * A new message from a person becomes one event. Edits, channel posts and the posts a linked
 * channel relays, membership changes, messages from bots and message kinds Kelpie doesn't handle
 * yet (stickers, locations) yield none. A field of the wrong type refuses the whole update. It needs
 * no token, so ingress can normalize before anything else knows the bot.
 */
export function normalizeTelegramUpdate(
  webhook: InboundWebhook,
  agentId: string,
): CanonicalEvent[] {
  let update: { message?: unknown };
  try {
    update = JSON.parse(webhook.body);
  } catch {
    throw new InvalidWebhookError("The update isn't JSON");
  }
  if (typeof update !== "object" || update === null) {
    throw new InvalidWebhookError("The update isn't an object");
  }
  if (update.message === undefined) return [];
  const message = update.message as TelegramMessage;
  if (!isWellFormed(message)) {
    throw new InvalidWebhookError("The message has missing fields or fields of the wrong type");
  }
  if (!message.from || message.from.is_bot) return [];
  if (message.from.id === TELEGRAM_SERVICE_ACCOUNT || message.is_automatic_forward) return [];
  if (message.chat.type === "channel") return [];
  const parts = partsOf(message);
  if (parts.length === 0) return [];

  const event: CanonicalEvent = {
    agentId,
    channel: "telegram",
    threadId: String(message.chat.id),
    chatType: message.chat.type === "private" ? "direct" : "group",
    sender: { channelUserId: String(message.from.id) },
    providerMessageId: String(message.message_id),
    providerTimestamp: message.date * 1_000,
    parts,
  };
  if (message.from.first_name) event.sender.displayName = message.from.first_name;
  // Optional in Telegram's API, so a message without it is just as well formed.
  const language = message.from.language_code;
  if (typeof language === "string" && language.length <= MAX_LANGUAGE_TAG_CHARS) {
    event.sender.languageCode = language;
  }
  if (message.reply_to_message) {
    event.replyTo = { providerMessageId: String(message.reply_to_message.message_id) };
  }
  return [event];
}

/**
 * A tap on a button under one of the bot's messages (`callback_query`) becomes a press
 * (ADR-0067 §3). A tap from a bot, in a channel, on a message sent in inline mode, which names no
 * chat, or on a button without data yields none. A field of the wrong type, or data longer than
 * Telegram allows, refuses the whole update. Like `normalizeTelegramUpdate`, it needs no token.
 */
export function normalizeTelegramPress(
  webhook: InboundWebhook,
  agentId: string,
): CanonicalPress | null {
  let update: { callback_query?: unknown };
  try {
    update = JSON.parse(webhook.body);
  } catch {
    throw new InvalidWebhookError("The update isn't JSON");
  }
  if (typeof update !== "object" || update === null) {
    throw new InvalidWebhookError("The update isn't an object");
  }
  const query = update.callback_query;
  if (query === undefined) return null;
  if (!isWellFormedPress(query)) {
    throw new InvalidWebhookError("The press has missing fields or fields of the wrong type");
  }
  const { from, message, data } = query;
  if (from.is_bot || message === undefined || data === undefined) return null;
  if (message.chat.type === "channel") return null;
  const press: CanonicalPress = {
    agentId,
    channel: "telegram",
    threadId: String(message.chat.id),
    chatType: message.chat.type === "private" ? "direct" : "group",
    sender: { channelUserId: String(from.id) },
    pressId: query.id,
    providerMessageId: String(message.message_id),
    data,
  };
  const language = from.language_code;
  if (typeof language === "string" && language.length <= MAX_LANGUAGE_TAG_CHARS) {
    press.sender.languageCode = language;
  }
  return press;
}

interface TelegramCallbackQuery {
  id: string;
  from: { id: number; is_bot?: boolean; language_code?: string };
  /** The message the button is on; missing for a message sent in inline mode. */
  message?: { message_id: number; chat: { id: number; type: string } };
  data?: string;
}

/** Every field `normalizeTelegramPress` reads, checked before any of it is trusted. */
function isWellFormedPress(query: unknown): query is TelegramCallbackQuery {
  if (!isObject(query) || !isObject(query.from)) return false;
  return (
    isString(query.id) &&
    typeof query.from.id === "number" &&
    isOptional(
      query.message,
      (message) =>
        isObject(message) &&
        typeof message.message_id === "number" &&
        isObject(message.chat) &&
        typeof message.chat.id === "number" &&
        CHAT_TYPES.includes(message.chat.type as string),
    ) &&
    isOptional(
      query.data,
      (data) =>
        isString(data) && new TextEncoder().encode(data).byteLength <= MAX_BUTTON_DATA_BYTES,
    )
  );
}

/** Telegram's inline keyboard, from rows of buttons. */
function keyboard(buttons: InlineKeyboard) {
  return {
    inline_keyboard: buttons.map((row) =>
      row.map((button) => ({ text: button.label, callback_data: button.data })),
    ),
  };
}

const isString = (value: unknown): value is string => typeof value === "string";
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const isOptional = (value: unknown, check: (value: unknown) => boolean) =>
  value === undefined || check(value);
const isFile = (value: unknown) =>
  isObject(value) && isString(value.file_id) && isOptional(value.mime_type, isString);

/** Every field `normalize` reads, checked before any of it is trusted. */
function isWellFormed(message: unknown): message is TelegramMessage {
  if (!isObject(message) || !isObject(message.chat)) return false;
  return (
    typeof message.message_id === "number" &&
    typeof message.date === "number" &&
    typeof message.chat.id === "number" &&
    CHAT_TYPES.includes(message.chat.type as string) &&
    isOptional(
      message.from,
      (from) =>
        isObject(from) && typeof from.id === "number" && isOptional(from.first_name, isString),
    ) &&
    isOptional(message.text, isString) &&
    isOptional(message.caption, isString) &&
    isOptional(message.photo, (photo) => Array.isArray(photo) && photo.every(isFile)) &&
    [message.document, message.voice, message.audio, message.video].every((file) =>
      isOptional(file, isFile),
    ) &&
    isOptional(
      message.reply_to_message,
      (reply) => isObject(reply) && typeof reply.message_id === "number",
    )
  );
}

/**
 * Telegram's servers fetch the link they preview, so a link the model built could carry what it
 * read out in its path or query (#130). Only the link the caller vouches for is previewed, and
 * only when the text holds it: the Bot API doesn't tie that link to the text, and an empty one
 * means the text's first link. Everything else goes out with previews off. The caller is the
 * conversation runtime, the only Worker bound to channel-egress's sending entrypoint, which picks
 * the link from the turn's inputs.
 */
function linkPreview(text: string, previewUrl: string | undefined) {
  return typeof previewUrl === "string" && WEB_LINK.test(previewUrl) && text.includes(previewUrl)
    ? { url: previewUrl }
    : { is_disabled: true };
}

/** An http or https link with at least the start of a host. */
const WEB_LINK = /^https?:\/\/[^\s/?#]/i;

/** A reply to an id Telegram can't have issued goes out as a plain message. */
function replyParameters(replyToMessageId: string | undefined) {
  const messageId = Number(replyToMessageId);
  if (replyToMessageId === undefined || !Number.isSafeInteger(messageId)) return {};
  return { reply_parameters: { message_id: messageId, allow_sending_without_reply: true } };
}

function partsOf(message: TelegramMessage): MessagePart[] {
  if (message.text) return [{ type: "text", text: message.text }];
  const media = mediaOf(message);
  if (!media) return [];
  const part: MessagePart = { type: "media", kind: media.kind, mediaId: media.file.file_id };
  if (media.file.mime_type) part.mimeType = media.file.mime_type;
  if (message.caption) part.caption = message.caption;
  return [part];
}

function mediaOf(
  message: TelegramMessage,
): { kind: "image" | "audio" | "video" | "file"; file: TelegramFile } | null {
  const largestPhoto = message.photo?.at(-1);
  if (largestPhoto) return { kind: "image", file: largestPhoto };
  if (message.voice) return { kind: "audio", file: message.voice };
  if (message.audio) return { kind: "audio", file: message.audio };
  if (message.video) return { kind: "video", file: message.video };
  if (message.document) return { kind: "file", file: message.document };
  return null;
}

async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const left = new Uint8Array(x);
  const right = new Uint8Array(y);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}
