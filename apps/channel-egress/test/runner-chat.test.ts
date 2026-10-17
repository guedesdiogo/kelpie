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

/** A body that never ends: 1 KiB each pull. It counts its pulls, and says when it is cancelled. */
function endless() {
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
  return { body, state };
}

/** A body that never sends a byte, and says when it is cancelled. */
function stalled() {
  const state = { cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      state.cancelled = true;
    },
  });
  return { body, state };
}

/** A stand-in that waits until its request is aborted, as a runner that never answers. */
const silent = () =>
  fetcher(
    (_, signal) =>
      new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason))),
  );

/** Whether `promise` has settled, without waiting for it. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  await Promise.resolve();
  await Promise.resolve();
  return done;
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

  it("takes at most 4 turns in flight, answers full past them before the runner, and frees a place when one ends", async () => {
    await storeRunnerSecret(READY);
    hangingRunner();
    const fetch = vi.mocked((runnerOf(env) as Fetcher).fetch);
    const start = async () => {
      const started = await exports.RunnerChat.turn(crypto.randomUUID(), turnRequest());
      if (!started.ok) throw new Error(`turn refused: ${started.reason}`);
      return started;
    };
    const started = [await start(), await start(), await start(), await start()];
    const full = { ok: false, reason: "full" };
    expect(await exports.RunnerChat.turn(crypto.randomUUID(), turnRequest())).toEqual(full);
    expect(fetch).toHaveBeenCalledTimes(4);

    // A cancel frees a place, and so does a stub dropped without one once its stream was taken.
    // workerd doesn't always tell a target that a stub never called was dropped.
    await started[0]?.turn.cancel();
    started.push(await start());
    {
      using dropped = started[1]?.turn;
      await dropped?.events();
    }
    await vi.waitFor(async () => started.push(await start()));
    expect(await exports.RunnerChat.turn(crypto.randomUUID(), turnRequest())).toEqual(full);
    for (const turn of started.slice(2)) await turn.turn.cancel();
  });

  it("frees the place of a turn that finishes, drops, is refused or never starts", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await storeRunnerSecret(READY);
    for (let i = 0; i < 5; i += 1) {
      const finished = await exports.RunnerChat.turn(crypto.randomUUID(), turnRequest());
      if (!finished.ok) throw new Error(`turn refused: ${finished.reason}`);
      await readAll(await finished.turn.events());
      const refused = turnRequest({ conversation: "lost" });
      expect(await exports.RunnerChat.turn(crypto.randomUUID(), refused)).toMatchObject({
        reason: "lost",
      });
      expect(
        await exports.RunnerChat.turn(crypto.randomUUID(), turnRequest({ messages: [] })),
      ).toMatchObject({ reason: "invalid_input" });
    }
    await storeRunnerValue("not json");
    for (let i = 0; i < 5; i += 1) {
      expect(await exports.RunnerChat.turn(crypto.randomUUID(), turnRequest())).toMatchObject({
        reason: "not_connected",
      });
    }
    await storeRunnerSecret(READY);
    vi.spyOn(runnerOf(env) as Fetcher, "fetch").mockImplementation(async () =>
      ndjson(
        new ReadableStream({
          pull() {
            throw new TypeError("Network connection lost.");
          },
        }),
      ),
    );
    for (let i = 0; i < 5; i += 1) {
      const dropped = await exports.RunnerChat.turn(crypto.randomUUID(), turnRequest());
      if (!dropped.ok) throw new Error(`turn refused: ${dropped.reason}`);
      expect((await readAll(await dropped.turn.events())).byteLength).toBe(0);
    }
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

  it("refuses a turn whose text alone passes 8 MiB, before encoding it", async () => {
    await storeRunnerSecret(READY);
    const stringify = vi.spyOn(JSON, "stringify");
    const request = turnRequest({
      messages: Array.from({ length: 1_000 }, () => ({
        role: "user" as const,
        parts: [{ type: "text" as const, text: "x".repeat(9_000) }],
      })),
    });
    expect(turnBody(id, request)).toBeNull();
    expect(stringify).not.toHaveBeenCalled();
  });

  it.each([
    ["a BigInt", { type: "object", default: 1n }],
    [
      "a cycle",
      (() => {
        const schema: Record<string, unknown> = { type: "object" };
        schema.properties = { self: schema };
        return schema;
      })(),
    ],
  ])(
    "refuses a turn whose tool schema holds %s, which JSON can't carry",
    async (_, inputSchema) => {
      await storeRunnerSecret(READY);
      const { runner, seen: calls } = recording(() => new Response(null));
      const request = turnRequest({
        tools: [{ name: "t", description: "d", inputSchema: inputSchema as { type: "object" } }],
      });
      expect(await chatOn(runner).turn(id, request)).toEqual(invalid);
      expect(calls).toEqual([]);
    },
  );

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

  it("keeps the runner's Retry-After between 1 and 300 seconds", async () => {
    for (const [retryAfter, ms] of [
      ["0", 1_000],
      ["7", 7_000],
      ["300", 300_000],
      ["301", 300_000],
      ["99999999999999999999", 300_000],
    ] as const) {
      const runner = fetcher(() =>
        Response.json(
          { ok: false, reason: "rate" },
          { status: 429, headers: { "retry-after": retryAfter } },
        ),
      );
      expect(await startTurn(runner, READY, id, body())).toEqual({
        ok: false,
        reason: "rate",
        retryAfterMs: ms,
      });
    }
  });

  it("waits a minute after a 429 whose Retry-After it can't read", async () => {
    for (const retryAfter of [null, "soon", "-1", "1.5"]) {
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
    const started = startTurn(silent(), READY, id, body());
    await vi.advanceTimersByTimeAsync(14_999);
    expect(await settled(started)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await started).toEqual(unreachable);
  });

  it("doesn't time a stream no one reads: a turn read late goes on past any bound", async () => {
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

  it("ends a turn whose runner sends nothing for 60 s while it is read, and aborts its request", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let signal: AbortSignal | undefined;
    let push: (text: string) => void = () => {};
    const quiet = stalled();
    const runner = fetcher((_, given) => {
      signal = given;
      return ndjson(
        new ReadableStream({
          start(controller) {
            push = (text) => controller.enqueue(new TextEncoder().encode(text));
          },
          cancel: () => {
            quiet.state.cancelled = true;
          },
        }),
      );
    });
    const started = await startTurn(runner, READY, id, body());
    if (!started.ok) throw new Error(`turn refused: ${started.reason}`);
    const reader = started.turn.events().getReader();

    // A byte within 60 s, here a ping at 59 s, keeps the turn going, and starts the count again.
    let read = reader.read();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(await settled(read)).toBe(false);
    push('{"type":"ping"}\n');
    expect((await read).done).toBe(false);
    read = reader.read();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(await settled(read)).toBe(false);
    expect(signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect((await read).done).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect(quiet.state.cancelled).toBe(true);
    expect(warn).toHaveBeenCalledWith("channel-egress: the runner's turn stream went silent");
  });

  it("stops the runner when the reader cancels the stream itself", async () => {
    let signal: AbortSignal | undefined;
    const source = stalled();
    const runner = fetcher((_, given) => {
      signal = given;
      return ndjson(source.body);
    });
    const started = await startTurn(runner, READY, id, body());
    if (!started.ok) throw new Error(`turn refused: ${started.reason}`);
    await started.turn.events().cancel();
    expect(signal?.aborted).toBe(true);
    expect(source.state.cancelled).toBe(true);
  });

  it("skips an empty chunk, which a byte stream can't carry", async () => {
    const runner = fetcher(() =>
      ndjson(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(0));
            controller.enqueue(new TextEncoder().encode('{"type":"ping"}\n'));
            controller.close();
          },
        }),
      ),
    );
    const started = await startTurn(runner, READY, id, body());
    if (!started.ok) throw new Error(`turn refused: ${started.reason}`);
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

  it("follows no redirect: every call asks the binding for the answer as it is", async () => {
    const inits: (RequestInit | undefined)[] = [];
    const runner = {
      fetch: async (_: RequestInfo, init?: RequestInit) => {
        inits.push(init);
        return init?.method === "POST" && inits.length === 1
          ? ndjson('{"type":"ping"}\n')
          : Response.json({ ok: true });
      },
    } as unknown as Fetcher;
    expect((await startTurn(runner, READY, id, body())).ok).toBe(true);
    expect(await giveResult(runner, READY, id, RESULT)).toEqual({ ok: true });
    expect(await closeSession(runner, READY, id)).toEqual({ ok: true });
    expect(inits.map((init) => init?.redirect)).toEqual(["manual", "manual", "manual"]);
  });

  const calls = [
    ["a turn", 503, (runner: Fetcher) => startTurn(runner, READY, id, body()), 15_000],
    ["a result", 200, (runner: Fetcher) => giveResult(runner, READY, id, RESULT), 5_000],
    ["a close", 200, (runner: Fetcher) => closeSession(runner, READY, id), 5_000],
  ] as const;

  it.each(calls)(
    "reads at most 4 KiB of the runner's answer to %s, then cancels it",
    async (_, status, send) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { body, state } = endless();
      const runner = fetcher(() => new Response(body, { status }));
      expect(await send(runner)).toEqual(unreachable);
      expect(state.cancelled).toBe(true);
      expect(state.pulls).toBeLessThanOrEqual(6);
    },
  );

  it.each(calls)(
    "gives up on an answer to %s whose body stalls, within its bound",
    async (_, status, send, bound) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { body, state } = stalled();
      const runner = fetcher(() => new Response(body, { status }));
      const answer = send(runner);
      await vi.advanceTimersByTimeAsync(bound - 1);
      expect(await settled(answer)).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await answer).toEqual(unreachable);
      expect(state.cancelled).toBe(true);
    },
  );

  it.each(calls.slice(1))(
    "gives up on %s the runner doesn't answer within 5 seconds",
    async (_, _status, send) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const answer = send(silent());
      await vi.advanceTimersByTimeAsync(4_999);
      expect(await settled(answer)).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await answer).toEqual(unreachable);
    },
  );

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
