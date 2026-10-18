import { RpcTarget } from "cloudflare:workers";
import {
  parseRunnerToolResult,
  parseRunnerTurnRequest,
  parseRunnerVpsSessions,
  parseRunnerVpsWaits,
  RUNNER_MAX_SESSIONS_BYTES,
  RUNNER_MAX_TURN_BYTES,
  RUNNER_MAX_WAITS_BYTES,
  RUNNER_PROTOCOL,
  RUNNER_SESSION_ID,
  RUNNER_VERSION,
  type RunnerAnswered,
  type RunnerAnswerOutcome,
  type RunnerCloseOutcome,
  type RunnerRelayFailure,
  type RunnerSessionsOutcome,
  type RunnerToolResult,
  type RunnerTurnRequest,
  type RunnerTurnStart,
  type RunnerTurnStream,
  type RunnerWaitsOutcome,
  runnerJsonLength,
} from "@kelpie/channels";

/** How long a health check, a tool's result or a close waits for the runner's whole answer. */
const REQUEST_TIMEOUT_MS = 5_000;
/**
 * How long a turn waits for its stream to begin, or for the whole of an answer that isn't one. Its
 * body may carry a seed of up to 8 MiB, which the runner reads before it answers, and the runner
 * opens every turn's stream with a `ping` at once, so 15 s is ample. Once the stream begins, only
 * IDLE_MS bounds it here.
 */
const TURN_START_TIMEOUT_MS = 15_000;
/**
 * How long a turn's stream may send nothing while it is read: three of the runner's 20 s pings.
 * The runner has no deadline for a turn while no tool's result is awaited, so the provider sets its
 * own for the whole turn, and calls `cancel()`.
 */
const IDLE_MS = 60_000;
/** The most of an answer read when it isn't a turn's stream: the runner's take a few dozen bytes. */
const MAX_ANSWER_BYTES = 4_096;
/**
 * How long a read of the VPS's sessions waits for the runner's whole answer: it reads every
 * session's files, and a transcript's last 1 MiB for each one's PR link.
 */
const SESSIONS_TIMEOUT_MS = 10_000;
/** The turns this isolate relays at once: the runner keeps 4 sessions live. */
const MAX_TURNS_IN_FLIGHT = 4;
/** The wait after a 429 without a `Retry-After` to read: the runner counts turns by the minute. */
const DEFAULT_RETRY_AFTER_MS = 60_000;
/** The bounds of a `Retry-After` taken from the runner, in seconds. */
const MIN_RETRY_AFTER_S = 1;
const MAX_RETRY_AFTER_S = 300;

/**
 * The runner's secret: printable, without spaces, between 32 and 256 characters. `openssl rand -hex
 * 32` makes 64 (docs/runner.md).
 */
export const RUNNER_SECRET = /^[\x21-\x7e]{32,256}$/;

/** The one runner's slot in the secret store, `runner:vps` (ADR-0035's `vps` adapter). */
export const RUNNER_NAME = "vps";

/** `channel-egress`'s binding to the runner's VPC Service, which the release tool adds when set. */
export function runnerOf(env: Env): Fetcher | undefined {
  return (env as Env & { RUNNER?: Fetcher }).RUNNER;
}

export type RunnerCheck = RunnerAnswered | { state: "refused" | "unreachable" };

/** Calls the runner's `/health` with `secret`, through its VPC Service. Never logs the secret. */
export async function checkRunner(runner: Fetcher, secret: string): Promise<RunnerCheck> {
  const timeout = deadline(REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    // The VPC Service sets the host and the port; only the path matters.
    response = await runner.fetch("http://runner/health", {
      headers: { authorization: `Bearer ${secret}` },
      // The runner never redirects: an answer that does isn't the runner's.
      redirect: "manual",
      signal: timeout.signal,
    });
  } catch (error) {
    timeout.clear();
    console.warn("channel-egress: the runner couldn't be reached", errorName(error));
    return { state: "unreachable" };
  }
  const health = await readJson(response, timeout.signal, MAX_ANSWER_BYTES);
  timeout.clear();
  if (response.status === 401) return { state: "refused" };
  if (!response.ok || !isHealth(health)) {
    console.warn("channel-egress: the runner's answer isn't its health", response.status);
    return { state: "unreachable" };
  }
  return {
    state: health.protocol === RUNNER_PROTOCOL ? "ready" : "outdated",
    version: health.version,
    protocol: health.protocol,
  };
}

