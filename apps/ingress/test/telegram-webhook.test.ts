import { env, exports } from "cloudflare:workers";
import { DIRECTORY_NAME } from "@kelpie/access";
import type { EgressDestination, WebhookNotice } from "@kelpie/channels";
import type {
  InboundMessage,
  IngestResult,
  PauseResult,
  PauseTarget,
} from "@kelpie/conversation/contract";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { admitSender } from "../src/admission.ts";
import { handleTelegramWebhook, type TelegramWebhookDeps } from "../src/telegram-webhook.ts";

const SECRET = "the-bot-webhook-secret";
/** The one secret the stub egress in vitest.config.ts accepts. */
const ROUTED_SECRET = "routed-secret";
const OWNER_TELEGRAM_ID = 1001;
const OWNER_CHAT_ID = 1001;

/** A Telegram update with one message; `message` fields replace the private text message's. */
function update(message: Record<string, unknown> = {}) {
  return {
    update_id: 9001,
    message: {
      message_id: 42,
      from: { id: OWNER_TELEGRAM_ID, is_bot: false, first_name: "Owner" },
      chat: { id: OWNER_CHAT_ID, type: "private" },
      date: 1_791_190_000,
      text: "oi, tudo bem?",
      ...message,
    },
  };
}

function webhook(
  body: unknown,
  { secret = SECRET as string | null, agentId = "kelpie", method = "POST" } = {},
) {
  const headers = new Headers({ "content-type": "application/json" });
  if (secret !== null) headers.set("x-telegram-bot-api-secret-token", secret);
  return new Request(`https://ingress.test/webhooks/telegram/${agentId}`, {
    method,
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const directory = () => env.DIRECTORY.getByName(DIRECTORY_NAME);

/** Fakes for egress and the conversation; admission and pairing use the real Directory. */
function fakes(overrides: Partial<TelegramWebhookDeps> = {}) {
  const verified: { agentId: string; secret: string | null }[] = [];
  const ingested: { name: string; message: InboundMessage }[] = [];
  const paused: { name: string; target: PauseTarget }[] = [];
  const notices: { agentId: string; destination: EgressDestination; notice: WebhookNotice }[] = [];
  const deps: TelegramWebhookDeps = {
    webhooks: {
      async verifyTelegram(agentId, secret) {
        verified.push({ agentId, secret });
        return secret === SECRET ? { ok: true } : { ok: false, reason: "refused" };
      },
      async notice(agentId, destination, notice) {
        notices.push({ agentId, destination, notice });
        return { ok: true };
      },
    },
    admit: (event) => admitSender(env, event),
    directory: directory(),
    async ingest(name, message): Promise<IngestResult> {
      ingested.push({ name, message });
      return { status: "accepted", flushAt: 0 };
    },
    async pause(name, target): Promise<PauseResult> {
      paused.push({ name, target });
      return { status: "paused" };
    },
    ...overrides,
  };
  return { deps, verified, ingested, notices, paused };
}

/** A `/start` as Telegram sends it from a deep link: a bot command entity at the start. */
function start(from: number, payload: string | null, firstName = "Someone") {
  const text = payload === null ? "/start" : `/start ${payload}`;
  return update({
    message_id: 500 + from,
    from: { id: from, is_bot: false, first_name: firstName },
    chat: { id: from, type: "private" },
    text,
    entities: [{ offset: 0, length: 6, type: "bot_command" }],
  });
}

async function issueCode() {
  const issued = await directory().issuePairingCode("u-owner", "telegram");
  if (!issued.ok) throw new Error("no code");
  return issued.code;
}

beforeAll(async () => {
  await directory().registerOwner("u-owner");
  const owner = { channel: "telegram", channelUserId: String(OWNER_TELEGRAM_ID) } as const;
  await directory().redeemPairingCode(await issueCode(), owner);
  await directory().setTimeZone("u-owner", "America/Sao_Paulo");
});

afterEach(() => vi.restoreAllMocks());

describe("Telegram webhook", () => {
  it("hands the owner's message to its conversation, and answers once it is stored", async () => {
    const { deps, verified, ingested } = fakes();

    const response = await handleTelegramWebhook(webhook(update()), "kelpie", deps);

    expect(response.status).toBe(200);
    expect(verified).toEqual([{ agentId: "kelpie", secret: SECRET }]);
    expect(ingested).toEqual([
      {
        name: `kelpie:telegram:${OWNER_CHAT_ID}`,
        message: {
          agentId: "kelpie",
          providerMessageId: "42",
          userId: "u-owner",
          text: "oi, tudo bem?",
          destination: { channel: "telegram", threadId: String(OWNER_CHAT_ID) },
          sentAt: 1_791_190_000_000,
          timeZone: "America/Sao_Paulo",
        },
      },
    ]);
  });

  it("refuses a request without the bot's secret, and never reads its body", async () => {
    for (const secret of [null, "a-well-formed-guess"]) {
      const { deps, ingested } = fakes();
      const request = webhook(update(), { secret });

      const response = await handleTelegramWebhook(request, "kelpie", deps);

      expect(response.status).toBe(401);
      expect(request.bodyUsed).toBe(false);
      expect(ingested).toEqual([]);
    }
  });

  it("refuses a missing or impossible secret without asking egress", async () => {
    for (const secret of [null, "", "x".repeat(257), "has space", "ação"]) {
      const { deps, verified } = fakes();
      const response = await handleTelegramWebhook(webhook(update(), { secret }), "kelpie", deps);
      expect(response.status).toBe(401);
      expect(verified).toEqual([]);
    }
  });

  it("asks nothing of egress for an agent id that can't exist", async () => {
    const { deps, verified } = fakes();
    const response = await handleTelegramWebhook(
      webhook(update(), { agentId: "Not%20An%20Agent" }),
      "Not An Agent",
      deps,
    );
    expect(response.status).toBe(404);
    expect(verified).toEqual([]);
  });

  it.each([
    ["a body that isn't JSON", "{not json"],
    ["an update without a new message (an edit)", { update_id: 1, edited_message: {} }],
    ["a message with fields of the wrong type", update({ message_id: "42" })],
    ["a group chat", update({ chat: { id: -100, type: "group" } })],
    ["a stranger", update({ from: { id: 9999, is_bot: false } })],
    ["a message from a bot", update({ from: { id: OWNER_TELEGRAM_ID, is_bot: true } })],
    ["a photo without text", update({ text: undefined, photo: [{ file_id: "p1" }] })],
    ["a body past the size cap", update({ text: "x".repeat(300_000) })],
  ])("drops %s with a 200, so Telegram doesn't send it again", async (_label, body) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deps, ingested } = fakes();

    const response = await handleTelegramWebhook(webhook(body), "kelpie", deps);

    expect(response.status).toBe(200);
    expect(ingested).toEqual([]);
  });

  it("acknowledges a message the conversation refuses, without its text in the logs", async () => {
    const logged: unknown[][] = [];
    for (const level of ["log", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((...args) => {
        logged.push(args);
      });
    }
    const { deps } = fakes({
      ingest: async () => ({ status: "rejected", reason: "too_long" }),
    });

    const response = await handleTelegramWebhook(webhook(update()), "kelpie", deps);

    expect(response.status).toBe(200);
    expect(logged.length).toBeGreaterThan(0);
    expect(JSON.stringify(logged)).not.toContain("tudo bem");
    expect(JSON.stringify(logged)).not.toContain(SECRET);
  });

  it("answers 503 when egress, the Directory or the conversation fails, so Telegram retries", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const sendsNothing = async () => ({ ok: true }) as const;
    const failing: Partial<TelegramWebhookDeps>[] = [
      {
        webhooks: {
          verifyTelegram: async () => ({ ok: false, reason: "store_unavailable" }),
          notice: sendsNothing,
        },
      },
      {
        webhooks: {
          verifyTelegram: async () => {
            throw new Error("egress unreachable");
          },
          notice: sendsNothing,
        },
      },
      {
        admit: async () => {
          throw new Error("Directory unreachable");
        },
      },
      {
        ingest: async () => {
          throw new Error("conversation unreachable");
        },
      },
    ];
    for (const [index, overrides] of failing.entries()) {
      const { deps, ingested } = fakes(overrides);
      const request = webhook(update());
      const response = await handleTelegramWebhook(request, "kelpie", deps);
      expect(response.status).toBe(503);
      // An unverified update is neither read nor handed on.
      if (index < 2) {
        expect(request.bodyUsed).toBe(false);
        expect(ingested).toEqual([]);
      }
    }
  });
});

describe("Telegram /pause", () => {
  const command = (text: string, from = OWNER_TELEGRAM_ID) =>
    update({
      from: { id: from, is_bot: false, first_name: "Someone" },
      chat: { id: from, type: "private" },
      text,
      entities: [{ offset: 0, length: text.length, type: "bot_command" }],
    });
  // The update's id lets the conversation drop a pause Telegram delivers again.
  const ownerChat = {
    name: `kelpie:telegram:${OWNER_CHAT_ID}`,
    target: {
      agentId: "kelpie",
      destination: { channel: "telegram", threadId: String(OWNER_CHAT_ID) },
      providerMessageId: "42",
    },
  };

  it("pauses the owner's conversation, and never hands the command to the model", async () => {
    const { deps, ingested, paused } = fakes();
    const response = await handleTelegramWebhook(webhook(command("/pause")), "kelpie", deps);
    expect(response.status).toBe(200);
    expect(paused).toEqual([ownerChat]);
    expect(ingested).toEqual([]);
  });

  it("accepts /pause addressed to the bot by name", async () => {
    const { deps, paused } = fakes();
    await handleTelegramWebhook(webhook(command("/pause@Kelpie_dg_bot")), "kelpie", deps);
    expect(paused).toEqual([ownerChat]);
  });

  it("pauses nothing for a stranger", async () => {
    const { deps, paused, ingested } = fakes();
    await handleTelegramWebhook(webhook(command("/pause", 777)), "kelpie", deps);
    expect(paused).toEqual([]);
    expect(ingested).toEqual([]);
  });
});

describe("Telegram pairing and strangers", () => {
  it("pairs a new account from /start <code>, tells it so, and keeps the code from the model", async () => {
    const { deps, ingested, notices } = fakes();
    const code = await issueCode();

    const response = await handleTelegramWebhook(webhook(start(4242, code)), "kelpie", deps);

    expect(response.status).toBe(200);
    expect(ingested).toEqual([]);
    expect(notices).toEqual([
      {
        agentId: "kelpie",
        destination: { channel: "telegram", threadId: "4242" },
        notice: { kind: "paired" },
      },
    ]);
    expect(
      await directory().admit({ channel: "telegram", channelUserId: "4242" }, "kelpie"),
    ).toMatchObject({ admitted: true, userId: "u-owner" });
  });

  it("answers a wrong code with nothing at all", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deps, ingested, notices } = fakes();
    const response = await handleTelegramWebhook(webhook(start(4343, "WRONGCD2")), "kelpie", deps);
    expect(response.status).toBe(200);
    expect(ingested).toEqual([]);
    expect(notices).toEqual([]);
  });

  it("tells the owner about a stranger once, on the owner's own chat, and the stranger nothing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deps, ingested, notices } = fakes();
    const stranger = update({
      message_id: 600,
      from: { id: 4444, is_bot: false, first_name: "Mallory" },
      chat: { id: 4444, type: "private" },
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await handleTelegramWebhook(webhook(stranger), "kelpie", deps);
      expect(response.status).toBe(200);
    }
    expect(ingested).toEqual([]);
    expect(notices).toEqual([
      {
        agentId: "kelpie",
        destination: { channel: "telegram", threadId: String(OWNER_TELEGRAM_ID) },
        notice: { kind: "stranger", senderId: "4444", displayName: "Mallory" },
      },
    ]);
  });

  it("treats a bare /start from a stranger as a stranger, not a wrong code", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deps, notices } = fakes();
    await handleTelegramWebhook(webhook(start(4545, null)), "kelpie", deps);
    expect(notices).toMatchObject([{ notice: { kind: "stranger", senderId: "4545" } }]);
  });

  it("drops /start from an account already paired, so a code never reaches the model", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deps, ingested, notices } = fakes();
    for (const payload of ["ABCD2345", null]) {
      const response = await handleTelegramWebhook(
        webhook(start(OWNER_TELEGRAM_ID, payload)),
        "kelpie",
        deps,
      );
      expect(response.status).toBe(200);
    }
    expect(ingested).toEqual([]);
    expect(notices).toEqual([]);
  });

  it("still answers 200 when a notice can't be sent, and can tell the owner later", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const failures: TelegramWebhookDeps["webhooks"]["notice"][] = [
      async () => ({ ok: false, reason: "recipient_unavailable" }),
      async () => {
        throw new Error("egress unreachable");
      },
    ];
    for (const [index, failing] of failures.entries()) {
      const { deps, notices } = fakes();
      const attempts: string[] = [];
      deps.webhooks = {
        ...deps.webhooks,
        notice: async (...args) => {
          attempts.push(args[2].kind);
          return failing(...args);
        },
      };
      const stranger = update({
        message_id: 700 + index,
        from: { id: 4646 + index, is_bot: false },
        chat: { id: 4646 + index, type: "private" },
      });
      expect((await handleTelegramWebhook(webhook(stranger), "kelpie", deps)).status).toBe(200);
      expect(attempts).toEqual(["stranger"]);

      // The failed notice didn't count: the stranger's next message tries again.
      const { deps: working, notices: sent } = fakes();
      await handleTelegramWebhook(webhook(stranger), "kelpie", working);
      expect(sent).toMatchObject([{ notice: { kind: "stranger" } }]);
      expect(notices).toEqual([]);
    }
  });

  it("pairs even when the paired notice can't be sent, and still answers 200", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deps } = fakes();
    deps.webhooks = {
      ...deps.webhooks,
      notice: async () => ({ ok: false, reason: "recipient_unavailable" }),
    };
    const response = await handleTelegramWebhook(
      webhook(start(4848, await issueCode())),
      "kelpie",
      deps,
    );
    expect(response.status).toBe(200);
    expect(
      await directory().admit({ channel: "telegram", channelUserId: "4848" }, "kelpie"),
    ).toMatchObject({ admitted: true });
  });

  it("answers 200 when the Directory can't record a stranger, since a notice is optional", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deps, notices } = fakes({
      directory: {
        redeemPairingCode: (code, identity) => directory().redeemPairingCode(code, identity),
        noticeStranger: async () => {
          throw new Error("Directory unreachable");
        },
        releaseStrangerNotice: async () => {},
      },
    });
    const stranger = update({
      message_id: 800,
      from: { id: 4949, is_bot: false },
      chat: { id: 4949, type: "private" },
    });
    expect((await handleTelegramWebhook(webhook(stranger), "kelpie", deps)).status).toBe(200);
    expect(notices).toEqual([]);
  });

  it("never pairs or notices from a group, even with a valid code", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deps, notices } = fakes();
    const code = await issueCode();
    const inGroup = update({
      message_id: 900,
      from: { id: 5050, is_bot: false },
      chat: { id: -100123, type: "supergroup" },
      text: `/start ${code}`,
    });
    expect((await handleTelegramWebhook(webhook(inGroup), "kelpie", deps)).status).toBe(200);
    expect(notices).toEqual([]);
    // The code is still unspent: the owner can use it in a direct chat.
    expect(
      await directory().redeemPairingCode(code, { channel: "telegram", channelUserId: "5051" }),
    ).toMatchObject({ ok: true });
  });
});

