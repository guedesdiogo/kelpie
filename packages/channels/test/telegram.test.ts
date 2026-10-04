import { describe, expect, it } from "vitest";
import {
  ChannelRateLimitedError,
  ChannelRequestError,
  InvalidWebhookError,
  RecipientUnavailableError,
  TelegramAdapter,
} from "../src/index.ts";
import * as updates from "./telegram-updates.ts";

const TOKEN = "123456:test-token-not-real";
const SECRET = "webhook_secret-1";

/** `secret: null` sends no secret header at all. */
const webhook = (body: unknown, secret: string | null = SECRET) => ({
  headers: secret === null ? {} : { "x-telegram-bot-api-secret-token": secret },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

/** A fake Bot API: records each call and answers with `answer`. */
function botApi(answer: (method: string) => Response = () => okResult({ message_id: 77 })) {
  const calls: { url: string; method: string; body: Record<string, unknown> }[] = [];
  const fetch = (async (input: string, init?: RequestInit) => {
    const method = input.split("/").at(-1) ?? "";
    calls.push({ url: input, method, body: JSON.parse(String(init?.body)) });
    return answer(method);
  }) as typeof globalThis.fetch;
  return { calls, adapter: new TelegramAdapter({ botToken: TOKEN, webhookSecret: SECRET, fetch }) };
}

const okResult = (result: unknown) => Response.json({ ok: true, result });
const failure = (status: number, extra: Record<string, unknown> = {}) =>
  Response.json({ ok: false, error_code: status, description: "nope", ...extra }, { status });

describe("Telegram webhooks", () => {
  it("accepts only the secret given to setWebhook", async () => {
    const { adapter } = botApi();
    expect(await adapter.verify(webhook(updates.privateText))).toBe(true);
    expect(await adapter.verify(webhook(updates.privateText, "wrong"))).toBe(false);
    expect(await adapter.verify(webhook(updates.privateText, ""))).toBe(false);
    expect(await adapter.verify(webhook(updates.privateText, null))).toBe(false);
  });

  it("matches nothing when the bot has no secret configured", async () => {
    const adapter = new TelegramAdapter({ botToken: TOKEN, webhookSecret: "" });
    expect(await adapter.verify(webhook(updates.privateText, ""))).toBe(false);
  });
});

describe("Telegram normalize", () => {
  const normalize = (body: unknown) => botApi().adapter.normalize(webhook(body), "assistant");

  it("turns a private text message into a direct event, with the send time in milliseconds", () => {
    expect(normalize(updates.privateText)).toEqual([
      {
        agentId: "assistant",
        channel: "telegram",
        threadId: "1001",
        chatType: "direct",
        sender: { channelUserId: "1001", displayName: "Diogo" },
        providerMessageId: "42",
        providerTimestamp: updates.SENT * 1_000,
        parts: [{ type: "text", text: "where is my order?" }],
      },
    ]);
  });

  it("keeps what a message replies to, and marks group chats", () => {
    expect(normalize(updates.reply)[0]?.replyTo).toEqual({ providerMessageId: "41" });
    expect(normalize(updates.groupText)[0]).toMatchObject({
      chatType: "group",
      threadId: "-100200",
    });
  });

  it("takes the largest photo, with its caption, and files and voice notes as media", () => {
    expect(normalize(updates.photoWithCaption)[0]?.parts).toEqual([
      { type: "media", kind: "image", mediaId: "large", caption: "the receipt" },
    ]);
    expect(normalize(updates.pdf)[0]?.parts).toEqual([
      { type: "media", kind: "file", mediaId: "doc-1", mimeType: "application/pdf" },
    ]);
    expect(normalize(updates.voice)[0]?.parts).toEqual([
      { type: "media", kind: "audio", mediaId: "voice-1", mimeType: "audio/ogg" },
    ]);
  });

  it.each([
    ["an edited message (#70)", updates.edited],
    ["a channel post", updates.channelPost],
    ["a membership change", updates.blockedByUser],
    ["a message from a bot", updates.fromBot],
    ["a sticker, not handled yet", updates.sticker],
  ])("yields no event for %s", (_label, update) => {
    expect(normalize(update)).toEqual([]);
  });

  it.each([
    ["a body that isn't JSON", "{not json"],
    ["a body that isn't an object", "42"],
    ["a message without a chat", { update_id: 1, message: { message_id: 1, date: updates.SENT } }],
  ])("refuses %s", (_label, body) => {
    expect(() => normalize(body)).toThrow(InvalidWebhookError);
  });
});

describe("Telegram sending", () => {
  it("sends escaped HTML, so any text the model writes goes through as typed", async () => {
    const { adapter, calls } = botApi();
    expect(await adapter.send({ threadId: "1001" }, "a < b & c <script>")).toEqual({
      providerMessageId: "77",
    });
    expect(calls).toEqual([
      {
        url: `https://api.telegram.org/bot${TOKEN}/sendMessage`,
        method: "sendMessage",
        body: {
          chat_id: "1001",
          text: "a &lt; b &amp; c &lt;script&gt;",
          parse_mode: "HTML",
          disable_notification: false,
        },
      },
    ]);
  });

  it("sends silently on request, and as a reply when asked", async () => {
    const { adapter, calls } = botApi();
    await adapter.send({ threadId: "1001", replyToMessageId: "41" }, "one", { silent: true });
    expect(calls[0]?.body).toMatchObject({
      disable_notification: true,
      reply_parameters: { message_id: 41, allow_sending_without_reply: true },
    });
  });

  it("shows typing", async () => {
    const { adapter, calls } = botApi(() => okResult(true));
    await adapter.typing({ threadId: "1001" });
    expect(calls[0]).toMatchObject({
      method: "sendChatAction",
      body: { chat_id: "1001", action: "typing" },
    });
  });

  it("turns a 429 into a wait, in milliseconds", async () => {
    const { adapter } = botApi(() => failure(429, { parameters: { retry_after: 7 } }));
    const error = await adapter.send({ threadId: "1001" }, "hi").catch((caught) => caught);
    expect(error).toBeInstanceOf(ChannelRateLimitedError);
    expect(error.retryAfterMs).toBe(7_000);
  });

  it("tells a recipient who blocked the bot apart from other failures", async () => {
    const blocked = botApi(() => failure(403));
    await expect(blocked.adapter.send({ threadId: "1001" }, "hi")).rejects.toBeInstanceOf(
      RecipientUnavailableError,
    );
    const broken = botApi(() => failure(400));
    await expect(broken.adapter.send({ threadId: "1001" }, "hi")).rejects.toMatchObject({
      name: "ChannelRequestError",
      method: "sendMessage",
      status: 400,
    });
  });

  it("never puts the token in an error, even when the network fails", async () => {
    const failing = new TelegramAdapter({
      botToken: TOKEN,
      webhookSecret: SECRET,
      fetch: (async (url: string) => {
        throw new TypeError(`fetch failed for ${url}`);
      }) as typeof fetch,
    });
    const error = await failing.send({ threadId: "1001" }, "hi").catch((caught) => caught);
    expect(error).toBeInstanceOf(ChannelRequestError);
    expect(`${error.message} ${error.stack}`).not.toContain(TOKEN);

    const { adapter } = botApi(() => failure(400));
    const refused = await adapter.send({ threadId: "1001" }, "hi").catch((caught) => caught);
    expect(`${refused.message} ${refused.stack}`).not.toContain(TOKEN);
  });
});
