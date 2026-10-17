import { createExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { RUNNER_PROTOCOL } from "@kelpie/channels";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelForms } from "../src/index.ts";
import { checkRunner } from "../src/runner.ts";

// vitest.config.ts binds RUNNER to a fake runner whose answer depends on the secret it gets.
const READY = "r".repeat(64);
const OUTDATED = "o".repeat(64);
const BROKEN = "b".repeat(64);
const WRONG = "w".repeat(64);
const store = () => env.SECRET_STORE.getByName("secrets");

/** A stand-in for the VPC Service binding, built from what each request gets. */
function fetcher(answer: (request: Request) => Response | Promise<Response>): Fetcher {
  return {
    fetch: async (input: RequestInfo, init?: RequestInit) => answer(new Request(input, init)),
  } as unknown as Fetcher;
}

/** Stores `secret` as the runner's, without the check a form makes. */
async function storeRunnerSecret(secret: string) {
  const form = await store().createForm("vps", "runner");
  const stored = await store().redeemForm(form.token, JSON.stringify({ secret }));
  if (!stored.ok) throw new Error("not stored");
}

async function runnerForm() {
  const form = await exports.ChannelForms.createRunnerForm();
  if (!form.ok) throw new Error(`form refused: ${form.reason}`);
  return form.token;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("checkRunner", () => {
  it("is ready when the runner answers /health on Kelpie's protocol, given the secret as a bearer token", async () => {
    const seen: Request[] = [];
    const runner = fetcher((request) => {
      seen.push(request);
      return Response.json({ ok: true, version: "0.1.0", protocol: RUNNER_PROTOCOL });
    });
    expect(await checkRunner(runner, READY)).toEqual({
      state: "ready",
      version: "0.1.0",
      protocol: RUNNER_PROTOCOL,
    });
    expect(seen.map((request) => new URL(request.url).pathname)).toEqual(["/health"]);
    expect(seen[0]?.headers.get("authorization")).toBe(`Bearer ${READY}`);
  });

  it("is outdated when the runner speaks another protocol", async () => {
    const runner = fetcher(() =>
      Response.json({ ok: true, version: "9.0.0", protocol: RUNNER_PROTOCOL + 1 }),
    );
    expect(await checkRunner(runner, READY)).toEqual({
      state: "outdated",
      version: "9.0.0",
      protocol: RUNNER_PROTOCOL + 1,
    });
  });

  it("is refused when the runner answers 401", async () => {
    const runner = fetcher(() => Response.json({ ok: false }, { status: 401 }));
    expect(await checkRunner(runner, WRONG)).toEqual({ state: "refused" });
  });

  it.each([
    ["a server error", () => new Response("boom", { status: 500 })],
    ["text", () => new Response("hello")],
    ["another shape", () => Response.json({ ok: true, version: 1, protocol: "1" })],
    ["a version too long", () => Response.json({ ok: true, version: "v".repeat(65), protocol: 1 })],
    ["a version with markup", () => Response.json({ ok: true, version: "<b>1</b>", protocol: 1 })],
    [
      "a redirect",
      () => new Response(null, { status: 302, headers: { location: "https://x.example" } }),
    ],
  ])("is unreachable on %s", async (_, answer) => {
    expect(await checkRunner(fetcher(answer), READY)).toEqual({ state: "unreachable" });
  });

  it("reads at most 4 KiB of the runner's health, then cancels it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = { pulls: 0, cancelled: false };
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        state.pulls += 1;
        controller.enqueue(new TextEncoder().encode(" ".repeat(1_024)));
      },
      cancel() {
        state.cancelled = true;
      },
    });
    expect(
      await checkRunner(
        fetcher(() => new Response(body)),
        READY,
      ),
    ).toEqual({
      state: "unreachable",
    });
    expect(state).toEqual({ pulls: expect.any(Number), cancelled: true });
    expect(state.pulls).toBeLessThanOrEqual(6);
  });

  it("is unreachable when its health's body stalls past 5 seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const check = checkRunner(
      fetcher(() => new Response(body)),
      READY,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await check).toEqual({ state: "unreachable" });
    expect(cancelled).toBe(true);
  });

  it("is unreachable when the call fails", async () => {
    const runner = fetcher(() => {
      throw new Error("connection refused");
    });
    expect(await checkRunner(runner, READY)).toEqual({ state: "unreachable" });
  });
});