describe("ingress routing", () => {
  it("routes a verified update through egress and the Directory to its conversation", async () => {
    const response = await exports.default.fetch(webhook(update(), { secret: ROUTED_SECRET }));
    expect(response.status).toBe(200);

    // The stub conversation in vitest.config.ts keeps the last message it was given.
    const conversation = env.CONVERSATION_AGENT.getByName(
      `kelpie:telegram:${OWNER_CHAT_ID}`,
    ) as unknown as { received(): Promise<InboundMessage | null> };
    expect(await conversation.received()).toMatchObject({
      agentId: "kelpie",
      userId: "u-owner",
      text: "oi, tudo bem?",
      destination: { channel: "telegram", threadId: String(OWNER_CHAT_ID) },
    });
  });

  it("refuses a secret egress doesn't accept", async () => {
    const response = await exports.default.fetch(webhook(update()));
    expect(response.status).toBe(401);
  });

  it("answers anything but a POST to an agent id there with 404", async () => {
    const get = await exports.default.fetch("https://ingress.test/webhooks/telegram/kelpie");
    expect(get.status).toBe(404);
    for (const path of ["kelpie/extra", "%E0%A4%A", "Kelpie", ""]) {
      const response = await exports.default.fetch(
        new Request(`https://ingress.test/webhooks/telegram/${path}`, { method: "POST" }),
      );
      expect(response.status).toBe(404);
    }
  });
});
