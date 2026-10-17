import { createExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import type { RunnerToolResult, RunnerTurnRequest } from "@kelpie/channels";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunnerChat } from "../src/index.ts";
import { closeSession, giveResult, runnerOf, startTurn, turnBody } from "../src/runner.ts";
import { BROKEN, PROTOCOL_1, READY, type Seen, TURN_BYTES } from "./fake-runner.ts";

// The `claude-code` route's way to the runner (#420). vitest.config.ts binds RUNNER to the fake in
// fake-runner.ts, which answers a turn by its conversation's name.

const WRONG = "w".repeat(64);
const store = () => env.SECRET_STORE.getByName("secrets");

function turnRequest(overrides: Partial<RunnerTurnRequest> = {}): RunnerTurnRequest {
  return {
    conversation: "reply",
    resume: false,
    model: "claude-haiku-5-5",
    system: "You are Kelpie.",
    tools: [
      {
        name: "memory_search",
        description: "Searches memory.",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
      },
    ],
    messages: [{ role: "user", parts: [{ type: "text", text: "Where does Ana live?" }] }],
    toolLoopMs: 120_000,
    ...overrides,
  };
}

const RESULT: RunnerToolResult = { callId: "toolu_01", output: "Ana lives in Porto." };

/** Stores `value` in the runner's slot, without the check a form makes. */
async function storeRunnerValue(value: string) {
  const form = await store().createForm("vps", "runner");
  const stored = await store().redeemForm(form.token, value);
  if (!stored.ok) throw new Error("not stored");
}

const storeRunnerSecret = (secret: string) => storeRunnerValue(JSON.stringify({ secret }));

