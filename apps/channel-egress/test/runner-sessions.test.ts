import { createExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { RUNNER_MAX_SESSIONS_BYTES, RUNNER_MAX_WAITS_BYTES } from "@kelpie/channels";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunnerSessions } from "../src/index.ts";
import { listSessions, listWaits, runnerOf } from "../src/runner.ts";
import {
  BROKEN,
  OUTDATED,
  PROTOCOL_1,
  PROTOCOL_2,
  READY,
  type Seen,
  VPS_SESSIONS,
  VPS_WAITS,
} from "./fake-runner.ts";

// The read-only way to the VPS's Claude Code sessions (ADR-0057 §5, #433). vitest.config.ts binds
// RUNNER to the fake in fake-runner.ts, which answers by the secret it gets.

const WRONG = "w".repeat(64);
const store = () => env.SECRET_STORE.getByName("secrets");
const OPENED = VPS_WAITS.waits[0]?.openedAt as number;

async function storeRunnerValue(value: string) {
  const form = await store().createForm("vps", "runner");
  const stored = await store().redeemForm(form.token, value);
  if (!stored.ok) throw new Error("not stored");
}

const storeRunnerSecret = (secret: string) => storeRunnerValue(JSON.stringify({ secret }));

async function seenByRunner(): Promise<Seen[]> {
  const runner = runnerOf(env);
  if (!runner) throw new Error("no runner binding");
  return (await runner.fetch("http://runner/__seen/vps")).json();
}

/** A stand-in for the VPC Service binding, built from what each request gets, and its signal. */
function fetcher(
  answer: (request: Request, signal: AbortSignal | undefined) => Response | Promise<Response>,
): Fetcher {
  return {
    fetch: async (input: RequestInfo, init?: RequestInit) =>
      answer(new Request(input, init), init?.signal ?? undefined),
  } as unknown as Fetcher;
}

const sessionsOn = (runner: Fetcher | undefined) =>
  new RunnerSessions(createExecutionContext(), { ...env, RUNNER: runner } as unknown as Env);

/** A body that never ends, 64 KiB of JSON whitespace each pull. It counts its bytes and its cancel. */
function endless() {
  const state = { sent: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.sent += 64 * 1024;
      controller.enqueue(new Uint8Array(64 * 1024).fill(0x20));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { body, state };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("RunnerSessions", () => {
  it("has only its two reads: whatever binds it can't open forms, read a secret or run a turn", () => {
    expect(
      Object.getOwnPropertyNames(RunnerSessions.prototype).filter((name) => name !== "constructor"),
    ).toEqual(["list", "waits"]);
  });

  it("lists the VPS's sessions, asked with the stored secret, as the runner answered them", async () => {
    await storeRunnerSecret(READY);
    expect(await exports.RunnerSessions.list()).toEqual(VPS_SESSIONS);
    expect((await seenByRunner()).at(-1)).toEqual({
      method: "GET",
      action: "sessions",
      bearer: true,
    });
  });

  it("lists the waits opened since a time", async () => {
    await storeRunnerSecret(READY);
    expect(await exports.RunnerSessions.waits(OPENED)).toEqual(VPS_WAITS);
    expect(await exports.RunnerSessions.waits(OPENED + 1)).toEqual({ ...VPS_WAITS, waits: [] });
    expect((await seenByRunner()).at(-1)).toEqual({
      method: "GET",
      action: "waits",
      bearer: true,
      query: `?since=${OPENED + 1}`,
    });
  });

  it.each([
    ["a negative time", -1],
    ["a fractional time", 1.5],
    ["a time past a safe integer", Number.MAX_SAFE_INTEGER + 1],
    ["text", "0"],
    ["nothing", undefined],
  ])("refuses waits since %s before calling the runner", async (_, since) => {
    await storeRunnerSecret(READY);
    const calls = vi.fn();
    const sessions = sessionsOn(
      fetcher(() => {
        calls();
        return Response.json(VPS_WAITS);
      }),
    );
    expect(await sessions.waits(since as number)).toEqual({ ok: false, reason: "invalid_input" });
    expect(calls).not.toHaveBeenCalled();
  });

  it.each([
    ["refused when the runner refuses the stored secret", WRONG, "refused"],
    ["outdated when the runner speaks protocol 1", PROTOCOL_1, "outdated"],
    [
      "outdated when the runner speaks protocol 2, which has no sessions to list",
      PROTOCOL_2,
      "outdated",
    ],
    ["unreachable when the runner fails", BROKEN, "unreachable"],
  ])("is %s", async (_, secret, reason) => {
    await storeRunnerSecret(secret);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await exports.RunnerSessions.list()).toEqual({ ok: false, reason });
    expect(await exports.RunnerSessions.waits(0)).toEqual({ ok: false, reason });
  });

  it("reads a runner on a newer protocol as long as its answers check out", async () => {
    await storeRunnerSecret(OUTDATED);
    expect(await exports.RunnerSessions.list()).toEqual(VPS_SESSIONS);
  });

  it("is not connected without a stored secret, and calls no runner", async () => {
    await storeRunnerValue("not json");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const calls = vi.fn();
    const sessions = sessionsOn(
      fetcher(() => {
        calls();
        return Response.json(VPS_SESSIONS);
      }),
    );
    const notConnected = { ok: false, reason: "not_connected" };
    expect(await sessions.list()).toEqual(notConnected);
    expect(await sessions.waits(0)).toEqual(notConnected);
    expect(calls).not.toHaveBeenCalled();
  });

  it("is not configured without the runner's binding", async () => {
    await storeRunnerSecret(READY);
    const sessions = sessionsOn(undefined);
    const notConfigured = { ok: false, reason: "not_configured" };
    expect(await sessions.list()).toEqual(notConfigured);
    expect(await sessions.waits(0)).toEqual(notConfigured);
  });

  it("says when the secret store fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const brokenStore = {
      ...env,
      SECRET_STORE: {
        getByName: () => ({
          read: async () => {
            throw new Error("store down");
          },
        }),
      },
    } as unknown as Env;
    const sessions = new RunnerSessions(createExecutionContext(), brokenStore);
    expect(await sessions.list()).toEqual({ ok: false, reason: "store_unavailable" });
  });

  it("never puts the secret in a result or a log", async () => {
    await storeRunnerSecret(READY);
    const logged: unknown[] = [];
    for (const method of ["warn", "error", "log"] as const) {
      vi.spyOn(console, method).mockImplementation((...args) => logged.push(args));
    }
    const results = [
      await exports.RunnerSessions.list(),
      await exports.RunnerSessions.waits(0),
      await listSessions(
        fetcher(() => Response.json({ ok: false, secret: READY })),
        READY,
      ),
      await listWaits(
        fetcher(() => {
          throw new Error(`failed with ${READY}`);
        }),
        READY,
        0,
      ),
    ];
    expect(JSON.stringify(results)).not.toContain(READY);
    expect(JSON.stringify(logged)).not.toContain(READY);
  });
});

