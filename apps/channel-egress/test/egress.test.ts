import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

// The Worker runs in the test's isolate, so a stubbed global fetch stands in for the Bot API.

const BOT_TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw-test";
const destination = { channel: "telegram", threadId: "1001" } as const;
const store = () => env.SECRET_STORE.getByName("secrets");

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

/** A fake Bot API. `answer` decides each response; every call is recorded. */
function botApi(answer: (method: string) => Response = defaultAnswer) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const method = input.split("/").at(-1) ?? "";
    calls.push({ method, url: input, body: JSON.parse(String(init?.body ?? "{}")) });
    return answer(method);
  });
  return calls;
}

function defaultAnswer(method: string): Response {
  if (method === "getMe") {
    return Response.json({
      ok: true,
      result: { id: 123456789, is_bot: true, username: "kelpie_bot" },
    });
  }
  if (method === "sendMessage") return Response.json({ ok: true, result: { message_id: 77 } });
  return Response.json({ ok: true, result: true });
}

/** Opens a form for `agentId` and redeems it with the bot token. */
async function connect(agentId: string) {
  const form = await exports.ChannelForms.createTelegramForm(agentId);
  if (!form.ok) throw new Error("form refused");
  return exports.ChannelForms.redeemTelegramForm(form.token, BOT_TOKEN);
}

afterEach(() => vi.unstubAllGlobals());

describe("ChannelForms", () => {
  it("takes a bot token once, checks it with Telegram, and never returns it", async () => {
    const calls = botApi();
    const form = await exports.ChannelForms.createTelegramForm("sales");
    if (!form.ok) throw new Error("form refused");
    expect(await exports.ChannelForms.describeForm(form.token)).toEqual({
      ok: true,
      agentId: "sales",
      kind: "telegram",
    });

    const redeemed = await exports.ChannelForms.redeemTelegramForm(form.token, ` ${BOT_TOKEN} `);
    expect(redeemed).toEqual({
      ok: true,
      agentId: "sales",
      bot: { id: 123456789, username: "kelpie_bot" },
    });
    expect(JSON.stringify(redeemed)).not.toContain(BOT_TOKEN);
    expect(calls.map((call) => call.method)).toEqual(["getMe"]);

    // The link works once.
    expect(await exports.ChannelForms.redeemTelegramForm(form.token, BOT_TOKEN)).toEqual({
      ok: false,
      reason: "unknown_form",
    });
    expect(await exports.ChannelForms.describeForm(form.token)).toEqual({
      ok: false,
      reason: "unknown_form",
    });
  });

  it("keeps the form open when the token is malformed or Telegram refuses it", async () => {
    botApi((method) =>
      method === "getMe"
        ? Response.json(
            { ok: false, error_code: 401, description: "Unauthorized" },
            { status: 401 },
          )
        : defaultAnswer(method),
    );
    const form = await exports.ChannelForms.createTelegramForm("support");
    if (!form.ok) throw new Error("form refused");

    expect(await exports.ChannelForms.redeemTelegramForm(form.token, "not-a-token")).toEqual({
      ok: false,
      reason: "invalid_token",
    });
    expect(await exports.ChannelForms.redeemTelegramForm(form.token, BOT_TOKEN)).toEqual({
      ok: false,
      reason: "token_refused",
    });
    expect(await exports.ChannelForms.describeForm(form.token)).toMatchObject({ ok: true });
  });

  it("refuses an agent id that can't exist, and a form past its lifetime", async () => {
    botApi();
    expect(await exports.ChannelForms.createTelegramForm("Not An Agent")).toEqual({
      ok: false,
      reason: "invalid_input",
    });

    const form = await exports.ChannelForms.createTelegramForm("late");
    if (!form.ok) throw new Error("form refused");
    await runInDurableObject(store(), (_instance, state) => {
      state.storage.sql.exec("UPDATE forms SET expires_at = 0");
    });
    expect(await exports.ChannelForms.redeemTelegramForm(form.token, BOT_TOKEN)).toEqual({
      ok: false,
      reason: "unknown_form",
    });
  });

  it("stores the token encrypted, and no form token in the clear", async () => {
    botApi();
    const form = await exports.ChannelForms.createTelegramForm("vault");
    if (!form.ok) throw new Error("form refused");
    await exports.ChannelForms.redeemTelegramForm(form.token, BOT_TOKEN);

    const rows = await runInDurableObject(store(), (_instance, state) => ({
      secrets: state.storage.sql.exec("SELECT * FROM secrets").toArray(),
      forms: state.storage.sql.exec("SELECT * FROM forms").toArray(),
    }));
    expect(JSON.stringify(rows)).not.toContain(BOT_TOKEN);
    expect(JSON.stringify(rows)).not.toContain(form.token);
  });
});

describe("ChannelEgress", () => {
  it("sends through the agent's own bot, silently when asked", async () => {
    const calls = botApi();
    await connect("assistant");

    expect(
      await exports.ChannelEgress.send("assistant", destination, "Hi <you>", { silent: true }),
    ).toEqual({ ok: true, providerMessageId: "77" });
    const send = calls.find((call) => call.method === "sendMessage");
    expect(send?.url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
    expect(send?.body).toMatchObject({
      chat_id: "1001",
      text: "Hi &lt;you&gt;",
      disable_notification: true,
    });

    expect(await exports.ChannelEgress.typing("assistant", destination)).toEqual({ ok: true });
  });

  it("says when an agent has no channel connected", async () => {
    botApi();
    expect(await exports.ChannelEgress.send("nobody", destination, "hi")).toEqual({
      ok: false,
      reason: "not_connected",
    });
    expect(await exports.ChannelEgress.typing("nobody", destination)).toEqual({
      ok: false,
      reason: "not_connected",
    });
  });

  it("answers failures as values, with the wait when Telegram asks for one", async () => {
    // Factories, not responses: a body created in the test can't be read inside the Worker's call.
    const answers: Record<string, () => Response> = {};
    botApi((method) => answers[method]?.() ?? defaultAnswer(method));
    await connect("busy");

    answers.sendMessage = () =>
      Response.json(
        { ok: false, error_code: 429, parameters: { retry_after: 3 } },
        { status: 429 },
      );
    expect(await exports.ChannelEgress.send("busy", destination, "hi")).toEqual({
      ok: false,
      reason: "rate_limited",
      retryAfterMs: 3_000,
    });

    answers.sendMessage = () => Response.json({ ok: false, error_code: 403 }, { status: 403 });
    expect(await exports.ChannelEgress.send("busy", destination, "hi")).toEqual({
      ok: false,
      reason: "recipient_unavailable",
    });

    answers.sendMessage = () => Response.json({ ok: false, error_code: 400 }, { status: 400 });
    expect(await exports.ChannelEgress.send("busy", destination, "hi")).toEqual({
      ok: false,
      reason: "failed",
    });
  });

  it("sends nothing when the stored secret was tampered with", async () => {
    const calls = botApi();
    await connect("tampered");
    await runInDurableObject(store(), (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE secrets SET slot = 'telegram:moved' WHERE slot = 'telegram:tampered'",
      );
    });
    // The value now sits under another agent's slot, so it doesn't decrypt there.
    expect(await exports.ChannelEgress.send("moved", destination, "hi")).toEqual({
      ok: false,
      reason: "not_connected",
    });
    expect(calls.filter((call) => call.method === "sendMessage")).toEqual([]);
  });
});