describe("the runner's secure form", () => {
  it("stores a secret the runner accepts, and the runner then reads as ready", async () => {
    const token = await runnerForm();
    expect(await exports.ChannelForms.describeForm(token)).toEqual({
      ok: true,
      agentId: "vps",
      kind: "runner",
    });
    const ready = { state: "ready", version: "0.1.0", protocol: RUNNER_PROTOCOL };
    expect(await exports.ChannelForms.redeemRunnerForm(token, `  ${READY}\n`)).toEqual({
      ok: true,
      runner: ready,
    });
    expect(await exports.ChannelForms.describeRunner()).toEqual({ ok: true, runner: ready });
  });

  it("answers a double click with the same result, and any other value as a closed form", async () => {
    const token = await runnerForm();
    const first = await exports.ChannelForms.redeemRunnerForm(token, READY);
    expect(first.ok).toBe(true);
    expect(await exports.ChannelForms.redeemRunnerForm(token, READY)).toEqual(first);
    expect(await exports.ChannelForms.redeemRunnerForm(token, OUTDATED)).toEqual({
      ok: false,
      reason: "unknown_form",
    });
  });

  it.each([
    ["refuses", WRONG, "secret_refused"],
    ["can't answer", BROKEN, "unreachable"],
  ])(
    "answers a form's own secret sent again as the runner now does, when it %s",
    async (_, secret, reason) => {
      // Stored without the form's check, as if the runner changed after the first submission.
      const form = await store().createForm("vps", "runner");
      await store().redeemForm(form.token, JSON.stringify({ secret }));
      expect(await exports.ChannelForms.redeemRunnerForm(form.token, secret)).toEqual({
        ok: false,
        reason,
      });
    },
  );

  it("stores an outdated runner's secret, and says so", async () => {
    const token = await runnerForm();
    expect(await exports.ChannelForms.redeemRunnerForm(token, OUTDATED)).toEqual({
      ok: true,
      runner: { state: "outdated", version: "0.0.9", protocol: RUNNER_PROTOCOL + 1 },
    });
  });

  it("refuses a secret the runner refuses, and keeps the form open for another try", async () => {
    const token = await runnerForm();
    expect(await exports.ChannelForms.redeemRunnerForm(token, WRONG)).toEqual({
      ok: false,
      reason: "secret_refused",
    });
    expect((await exports.ChannelForms.describeForm(token)).ok).toBe(true);
    expect((await exports.ChannelForms.redeemRunnerForm(token, READY)).ok).toBe(true);
  });

  it.each([
    ["too short", "x".repeat(31)],
    ["with a space inside", `${"x".repeat(20)} ${"x".repeat(20)}`],
    ["empty", ""],
  ])("refuses a secret %s without calling the runner", async (_, secret) => {
    const token = await runnerForm();
    expect(await exports.ChannelForms.redeemRunnerForm(token, secret)).toEqual({
      ok: false,
      reason: "invalid_secret",
    });
  });

  it("closes after a few refused values", async () => {
    const token = await runnerForm();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await exports.ChannelForms.redeemRunnerForm(token, WRONG);
    }
    expect(await exports.ChannelForms.describeForm(token)).toEqual({
      ok: false,
      reason: "unknown_form",
    });
  });

  it("leaves the form open, without counting the attempt, when the runner can't answer", async () => {
    const token = await runnerForm();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      expect(await exports.ChannelForms.redeemRunnerForm(token, BROKEN)).toEqual({
        ok: false,
        reason: "unreachable",
      });
    }
    expect((await exports.ChannelForms.redeemRunnerForm(token, READY)).ok).toBe(true);
  });

  it("takes no runner secret on a Telegram form, and no bot token on a runner form", async () => {
    const telegram = await exports.ChannelForms.createTelegramForm("sales");
    if (!telegram.ok) throw new Error("form refused");
    expect(await exports.ChannelForms.redeemRunnerForm(telegram.token, READY)).toEqual({
      ok: false,
      reason: "unknown_form",
    });
    const runner = await runnerForm();
    expect(
      await exports.ChannelForms.redeemTelegramForm(
        runner,
        "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw-test",
      ),
    ).toEqual({ ok: false, reason: "unknown_form" });
  });
});

describe("the configuration tools' entrypoint", () => {
  it("opens the runner's form, which the admin API then serves, and reads the runner's state", async () => {
    const form = await exports.SetupForms.createRunnerForm();
    if (!form.ok) throw new Error(`form refused: ${form.reason}`);
    expect(await exports.ChannelForms.describeForm(form.token)).toEqual({
      ok: true,
      agentId: "vps",
      kind: "runner",
    });
    await storeRunnerSecret(READY);
    expect(await exports.SetupForms.describeRunner()).toEqual({
      ok: true,
      runner: { state: "ready", version: "0.1.0", protocol: RUNNER_PROTOCOL },
    });
  });
});

describe("without the runner's binding", () => {
  // As channel-egress is deployed when the instance has no RUNNER_VPC_SERVICE_ID (#294).
  const unbound = () =>
    new ChannelForms(createExecutionContext(), { ...env, RUNNER: undefined } as unknown as Env);

  it("opens no form, takes no secret, and reads as not configured", async () => {
    const forms = unbound();
    expect(await forms.createRunnerForm()).toEqual({ ok: false, reason: "not_configured" });
    const token = await runnerForm();
    expect(await forms.redeemRunnerForm(token, READY)).toEqual({
      ok: false,
      reason: "not_configured",
    });
    expect(await forms.describeRunner()).toEqual({
      ok: true,
      runner: { state: "not_configured" },
    });
  });
});

describe("describeRunner", () => {
  it("says when the stored secret is refused", async () => {
    await storeRunnerSecret(WRONG);
    expect(await exports.ChannelForms.describeRunner()).toEqual({
      ok: true,
      runner: { state: "refused" },
    });
  });

  it("says when the runner can't answer", async () => {
    await storeRunnerSecret(BROKEN);
    expect(await exports.ChannelForms.describeRunner()).toEqual({
      ok: true,
      runner: { state: "unreachable" },
    });
  });

  it("reads a stored value that isn't a secret as no secret", async () => {
    const form = await store().createForm("vps", "runner");
    await store().redeemForm(form.token, "not json");
    expect(await exports.ChannelForms.describeRunner()).toEqual({
      ok: true,
      runner: { state: "not_connected" },
    });
  });
});