describe("listSessions and listWaits", () => {
  it.each([
    ["a server error", () => new Response("boom", { status: 500 })],
    ["text", () => new Response("hello")],
    ["a shape that isn't the protocol's", () => Response.json({ ok: true, sessions: "all" })],
    [
      "a session with a field too many",
      () =>
        Response.json({
          ...VPS_SESSIONS,
          sessions: [{ ...VPS_SESSIONS.sessions[0], cwd: "/home" }],
        }),
    ],
    ["a 404 that isn't the runner's", () => new Response("Not found", { status: 404 })],
    ["a 400", () => Response.json({ ok: false }, { status: 400 })],
    [
      "a redirect",
      () => new Response(null, { status: 302, headers: { location: "https://x.example" } }),
    ],
  ])("are unreachable on %s", async (_, answer) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await listSessions(fetcher(answer), READY)).toEqual({
      ok: false,
      reason: "unreachable",
    });
    expect(await listWaits(fetcher(answer), READY, 0)).toEqual({
      ok: false,
      reason: "unreachable",
    });
  });

  it("read up to 512 KiB of a list, and 64 KiB of waits, then cancel the answer", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const list = endless();
    expect(
      await listSessions(
        fetcher(() => new Response(list.body)),
        READY,
      ),
    ).toEqual({
      ok: false,
      reason: "unreachable",
    });
    expect(list.state.cancelled).toBe(true);
    expect(list.state.sent).toBeLessThanOrEqual(RUNNER_MAX_SESSIONS_BYTES + 3 * 64 * 1024);
    const waits = endless();
    expect(
      await listWaits(
        fetcher(() => new Response(waits.body)),
        READY,
        0,
      ),
    ).toEqual({
      ok: false,
      reason: "unreachable",
    });
    expect(waits.state.cancelled).toBe(true);
    expect(waits.state.sent).toBeLessThanOrEqual(RUNNER_MAX_WAITS_BYTES + 3 * 64 * 1024);
    // Just within its bound, a list is read whole.
    const whole = JSON.stringify(VPS_SESSIONS);
    const fits = `${" ".repeat(RUNNER_MAX_SESSIONS_BYTES - whole.length)}${whole}`;
    expect(
      await listSessions(
        fetcher(() => new Response(fits)),
        READY,
      ),
    ).toEqual(VPS_SESSIONS);
  });

  it("are unreachable when the runner's answer doesn't come within 10 seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const silent = fetcher(
      (_, signal) =>
        new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason))),
    );
    const list = listSessions(silent, READY);
    await vi.advanceTimersByTimeAsync(9_999);
    let settled = false;
    void list.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await list).toEqual({ ok: false, reason: "unreachable" });

    let cancelled = false;
    const stalled = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const waits = listWaits(
      fetcher(() => new Response(stalled)),
      READY,
      0,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await waits).toEqual({ ok: false, reason: "unreachable" });
    expect(cancelled).toBe(true);
  });

  it("ask for the waits since the time given, in the query", async () => {
    const seen: string[] = [];
    const runner = fetcher((request) => {
      seen.push(new URL(request.url).search);
      return Response.json(VPS_WAITS);
    });
    expect(await listWaits(runner, READY, OPENED)).toEqual(VPS_WAITS);
    expect(seen).toEqual([`?since=${OPENED}`]);
  });
});