/** What the fake runner saw for a session. */
async function seenBy(sessionId: string): Promise<Seen[]> {
  const runner = runnerOf(env);
  if (!runner) throw new Error("no runner binding");
  return (await runner.fetch(`http://runner/__seen/${sessionId}`)).json();
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

const ndjson = (body: BodyInit) =>
  new Response(body, { headers: { "content-type": "application/x-ndjson" } });

/** A stand-in for the VPC Service binding, built from what each request gets, and its signal. */
function fetcher(
  answer: (request: Request, signal: AbortSignal | undefined) => Response | Promise<Response>,
): Fetcher {
  return {
    fetch: async (input: RequestInfo, init?: RequestInit) =>
      answer(new Request(input, init), init?.signal ?? undefined),
  } as unknown as Fetcher;
}

/** A stand-in that keeps each request it gets in `seen`, then answers it. */
function recording(answer: () => Response): { runner: Fetcher; seen: Request[] } {
  const seen: Request[] = [];
  const runner = fetcher((request) => {
    seen.push(request);
    return answer();
  });
  return { runner, seen };
}

/**
 * Has the bound runner, the one the entrypoint uses, answer a turn with a `ping`, then nothing,
 * as while a tool runs. It says whether the request was aborted, and its response cancelled.
 */
function hangingRunner(): { aborted: boolean; cancelled: boolean } {
  const seen = { aborted: false, cancelled: false };
  vi.spyOn(runnerOf(env) as Fetcher, "fetch").mockImplementation(async (_, init) => {
    init?.signal?.addEventListener("abort", () => {
      seen.aborted = true;
    });
    return ndjson(
      new ReadableStream({
        start: (controller) => controller.enqueue(new TextEncoder().encode('{"type":"ping"}\n')),
        cancel: () => {
          seen.cancelled = true;
        },
      }),
    );
  });
  return seen;
}

/** A RunnerChat on `runner`, called directly rather than over RPC. */
const chatOn = (runner: Fetcher | undefined) =>
  new RunnerChat(createExecutionContext(), { ...env, RUNNER: runner } as unknown as Env);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("RunnerChat", () => {
  it("has only the runner's three calls: whatever binds it can't open forms or read a secret", () => {
    expect(
      Object.getOwnPropertyNames(RunnerChat.prototype).filter((name) => name !== "constructor"),
    ).toEqual(["turn", "answer", "close"]);
  });

  it("relays a turn's stream byte for byte, pings included, sent with the stored secret", async () => {
    await storeRunnerSecret(READY);
    const id = crypto.randomUUID();
    const started = await exports.RunnerChat.turn(id, turnRequest());
    if (!started.ok) throw new Error(`turn refused: ${started.reason}`);
    using turn = started.turn;
    expect(await readAll(await turn.events())).toEqual(TURN_BYTES);
    expect(await seenBy(id)).toEqual([
      { method: "POST", action: "turns", bearer: true, body: turnRequest() },
    ]);
  });

  it("aborts the runner's request on cancel, and the stream then ends without a finish", async () => {
    await storeRunnerSecret(READY);
    const runner = hangingRunner();
    const started = await exports.RunnerChat.turn(crypto.randomUUID(), turnRequest());
    if (!started.ok) throw new Error(`turn refused: ${started.reason}`);
    using turn = started.turn;
    const reader = (await turn.events()).getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('{"type":"ping"}\n');
    expect(runner).toEqual({ aborted: false, cancelled: false });

    await turn.cancel();
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(runner).toEqual({ aborted: true, cancelled: true });
    await turn.cancel();
  });

  it("aborts the runner's request when the caller drops its stub without cancelling", async () => {
    await storeRunnerSecret(READY);
    const runner = hangingRunner();
    const started = await exports.RunnerChat.turn(crypto.randomUUID(), turnRequest());
    if (!started.ok) throw new Error(`turn refused: ${started.reason}`);
    {
      using turn = started.turn;
      await (await turn.events()).getReader().read();
    }
    await vi.waitFor(() => expect(runner).toEqual({ aborted: true, cancelled: true }));
  });

  it("gives a call's result to the session, and says when no call waits for it", async () => {
    await storeRunnerSecret(READY);
    const id = crypto.randomUUID();
    expect(await exports.RunnerChat.answer(id, RESULT)).toEqual({ ok: true });
    const late = { callId: "toolu_02", output: "", isError: true };
    expect(await exports.RunnerChat.answer(id, late)).toEqual({
      ok: false,
      reason: "unknown_call",
    });
    expect(await seenBy(id)).toEqual([
      { method: "POST", action: "tool-results", bearer: true, body: RESULT },
      { method: "POST", action: "tool-results", bearer: true, body: late },
    ]);
  });

  it("closes a session", async () => {
    await storeRunnerSecret(READY);
    const id = crypto.randomUUID();
    expect(await exports.RunnerChat.close(id)).toEqual({ ok: true });
    expect(await seenBy(id)).toEqual([{ method: "DELETE", action: "close", bearer: true }]);
  });

  it.each(["lost", "unfinished", "mismatched"])(
    "says a session can't take the turn when the runner answers 409 %s",
    async (reason) => {
      await storeRunnerSecret(READY);
      const started = await exports.RunnerChat.turn(
        crypto.randomUUID(),
        turnRequest({ conversation: reason }),
      );
      expect(started).toEqual({ ok: false, reason });
    },
  );

  it("keeps the runner's own capacity, 503 full and 429 rate, apart from a Claude limit", async () => {
    await storeRunnerSecret(READY);
    const turn = (conversation: string) =>
      exports.RunnerChat.turn(crypto.randomUUID(), turnRequest({ conversation }));
    expect(await turn("full")).toEqual({ ok: false, reason: "full" });
    expect(await turn("rate")).toEqual({ ok: false, reason: "rate", retryAfterMs: 7_000 });
  });

  it.each([
    ["refused when the runner refuses the stored secret", WRONG, "refused"],
    ["outdated when the runner speaks protocol 1, which has no sessions", PROTOCOL_1, "outdated"],
    ["unreachable when the runner fails", BROKEN, "unreachable"],
  ])("is %s", async (_, secret, reason) => {
    await storeRunnerSecret(secret);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = crypto.randomUUID();
    expect(await exports.RunnerChat.turn(id, turnRequest())).toEqual({ ok: false, reason });
    expect(await exports.RunnerChat.answer(id, RESULT)).toEqual({ ok: false, reason });
    expect(await exports.RunnerChat.close(id)).toEqual({ ok: false, reason });
  });

  it("is not connected without a stored secret, and calls no runner", async () => {
    await storeRunnerValue("not json");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { runner, seen: calls } = recording(() => Response.json({ ok: true }));
    const chat = chatOn(runner);
    const id = crypto.randomUUID();
    const notConnected = { ok: false, reason: "not_connected" };
    expect(await chat.turn(id, turnRequest())).toEqual(notConnected);
    expect(await chat.answer(id, RESULT)).toEqual(notConnected);
    expect(await chat.close(id)).toEqual(notConnected);
    expect(calls).toEqual([]);
  });

  it("is not configured without the runner's binding", async () => {
    await storeRunnerSecret(READY);
    const chat = chatOn(undefined);
    const id = crypto.randomUUID();
    const notConfigured = { ok: false, reason: "not_configured" };
    expect(await chat.turn(id, turnRequest())).toEqual(notConfigured);
    expect(await chat.answer(id, RESULT)).toEqual(notConfigured);
    expect(await chat.close(id)).toEqual(notConfigured);
  });
});

describe("RunnerChat's input checks", () => {
  const invalid = { ok: false, reason: "invalid_input" };
  const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

  it.each([
    ["an uppercase UUID", id.toUpperCase()],
    ["another path", "../health"],
    ["a path under the session", `${id}/turns`],
    ["a query", `${id}?x=1`],
    ["an empty id", ""],
    ["a number", 42],
    ["nothing", undefined],
  ])("refuses %s as the session, over RPC, before the runner", async (_, sessionId) => {
    await storeRunnerSecret(READY);
    const session = sessionId as string;
    expect(await exports.RunnerChat.turn(session, turnRequest())).toEqual(invalid);
    expect(await exports.RunnerChat.answer(session, RESULT)).toEqual(invalid);
    expect(await exports.RunnerChat.close(session)).toEqual(invalid);
  });

  it.each([
    ["an extra field", { ...turnRequest(), effort: "high" }],
    ["no messages", turnRequest({ messages: [] })],
    [
      "an empty text",
      turnRequest({ messages: [{ role: "user", parts: [{ type: "text", text: "" }] }] }),
    ],
    ["a tool loop over an hour", turnRequest({ toolLoopMs: 3_600_001 })],
    [
      // Each part is within its bounds; together they pass the runner's 8 MiB.
      "a body over 8 MiB",
      turnRequest({
        messages: Array.from({ length: 1_000 }, () => ({
          role: "user" as const,
          parts: [{ type: "text" as const, text: "x".repeat(9_000) }],
        })),
      }),
    ],
    ["a list", []],
  ])("refuses a turn with %s, before the runner", async (_, request) => {
    await storeRunnerSecret(READY);
    const { runner, seen: calls } = recording(() => new Response(null));
    const chat = chatOn(runner);
    expect(await chat.turn(id, request as RunnerTurnRequest)).toEqual(invalid);
    expect(calls).toEqual([]);
  });

  it("takes a body just under 8 MiB", () => {
    const text = "x".repeat(8_000);
    const request = turnRequest({
      messages: Array.from({ length: 1_000 }, () => ({
        role: "user" as const,
        parts: [{ type: "text" as const, text }],
      })),
    });
    expect(turnBody(id, request)?.byteLength).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  it.each([
    ["an extra field", { ...RESULT, name: "memory_search" }],
    ["an empty call id", { ...RESULT, callId: "" }],
    ["an output over 20,000 characters", { ...RESULT, output: "x".repeat(20_001) }],
    ["an error mark that isn't a boolean", { ...RESULT, isError: "yes" }],
    ["null", null],
  ])("refuses a result with %s, before the runner", async (_, result) => {
    await storeRunnerSecret(READY);
    const { runner, seen: calls } = recording(() => new Response(null));
    const chat = chatOn(runner);
    expect(await chat.answer(id, result as RunnerToolResult)).toEqual(invalid);
    expect(calls).toEqual([]);
  });
});

describe("the runner's answers", () => {
  const id = "11111111-2222-4333-8444-555555555555";
  const body = () => turnBody(id, turnRequest()) as Uint8Array;
  const unreachable = { ok: false, reason: "unreachable" };

  it("sends a turn to its session's path, as JSON, with the secret as a bearer token", async () => {
    const { runner, seen } = recording(() => ndjson('{"type":"ping"}\n'));
    const started = await startTurn(runner, READY, id, body());
    expect(started.ok).toBe(true);
    const [request] = seen;
    expect(request?.method).toBe("POST");
    expect(new URL(request?.url ?? "").pathname).toBe(`/sessions/${id}/turns`);
    expect(request?.headers.get("authorization")).toBe(`Bearer ${READY}`);
    expect(request?.headers.get("content-type")).toBe("application/json");
    expect(await request?.json()).toEqual(turnRequest());
  });

  it.each([
    ["a 200 that isn't NDJSON", () => new Response("<html>")],
    ["a 503 that isn't the runner's full", () => new Response("Bad gateway", { status: 503 })],
    ["a 429 that isn't the runner's rate", () => new Response("Slow down", { status: 429 })],
    ["a 409 with another reason", () => Response.json({ ok: false, reason: "x" }, { status: 409 })],
    ["a 404 that isn't the runner's", () => new Response("Not found", { status: 404 })],
    ["a 400", () => Response.json({ ok: false }, { status: 400 })],
    ["a 413", () => Response.json({ ok: false }, { status: 413 })],
    [
      "a redirect",
      () => new Response(null, { status: 302, headers: { location: "https://x.example" } }),
    ],
  ])("reads %s as an unreachable runner, never as a limit", async (_, answer) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await startTurn(fetcher(answer), READY, id, body())).toEqual(unreachable);
  });

  it("waits a minute after a 429 whose Retry-After it can't read", async () => {
    for (const retryAfter of [null, "soon", "-1", "99999"]) {
      const runner = fetcher(() =>
        Response.json(
          { ok: false, reason: "rate" },
          { status: 429, headers: retryAfter === null ? {} : { "retry-after": retryAfter } },
        ),
      );
      expect(await startTurn(runner, READY, id, body())).toEqual({
        ok: false,
        reason: "rate",
        retryAfterMs: 60_000,
      });
    }
  });

  it("gives up on a turn whose stream doesn't begin within 15 seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const runner = fetcher(
      (_, signal) =>
        new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason))),
    );
    const started = startTurn(runner, READY, id, body());
    await vi.advanceTimersByTimeAsync(14_999);
    let settled = false;
    void started.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await started).toEqual(unreachable);
  });

  it("doesn't bound a stream that began: a quiet turn goes on past the start's 15 seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let push: (text: string) => void = () => {};
    const runner = fetcher(() =>
      ndjson(
        new ReadableStream({
          start(controller) {
            push = (text) => {
              controller.enqueue(new TextEncoder().encode(text));
              controller.close();
            };
          },
        }),
      ),
    );
    const started = await startTurn(runner, READY, id, body());
    if (!started.ok) throw new Error(`turn refused: ${started.reason}`);
    await vi.advanceTimersByTimeAsync(60_000);
    push('{"type":"ping"}\n');
    expect(new TextDecoder().decode(await readAll(started.turn.events()))).toBe(
      '{"type":"ping"}\n',
    );
  });

  it("cancels the runner's response when the turn is cancelled, even if the binding ignores the abort", async () => {
    let cancelled = false;
    const runner = fetcher(() =>
      ndjson(
        new ReadableStream({
          cancel: () => {
            cancelled = true;
          },
        }),
      ),
    );
    const started = await startTurn(runner, READY, id, body());
    if (!started.ok) throw new Error(`turn refused: ${started.reason}`);
    const reader = started.turn.events().getReader();
    const read = reader.read();
    started.turn[Symbol.dispose]();
    expect((await read).done).toBe(true);
    expect(cancelled).toBe(true);
  });

  it("ends the stream, without a finish, when the runner's connection drops", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runner = fetcher(() =>
      ndjson(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"type":"ping"}\n'));
          },
          pull() {
            throw new TypeError("Network connection lost.");
          },
        }),
      ),
    );
    const started = await startTurn(runner, READY, id, body());
    if (!started.ok) throw new Error(`turn refused: ${started.reason}`);
    expect(new TextDecoder().decode(await readAll(started.turn.events()))).toBe(
      '{"type":"ping"}\n',
    );
    expect(warn).toHaveBeenCalledWith(
      "channel-egress: the runner's turn stream failed",
      "TypeError",
    );
  });

  it("sends a result and a close to the session's paths", async () => {
    const { runner, seen } = recording(() => Response.json({ ok: true }));
    expect(await giveResult(runner, READY, id, RESULT)).toEqual({ ok: true });
    expect(await closeSession(runner, READY, id)).toEqual({ ok: true });
    expect(seen.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ["POST", `/sessions/${id}/tool-results`],
      ["DELETE", `/sessions/${id}`],
    ]);
    expect(
      seen.every((request) => request.headers.get("authorization") === `Bearer ${READY}`),
    ).toBe(true);
    expect(await seen[0]?.json()).toEqual(RESULT);
  });

  it.each([
    ["a 200 that isn't the runner's", () => new Response("ok")],
    ["a 409 to a close", () => Response.json({ ok: false }, { status: 409 })],
    ["a 500", () => new Response("boom", { status: 500 })],
  ])("reads %s to a result or a close as an unreachable runner", async (name, answer) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    if (!name.includes("close")) {
      expect(await giveResult(fetcher(answer), READY, id, RESULT)).toEqual(unreachable);
    }
    expect(await closeSession(fetcher(answer), READY, id)).toEqual(unreachable);
  });

  it("never puts the secret in a result, an error or a log", async () => {
    const logged: unknown[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args) => logged.push(...args));
    }
    // A failure whose message quotes the request, header included.
    const quoting = fetcher((request) => {
      throw new Error(`failed: ${request.headers.get("authorization")}`);
    });
    const results: unknown[] = [
      await startTurn(quoting, READY, id, body()),
      await giveResult(quoting, READY, id, RESULT),
      await closeSession(quoting, READY, id),
      await startTurn(
        fetcher(() => new Response(READY, { status: 500 })),
        READY,
        id,
        body(),
      ),
    ];
    // A stream that fails on its own, its error quoting the secret.
    const failing = fetcher(() =>
      ndjson(
        new ReadableStream({
          start: (controller) => controller.error(new Error(`lost: Bearer ${READY}`)),
        }),
      ),
    );
    const dropped = await startTurn(failing, READY, id, body());
    if (!dropped.ok) throw new Error(`turn refused: ${dropped.reason}`);
    results.push(new TextDecoder().decode(await readAll(dropped.turn.events())));

    expect(logged.length).toBeGreaterThan(0);
    for (const value of [...results, ...logged]) {
      expect(JSON.stringify(value) ?? String(value)).not.toContain(READY);
      expect(String(value)).not.toContain(READY);
    }
  });
});