function isHealth(value: unknown): value is { version: string; protocol: number } {
  const health = value as { ok?: unknown; version?: unknown; protocol?: unknown } | null;
  return (
    health?.ok === true &&
    typeof health.version === "string" &&
    RUNNER_VERSION.test(health.version) &&
    Number.isInteger(health.protocol)
  );
}

/** The stored value: the secret, as JSON, so the slot can carry more later. */
export function parseRunnerSecret(value: string): string | null {
  try {
    const secret = (JSON.parse(value) as { secret?: unknown } | null)?.secret;
    return typeof secret === "string" && RUNNER_SECRET.test(secret) ? secret : null;
  } catch {
    return null;
  }
}

// The `claude-code` route's calls (#295, #420). The checks, the secret and the HTTP answers stay
// here; what crosses RPC is a typed result, never the runner's text.

const unreachable = { ok: false as const, reason: "unreachable" as const };
const refused = { ok: false as const, reason: "refused" as const };
const outdated = { ok: false as const, reason: "outdated" as const };

/** Whether `value` is a session's id, a lowercase UUID, safe to put in a path. */
export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && RUNNER_SESSION_ID.test(value);
}

/**
 * A turn's body, as the runner reads it; null when the session's id or the request is malformed,
 * when JSON can't carry it, or when the body is larger than the runner takes. The request is
 * rebuilt from the fields it knows.
 */
export function turnBody(sessionId: unknown, request: unknown): Uint8Array | null {
  const checked = isSessionId(sessionId) ? parseRunnerTurnRequest(request) : null;
  if (!checked || textLength(checked) > RUNNER_MAX_TURN_BYTES) return null;
  let json: string;
  try {
    json = JSON.stringify(checked);
  } catch {
    // A tool's schema came over RPC with a BigInt or a cycle in it.
    return null;
  }
  const body = new TextEncoder().encode(json);
  return body.byteLength <= RUNNER_MAX_TURN_BYTES ? body : null;
}

/**
 * The request's text and its tools' schemas, in UTF-16 code units. Its JSON takes at least as many
 * bytes in UTF-8, so a request whose text alone is past the runner's bound is refused before it is
 * encoded. The schemas were measured and bounded as the request was parsed, to 1 MiB together.
 */
function textLength(request: RunnerTurnRequest): number {
  let length = request.system.length;
  for (const tool of request.tools) {
    length +=
      tool.description.length +
      (runnerJsonLength(tool.inputSchema, RUNNER_MAX_TURN_BYTES) ?? RUNNER_MAX_TURN_BYTES);
  }
  for (const message of request.messages) {
    for (const part of message.parts) length += part.text.length;
  }
  return length;
}

/** A tool's result, rebuilt; null when it or the session's id is malformed. */
export function checkedResult(sessionId: unknown, result: unknown): RunnerToolResult | null {
  return isSessionId(sessionId) ? parseRunnerToolResult(result) : null;
}

let turnsInFlight = 0;

/**
 * Takes one of this isolate's places for a turn in flight, or null when all MAX_TURNS_IN_FLIGHT are
 * taken. The release frees it once, however often it is called.
 */
export function takeTurnPlace(): (() => void) | null {
  if (turnsInFlight >= MAX_TURNS_IN_FLIGHT) return null;
  turnsInFlight += 1;
  let held = true;
  return () => {
    if (held) turnsInFlight -= 1;
    held = false;
  };
}

/**
 * A turn the runner started. `events()` relays its NDJSON frames byte for byte, `ping` frames
 * included: they keep the RPC hop open too, while Kelpie runs a tool. Cancelling a stream over RPC
 * doesn't reach this side while the runner is quiet, so `cancel()` aborts the runner's request, and
 * so does disposing the last stub, as when a caller drops it. The turn's place in flight is freed
 * when its relay ends, whichever way.
 */
