import {
  type ChannelAdapter,
  ChannelRateLimitedError,
  ChannelRequestError,
  type Destination,
  type InboundWebhook,
  InvalidWebhookError,
  RecipientUnavailableError,
  type SendOptions,
  type SendResult,
} from "./adapter.ts";
import { CAPABILITIES } from "./capabilities.ts";
import type { CanonicalEvent, MessagePart } from "./events.ts";

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
/** Ingress lower-cases header names. */
const SECRET_HEADER = "x-telegram-bot-api-secret-token";

interface TelegramFile {
  file_id: string;
  mime_type?: string;
}

interface TelegramMessage {
  message_id: number;
  from?: { id: number; is_bot: boolean; first_name?: string };
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
}

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
    this.#fetch = config.fetch ?? fetch;
  }

  /** The secret Telegram echoes, compared in constant time. A missing or empty one never matches. */
  async verify(webhook: InboundWebhook): Promise<boolean> {
    const presented = webhook.headers[SECRET_HEADER];
    const expected = this.#config.webhookSecret;
    if (!presented || !expected) return false;
    return constantTimeEqual(presented, expected);
  }

  /**
   * A new message from a person becomes one event. Edits, channel posts, membership changes,
   * messages from bots and message kinds Kelpie doesn't handle yet (stickers, locations) yield none.
   */
  normalize(webhook: InboundWebhook, agentId: string): CanonicalEvent[] {
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
    if (
      typeof message !== "object" ||
      message === null ||
      typeof message.message_id !== "number" ||
      typeof message.date !== "number" ||
      typeof message.chat?.id !== "number"
    ) {
      throw new InvalidWebhookError("The message lacks its id, date or chat");
    }
    if (!message.from || message.from.is_bot) return [];
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
    if (message.reply_to_message) {
      event.replyTo = { providerMessageId: String(message.reply_to_message.message_id) };
    }
    return [event];
  }

  async send(
    destination: Destination,
    text: string,
    options: SendOptions = {},
  ): Promise<SendResult> {
    const result = await this.#call<{ message_id: number }>("sendMessage", {
      chat_id: destination.threadId,
      // HTML lets formatting come later; until then every character shows as typed.
      text: escapeHtml(text),
      parse_mode: "HTML",
      disable_notification: options.silent === true,
      ...(destination.replyToMessageId
        ? {
            reply_parameters: {
              message_id: Number(destination.replyToMessageId),
              allow_sending_without_reply: true,
            },
          }
        : {}),
    });
    return { providerMessageId: String(result.message_id) };
  }

  async typing(destination: Destination): Promise<void> {
    await this.#call("sendChatAction", { chat_id: destination.threadId, action: "typing" });
  }

  async #call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetch(`${API}/bot${this.#config.botToken}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      // The runtime's error can quote the URL, and with it the token.
      throw new ChannelRequestError(method, null);
    }
    const payload = (await response.json().catch(() => null)) as TelegramResponse<T> | null;
    if (response.ok && payload?.ok && payload.result !== undefined) return payload.result;
    const status = payload?.error_code ?? response.status;
    if (status === 429) {
      throw new ChannelRateLimitedError((payload?.parameters?.retry_after ?? 1) * 1_000);
    }
    if (status === 403) throw new RecipientUnavailableError(`${method} was refused with 403`);
    throw new ChannelRequestError(method, status);
  }
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

/** The three characters Telegram's HTML mode needs escaped. */
function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
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
