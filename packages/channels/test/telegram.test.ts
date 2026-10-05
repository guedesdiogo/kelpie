import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChannelRateLimitedError,
  ChannelRequestError,
  InvalidWebhookError,
  RecipientUnavailableError,
} from "../src/index.ts";
import { normalizeTelegramUpdate, TelegramAdapter } from "../src/telegram.ts";
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
  const redirects: (RequestRedirect | undefined)[] = [];
  const fetch = (async (input: string, init?: RequestInit) => {
    const method = input.split("/").at(-1) ?? "";
    calls.push({ url: input, method, body: JSON.parse(String(init?.body)) });
    redirects.push(init?.redirect);
    return answer(method);
  }) as typeof globalThis.fetch;
  return {
    calls,
    redirects,
    adapter: new TelegramAdapter({ botToken: TOKEN, webhookSecret: SECRET, fetch }),
  };
}

afterEach(() => vi.unstubAllGlobals());

/** The private text update, with some message fields replaced. */
function withMessage(fields: Record<string, unknown>) {
  return { ...updates.privateText, message: { ...updates.privateText.message, ...fields } };
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
    for (const near of [`${SECRET}x`, SECRET.slice(0, -1), `${SECRET} `, SECRET.toUpperCase()]) {
      expect(await adapter.verify(webhook(updates.privateText, near))).toBe(false);
    }
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

  it("normalizes without a token, as ingress does before it knows the bot", () => {
    expect(normalizeTelegramUpdate(webhook(updates.privateText), "assistant")).toEqual(
      normalize(updates.privateText),
    );
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
    ["a post a linked channel relayed into a group", updates.relayedChannelPost],
    ["a message without a sender", updates.withoutSender],
    ["a sticker, not handled yet", updates.sticker],
  ])("yields no event for %s", (_label, update) => {
    expect(normalize(update)).toEqual([]);
  });

  it.each([
    ["a body that isn't JSON", "{not json"],
    ["a body that isn't an object", "42"],
    ["a message without a chat", { update_id: 1, message: { message_id: 1, date: updates.SENT } }],
    ["a sender id that isn't a number", withMessage({ from: { id: "1001", is_bot: false } })],
    ["text that isn't a string", withMessage({ text: { bold: "hi" } })],
    ["photos that aren't a list", withMessage({ text: undefined, photo: { file_id: "x" } })],
    ["a chat type Telegram doesn't have", withMessage({ chat: { id: 1, type: "secret" } })],
    ["a reply without a message id", withMessage({ reply_to_message: { message_id: "41" } })],
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

  it("escapes what already looks like an entity, and refuses to follow redirects", async () => {
    const { adapter, calls, redirects } = botApi();
    await adapter.send({ threadId: "1001" }, "&lt; is how you write <");
    expect(calls[0]?.body.text).toBe("&amp;lt; is how you write &lt;");
    // Workers' fetch can't refuse redirects itself, so the adapter takes them as answers.
    expect(redirects).toEqual(["manual"]);
  });

  it("treats a redirect as a failure, so the token never follows it", async () => {
    const { adapter, calls } = botApi(
      () =>
        new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } }),
    );
    const error = await adapter.send({ threadId: "1001" }, "hi").catch((caught) => caught);
    expect(error).toBeInstanceOf(ChannelRequestError);
    expect(calls).toHaveLength(1);
  });

  it("sends a reply to an id Telegram can't have issued as a plain message", async () => {
    const { adapter, calls } = botApi();
    await adapter.send({ threadId: "1001", replyToMessageId: "not-a-number" }, "hi");
    expect(calls[0]?.body).not.toHaveProperty("reply_parameters");
  });

  it("calls the runtime's fetch as a plain function, as Workers require", async () => {
    const strictFetch = vi.fn(function (this: unknown) {
      // Workers throw this when fetch is called as a method of another object.
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(okResult({ message_id: 9 }));
    });
    vi.stubGlobal("fetch", strictFetch);
    const adapter = new TelegramAdapter({ botToken: TOKEN, webhookSecret: SECRET });
    expect(await adapter.send({ threadId: "1001" }, "hi")).toEqual({ providerMessageId: "9" });
  });

  it("sends silently on request, and as a reply when asked", async () => {
    const { adapter, calls } = botApi();
    await adapter.send({ threadId: "1001", replyToMessageId: "41" }, "one", { silent: true });
    expect(calls[0]?.body).toMatchObject({
      disable_notification: true,
      reply_parameters: { message_id: 41, allow_sending_without_reply: true },
    });
  });

  it("asks who the bot is, which also proves the token works", async () => {
    const { adapter, calls } = botApi(() =>
      okResult({ id: 555, is_bot: true, first_name: "Kelpie", username: "kelpie_bot" }),
    );
    expect(await adapter.me()).toEqual({ id: 555, username: "kelpie_bot" });
    expect(calls[0]?.method).toBe("getMe");

    const nameless = botApi(() => okResult({ id: 555, is_bot: true, first_name: "Kelpie" }));
    await expect(nameless.adapter.me()).rejects.toBeInstanceOf(ChannelRequestError);
  });

  it("shows typing", async () => {
    const { adapter, calls } = botApi(() => okResult(true));
    await adapter.typing({ threadId: "1001" });
    expect(calls[0]).toMatchObject({
      method: "sendChatAction",
      body: { chat_id: "1001", action: "typing" },
    });
  });

  it("registers the webhook for new messages only, with the bot's own secret", async () => {
    const { adapter, calls } = botApi(() => okResult(true));
    await adapter.setWebhook("https://ingress.example/webhooks/telegram/assistant");
    expect(calls).toEqual([
      {
        url: `https://api.telegram.org/bot${TOKEN}/setWebhook`,
        method: "setWebhook",
        body: {
          url: "https://ingress.example/webhooks/telegram/assistant",
          secret_token: SECRET,
          allowed_updates: ["message"],
        },
      },
    ]);

    const refused = botApi(() => failure(400));
    await expect(refused.adapter.setWebhook("https://ingress.example/x")).rejects.toBeInstanceOf(
      ChannelRequestError,
    );
  });

  it("turns a 429 into a wait, in milliseconds", async () => {
    const { adapter } = botApi(() => failure(429, { parameters: { retry_after: 7 } }));
    const error = await adapter.send({ threadId: "1001" }, "hi").catch((caught) => caught);
    expect(error).toBeInstanceOf(ChannelRateLimitedError);
    expect(error.retryAfterMs).toBe(7_000);
  });

  it("waits a second when Telegram gives no usable retry_after", async () => {
    for (const parameters of [{}, { retry_after: 0 }, { retry_after: "soon" }]) {
      const { adapter } = botApi(() => failure(429, { parameters }));
      const error = await adapter.send({ threadId: "1001" }, "hi").catch((caught) => caught);
      expect(error.retryAfterMs).toBe(1_000);
    }
  });

  it("trusts Telegram's error_code over the HTTP status", async () => {
    const { adapter } = botApi(() =>
      Response.json(
        { ok: false, error_code: 429, parameters: { retry_after: 2 } },
        { status: 500 },
      ),
    );
    await expect(adapter.send({ threadId: "1001" }, "hi")).rejects.toBeInstanceOf(
      ChannelRateLimitedError,
    );
  });

  it("treats a success without a result as no usable answer", async () => {
    for (const body of [{ ok: true }, { ok: true, result: null }]) {
      const { adapter } = botApi(() => Response.json(body));
      await expect(adapter.send({ threadId: "1001" }, "hi")).rejects.toMatchObject({
        name: "ChannelRequestError",
        status: null,
      });
    }
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
