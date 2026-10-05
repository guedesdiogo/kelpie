import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

// The Worker runs in the test's isolate, so a stubbed global fetch stands in for the Bot API. It
// builds a Request from each call first, so the runtime checks the options production sends.

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
    new Request(input, init);
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

describe("channel-egress under pressure", () => {
  it("stores once when the same link is submitted twice at the same time", async () => {
    botApi();
    const form = await exports.ChannelForms.createTelegramForm("twice");
    if (!form.ok) throw new Error("form refused");
    const results = await Promise.all([
      exports.ChannelForms.redeemTelegramForm(form.token, BOT_TOKEN),
      exports.ChannelForms.redeemTelegramForm(form.token, BOT_TOKEN),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results).toContainEqual({ ok: false, reason: "unknown_form" });
    const rows = await runInDurableObject(store(), (_instance, state) =>
      state.storage.sql.exec("SELECT slot FROM secrets WHERE slot = 'telegram:twice'").toArray(),
    );
    expect(rows).toHaveLength(1);
  });

  it("refuses hostile tokens before calling Telegram, and closes the form after five", async () => {
    const calls = botApi();
    const form = await exports.ChannelForms.createTelegramForm("hostile");
    if (!form.ok) throw new Error("form refused");
    const secretPart = "a".repeat(30);
    for (const hostile of [
      `123456789:${secretPart}/../getUpdates`,
      `123456789:${secretPart}?x=1`,
      `123456789:${secretPart}#`,
      `123456789@evil.example:${secretPart}`,
      `123456789:${"b".repeat(10_000)}`,
    ]) {
      expect(await exports.ChannelForms.redeemTelegramForm(form.token, hostile)).toEqual({
        ok: false,
        reason: "invalid_token",
      });
    }
    expect(calls).toEqual([]);
    // Five refusals: the link no longer works, even with the right token.
    expect(await exports.ChannelForms.describeForm(form.token)).toEqual({
      ok: false,
      reason: "unknown_form",
    });
  });

  it("logs no token, form token or URL when Telegram refuses or a send fails", async () => {
    const logged: unknown[][] = [];
    for (const level of ["log", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((...args) => {
        logged.push(args);
      });
    }
    const answers: Record<string, () => Response> = {};
    botApi((method) => answers[method]?.() ?? defaultAnswer(method));
    await connect("quiet");

    answers.sendMessage = () => Response.json({ ok: false, error_code: 500 }, { status: 500 });
    await exports.ChannelEgress.send("quiet", destination, "hi");

    answers.getMe = () => Response.json({ ok: false, error_code: 401 }, { status: 401 });
    const form = await exports.ChannelForms.createTelegramForm("quiet-two");
    if (!form.ok) throw new Error("form refused");
    await exports.ChannelForms.redeemTelegramForm(form.token, BOT_TOKEN);

    const text = JSON.stringify(logged);
    expect(logged.length).toBeGreaterThan(0);
    expect(text).not.toContain(BOT_TOKEN);
    expect(text).not.toContain(form.token);
    expect(text).not.toContain("api.telegram.org");
  });

  it("sends nothing when the stored ciphertext was altered", async () => {
    const calls = botApi();
    await connect("altered");
    await runInDurableObject(store(), (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE secrets SET ciphertext = 'AAAA' || substr(ciphertext, 5) WHERE slot = 'telegram:altered'",
      );
    });
    expect(await exports.ChannelEgress.send("altered", destination, "hi")).toEqual({
      ok: false,
      reason: "not_connected",
    });
    expect(calls.filter((call) => call.method === "sendMessage")).toEqual([]);
  });

  it("refuses text past Telegram's limit and malformed destinations without reading secrets", async () => {
    const calls = botApi();
    await connect("bounded");
    const before = calls.length;
    expect(await exports.ChannelEgress.send("bounded", destination, "x".repeat(4_097))).toEqual({
      ok: false,
      reason: "failed",
    });
    expect(
      await exports.ChannelEgress.send("bounded", { channel: "telegram", threadId: "" }, "hi"),
    ).toEqual({ ok: false, reason: "failed" });
    expect(calls.length).toBe(before);
  });
});

describe("SecretStore without its key", () => {
  it("stays closed while the key is missing, and opens once it is set", async () => {
    const closed = env.SECRET_STORE.getByName("closed-store");
    const results = await runInDurableObject(closed, async (instance) => {
      const configurable = instance as unknown as { env: Env };
      const goodKey = configurable.env.SECRETS_KEY;
      configurable.env = { ...configurable.env, SECRETS_KEY: "" };
      const form = await instance.createForm("closed", "telegram");
      const whileClosed = {
        ready: await instance.ready(),
        read: await instance.read("telegram", "closed"),
        redeem: await instance.redeemForm(form.token, "value"),
      };
      // The failed import isn't kept: a corrected key is picked up.
      configurable.env = { ...configurable.env, SECRETS_KEY: goodKey };
      return { whileClosed, readyAfter: await instance.ready() };
    });
    expect(results.whileClosed).toEqual({
      ready: false,
      read: { ok: false, reason: "store_unavailable" },
      redeem: { ok: false, reason: "store_unavailable" },
    });
    expect(results.readyAfter).toBe(true);
  });
});
