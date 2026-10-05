import { env, exports } from "cloudflare:workers";
import { DIRECTORY_NAME } from "@kelpie/access";
import type { InboundMessage, IngestResult } from "@kelpie/conversation/contract";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { admitSender } from "../src/admission.ts";
import { handleTelegramWebhook, type TelegramWebhookDeps } from "../src/telegram-webhook.ts";

const SECRET = "the-bot-webhook-secret";
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

/** Fakes for egress and the conversation; admission uses the real Directory. */
function fakes(overrides: Partial<TelegramWebhookDeps> = {}) {
  const verified: { agentId: string; secret: string | null }[] = [];
  const ingested: { name: string; message: InboundMessage }[] = [];
  const deps: TelegramWebhookDeps = {
    webhooks: {
      async verifyTelegram(agentId, secret) {
        verified.push({ agentId, secret });
        return secret === SECRET ? { ok: true } : { ok: false, reason: "refused" };
      },
    },
    admit: (event) => admitSender(env, event),
    async ingest(name, message): Promise<IngestResult> {
      ingested.push({ name, message });
      return { status: "accepted", flushAt: 0 };
    },
    ...overrides,
  };
  return { deps, verified, ingested };
}

beforeAll(async () => {
  const directory = env.DIRECTORY.getByName(DIRECTORY_NAME);
  await directory.registerOwner("u-owner");
  const owner = { channel: "telegram", channelUserId: String(OWNER_TELEGRAM_ID) } as const;
  await directory.addIdentity("u-owner", owner);
  await directory.enableIdentity(owner);
  await directory.setTimeZone("u-owner", "America/Sao_Paulo");
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
    for (const secret of [null, "a-guess"]) {
      const { deps, ingested } = fakes();
      const request = webhook(update(), { secret });

      const response = await handleTelegramWebhook(request, "kelpie", deps);

      expect(response.status).toBe(401);
      expect(request.bodyUsed).toBe(false);
      expect(ingested).toEqual([]);
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
    const failing: Partial<TelegramWebhookDeps>[] = [
      { webhooks: { verifyTelegram: async () => ({ ok: false, reason: "store_unavailable" }) } },
      {
        webhooks: {
          verifyTelegram: async () => {
            throw new Error("egress unreachable");
          },
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
    for (const overrides of failing) {
      const { deps } = fakes(overrides);
      const response = await handleTelegramWebhook(webhook(update()), "kelpie", deps);
      expect(response.status).toBe(503);
    }
  });
});

describe("ingress routing", () => {
  it("routes POST /webhooks/telegram/<agent id> to the webhook, through egress", async () => {
    // The stub egress in vitest.config.ts refuses every secret.
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