export class RunnerTurn extends RpcTarget implements RunnerTurnStream {
  readonly #events: ReadableStream<Uint8Array>;
  readonly #controller: AbortController;

  constructor(body: ReadableStream<Uint8Array>, controller: AbortController, release: () => void) {
    super();
    this.#controller = controller;
    this.#events = relay(body, controller, release);
  }

  events(): ReadableStream<Uint8Array> {
    return this.#events;
  }

  cancel(): void {
    this.#controller.abort();
  }

  [Symbol.dispose](): void {
    this.cancel();
  }
}

/**
 * The runner's response, chunk for chunk, as a byte stream, which RPC carries. An abort cancels
 * the response, so the runner sees its turn's stream dropped, even through a binding that doesn't
 * abort it on its own. So does IDLE_MS without a byte while a read waits: the time a reader spends
 * elsewhere, as running a tool, isn't the runner's silence. So does IDLE_MS before the first read.
 *
 * The relay then ends, as it does when the runner's connection drops: it never errors, since an
 * errored stream fails RPC's own pump too. Without a `finish` or `error` frame, a reader takes that
 * end for a dropped turn.
 */
function relay(
  body: ReadableStream<Uint8Array>,
  controller: AbortController,
  release: () => void,
): ReadableStream<Uint8Array> {
  const { signal } = controller;
  const reader = body.getReader();
  // A byte stream pulls only for a read: a turn never read would never time out on its own.
  const unread = setTimeout(() => {
    console.warn("channel-egress: a turn's stream wasn't read");
    controller.abort();
  }, IDLE_MS);
  signal.addEventListener(
    "abort",
    () => {
      clearTimeout(unread);
      release();
      void reader.cancel().catch(() => undefined);
    },
    { once: true },
  );
  const end = (stream: ReadableByteStreamController) => {
    release();
    stream.close();
  };
  return new ReadableStream({
    type: "bytes",
    async pull(stream) {
      clearTimeout(unread);
      const idle = setTimeout(() => {
        console.warn("channel-egress: the runner's turn stream went silent");
        controller.abort();
      }, IDLE_MS);
      try {
        for (;;) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await reader.read();
          } catch (error) {
            if (!signal.aborted) {
              console.warn("channel-egress: the runner's turn stream failed", errorName(error));
            }
            return end(stream);
          }
          if (chunk.done || signal.aborted) return end(stream);
          // A byte stream refuses an empty chunk.
          if (chunk.value.byteLength > 0) return stream.enqueue(chunk.value);
        }
      } finally {
        clearTimeout(idle);
      }
    },
    cancel() {
      controller.abort();
    },
  });
}

/** A turn's start, with the relay's own class, which RPC turns into a disposable stub. */
export type TurnStart = Exclude<RunnerTurnStart, { ok: true }> | { ok: true; turn: RunnerTurn };

/**
 * `POST /sessions/:id/turns`, with a body `turnBody` made. `release` frees the turn's place in
 * flight: at once when the turn doesn't start, else when its relay ends.
 */
export async function startTurn(
  runner: Fetcher,
  secret: string,
  sessionId: string,
  body: Uint8Array,
  release: () => void = () => {},
): Promise<TurnStart> {
  try {
    return await sendTurn(runner, secret, sessionId, body, release);
  } catch (error) {
    // Nothing expected throws here: an unexpected throw mustn't keep the place for good.
    release();
    throw error;
  }
}

async function sendTurn(
  runner: Fetcher,
  secret: string,
  sessionId: string,
  body: Uint8Array,
  release: () => void,
): Promise<TurnStart> {
  const controller = new AbortController();
  // Armed until the stream begins, or until an answer that isn't one has been read. The same
  // signal then aborts the stream, on `cancel()`.
  const start = deadline(TURN_START_TIMEOUT_MS, controller);
  let response: Response;
  try {
    response = await runner.fetch(`http://runner/sessions/${sessionId}/turns`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body,
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (error) {
    start.clear();
    release();
    console.warn("channel-egress: the runner couldn't be reached for a turn", errorName(error));
    return unreachable;
  }
  const type = response.headers.get("content-type") ?? "";
  if (response.status === 200 && response.body && type.startsWith("application/x-ndjson")) {
    start.clear();
    return { ok: true, turn: new RunnerTurn(response.body, controller, release) };
  }
  const answer = await answerOf(response, controller.signal);
  start.clear();
  release();
  const known = failureOf(answer);
  if (known) return known;
  const { reason } = answer;
  if (answer.ok === false) {
    if (
      answer.status === 409 &&
      (reason === "lost" || reason === "unfinished" || reason === "mismatched")
    ) {
      return { ok: false, reason };
    }
    if (answer.status === 503 && reason === "full") return { ok: false, reason };
    if (answer.status === 429 && reason === "rate") {
      return { ok: false, reason, retryAfterMs: retryAfterMs(response.headers.get("retry-after")) };
    }
  }
  return unexpected(answer, "a turn");
}

/** `POST /sessions/:id/tool-results`. A 409 says no call of the session waits for this result. */
export async function giveResult(
  runner: Fetcher,
  secret: string,
  sessionId: string,
  result: RunnerToolResult,
): Promise<RunnerAnswerOutcome> {
  const answer = await call(runner, secret, `/sessions/${sessionId}/tool-results`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(result),
  });
  if (answer.status === 200 && answer.ok === true) return { ok: true };
  if (answer.status === 409 && answer.ok === false) return { ok: false, reason: "unknown_call" };
  return failureOf(answer) ?? unexpected(answer, "a tool's result");
}

/** `DELETE /sessions/:id`. The runner answers the same for a session it doesn't have. */
export async function closeSession(
  runner: Fetcher,
  secret: string,
  sessionId: string,
): Promise<RunnerCloseOutcome> {
  const answer = await call(runner, secret, `/sessions/${sessionId}`, { method: "DELETE" });
  if (answer.status === 200 && answer.ok === true) return { ok: true };
  return failureOf(answer) ?? unexpected(answer, "a close");
}

// The VPS's Claude Code sessions, read only (ADR-0057, #433). Each answer is checked and rebuilt
// by the shared parsers, so only what the protocol carries crosses RPC.

/** `GET /sessions`: every session on the VPS but the runner's own, read up to 512 KiB. */
export async function listSessions(
  runner: Fetcher,
  secret: string,
): Promise<RunnerSessionsOutcome> {
  const answer = await read(runner, secret, "/sessions", RUNNER_MAX_SESSIONS_BYTES);
  if (answer.status !== 200) return readFailure(answer, "the sessions");
  return parseRunnerVpsSessions(answer.value) ?? unexpected(answer, "the sessions");
}

/** `GET /sessions/waits?since=`: the open waits opened at `since` or later, read up to 64 KiB. */
export async function listWaits(
  runner: Fetcher,
  secret: string,
  since: number,
): Promise<RunnerWaitsOutcome> {
  const path = `/sessions/waits?since=${since}`;
  const answer = await read(runner, secret, path, RUNNER_MAX_WAITS_BYTES);
  if (answer.status !== 200) return readFailure(answer, "the waits");
  return parseRunnerVpsWaits(answer.value) ?? unexpected(answer, "the waits");
}

/** A GET's answer: its status, 0 when the call failed or timed out, and its JSON, if any. */
interface ReadAnswer extends Answer {
  value: unknown;
}

/** A GET to the runner, its answer read whole, up to `maxBytes`, within SESSIONS_TIMEOUT_MS. */
async function read(
  runner: Fetcher,
  secret: string,
  path: string,
  maxBytes: number,
): Promise<ReadAnswer> {
  const timeout = deadline(SESSIONS_TIMEOUT_MS);
  try {
    const response = await runner.fetch(`http://runner${path}`, {
      headers: { authorization: `Bearer ${secret}` },
      redirect: "manual",
      signal: timeout.signal,
    });
    const value = await readJson(response, timeout.signal, maxBytes);
    const ok = (value as { ok?: unknown } | null)?.ok;
    return { status: response.status, value, ...(typeof ok === "boolean" ? { ok } : {}) };
  } catch (error) {
    console.warn("channel-egress: the runner couldn't be reached", errorName(error));
    return { status: 0, value: null };
  } finally {
    timeout.clear();
  }
}

/**
 * A read the runner didn't answer with 200. A runner below protocol 3 answers 404 to
 * `/sessions`, as every runner below 2 does to every path but `/health`, and 405 to
 * `/sessions/waits`, which protocol 2 takes for a session's id.
 */
function readFailure(answer: Answer, what: string): RunnerRelayFailure {
  if (answer.status === 405) return outdated;
  return failureOf(answer) ?? unexpected(answer, what);
}

/** The runner's answer: its status and its JSON's `ok` and `reason`, when it has them. */
interface Answer {
  /** 0 when the call failed or timed out. */
  status: number;
  ok?: boolean;
  reason?: unknown;
}

/** A short call to the runner, its answer read whole within REQUEST_TIMEOUT_MS. */
async function call(
  runner: Fetcher,
  secret: string,
  path: string,
  init: { method: string; headers?: Record<string, string>; body?: string },
): Promise<Answer> {
  const timeout = deadline(REQUEST_TIMEOUT_MS);
  try {
    const response = await runner.fetch(`http://runner${path}`, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${secret}` },
      redirect: "manual",
      signal: timeout.signal,
    });
    return await answerOf(response, timeout.signal);
  } catch (error) {
    console.warn("channel-egress: the runner couldn't be reached", errorName(error));
    return { status: 0 };
  } finally {
    timeout.clear();
  }
}

async function answerOf(response: Response, signal: AbortSignal): Promise<Answer> {
  const value = (await readJson(response, signal, MAX_ANSWER_BYTES)) as Answer | null;
  return typeof value === "object" && value !== null && typeof value.ok === "boolean"
    ? { status: response.status, ok: value.ok, reason: value.reason }
    : { status: response.status };
}

/**
 * An answer's body as JSON, read up to `maxBytes` while `signal` allows; null when it is longer,
 * cut short or not JSON. The body is cancelled either way, which frees its connection.
 */
async function readJson(
  response: Response,
  signal: AbortSignal,
  maxBytes: number,
): Promise<unknown> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const stop = () => void reader?.cancel().catch(() => undefined);
  signal.addEventListener("abort", stop, { once: true });
  // Checked before each chunk is kept, so no more than `maxBytes` is ever kept.
  const bytes = new Uint8Array(maxBytes);
  let size = 0;
  try {
    if (!response.body || signal.aborted) return null;
    reader = response.body.getReader();
    for (;;) {
      const chunk = await reader.read();
      if (signal.aborted) return null;
      if (chunk.done) break;
      if (size + chunk.value.byteLength > maxBytes) return null;
      bytes.set(chunk.value, size);
      size += chunk.value.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes.subarray(0, size)));
  } catch {
    return null;
  } finally {
    signal.removeEventListener("abort", stop);
    stop();
  }
}

/** A signal that aborts after `ms`, as a timeout, unless cleared first. */
function deadline(ms: number, controller = new AbortController()) {
  const timer = setTimeout(
    () => controller.abort(new DOMException("The runner took too long", "TimeoutError")),
    ms,
  );
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/**
 * What every call may answer: 401 to the stored secret, or 404, which a runner below protocol 2
 * answers on every path but `/health`. A runner on protocol 2 never answers 404 to a session's
 * path, since the id is checked first, so no `/health` call is needed to tell them apart.
 */
function failureOf(answer: Answer): RunnerRelayFailure | null {
  if (answer.status === 401) return refused;
  if (answer.status === 404 && answer.ok === false) return outdated;
  if (answer.status === 0) return unreachable;
  return null;
}

function unexpected(answer: Answer, what: string): RunnerRelayFailure {
  console.warn(`channel-egress: the runner's answer to ${what} isn't its own`, answer.status);
  return unreachable;
}

/** The runner's `Retry-After`, in whole seconds, as ms, kept between 1 and 300 s. */
function retryAfterMs(header: string | null): number {
  if (header === null || !/^\d+$/.test(header)) return DEFAULT_RETRY_AFTER_MS;
  const seconds = Math.min(Math.max(Number(header), MIN_RETRY_AFTER_S), MAX_RETRY_AFTER_S);
  return seconds * 1_000;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
