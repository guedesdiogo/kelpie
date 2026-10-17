import { RpcTarget } from "cloudflare:workers";
import {
  parseRunnerToolResult,
  parseRunnerTurnRequest,
  RUNNER_MAX_TURN_BYTES,
  RUNNER_PROTOCOL,
  RUNNER_SESSION_ID,
  RUNNER_VERSION,
  type RunnerAnswer,
  type RunnerAnswered,
  type RunnerClose,
  type RunnerRelayFailure,
  type RunnerToolResult,
  type RunnerTurnStart,
  type RunnerTurnStream,
} from "@kelpie/channels";

/** How long a health check, a tool's result or a close waits for the runner's answer. */
const REQUEST_TIMEOUT_MS = 5_000;
/**
 * How long a turn waits for its stream to begin. Its body may carry a seed of up to 8 MiB, which
 * the runner reads before it answers. Once the stream begins, nothing here bounds it: the runner
 * sends a `ping` after each 20 s of silence, and ends the turn at its own deadline.
 */
const TURN_START_TIMEOUT_MS = 15_000;
/** The wait after a 429 without a `Retry-After` to read: the runner counts turns by the minute. */
const DEFAULT_RETRY_AFTER_MS = 60_000;

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
  let response: Response;
  try {
    // The VPC Service sets the host and the port; only the path matters.
    response = await runner.fetch("http://runner/health", {
      headers: { authorization: `Bearer ${secret}` },
      // The runner never redirects: an answer that does isn't the runner's.
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    console.warn("channel-egress: the runner couldn't be reached", errorName(error));
    return { state: "unreachable" };
  }
  if (response.status === 401) return { state: "refused" };
  const health: unknown = response.ok ? await response.json().catch(() => null) : null;
  if (!isHealth(health)) {
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
 * or the body is larger than the runner takes. The request is rebuilt from the fields it knows.
 */
export function turnBody(sessionId: unknown, request: unknown): Uint8Array | null {
  const checked = isSessionId(sessionId) ? parseRunnerTurnRequest(request) : null;
  if (!checked) return null;
  const body = new TextEncoder().encode(JSON.stringify(checked));
  return body.byteLength <= RUNNER_MAX_TURN_BYTES ? body : null;
}

/** A tool's result, rebuilt; null when it or the session's id is malformed. */
export function checkedResult(sessionId: unknown, result: unknown): RunnerToolResult | null {
  return isSessionId(sessionId) ? parseRunnerToolResult(result) : null;
}

/**
 * A turn the runner started. `events()` relays its NDJSON frames byte for byte, `ping` frames
 * included: they keep the RPC hop open too, while Kelpie runs a tool. Cancelling a stream over RPC
 * doesn't reach this side while the runner is quiet, so `cancel()` aborts the runner's request, and
 * so does disposing the last stub, as when a caller drops it.
 */
export class RunnerTurn extends RpcTarget implements RunnerTurnStream {
  readonly #events: ReadableStream<Uint8Array>;
  readonly #controller: AbortController;

  constructor(body: ReadableStream<Uint8Array>, controller: AbortController) {
    super();
    this.#controller = controller;
    this.#events = relay(body, controller);
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
 * abort it on its own. The relay then ends, as it does when the runner's connection drops: it never
 * errors, since an errored stream fails RPC's own pump too. Without a `finish` or `error` frame, a
 * reader takes that end for a dropped turn.
 */
function relay(
  body: ReadableStream<Uint8Array>,
  controller: AbortController,
): ReadableStream<Uint8Array> {
  const { signal } = controller;
  const reader = body.getReader();
  signal.addEventListener("abort", () => void reader.cancel().catch(() => undefined), {
    once: true,
  });
  return new ReadableStream({
    type: "bytes",
    async pull(stream) {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (error) {
          if (!signal.aborted) {
            console.warn("channel-egress: the runner's turn stream failed", errorName(error));
          }
          return stream.close();
        }
        if (chunk.done || signal.aborted) return stream.close();
        // A byte stream refuses an empty chunk.
        if (chunk.value.byteLength > 0) return stream.enqueue(chunk.value);
      }
    },
    cancel() {
      controller.abort();
    },
  });
}

/** A turn's start, with the relay's own class, which RPC turns into a disposable stub. */
export type TurnStart = Exclude<RunnerTurnStart, { ok: true }> | { ok: true; turn: RunnerTurn };

/** `POST /sessions/:id/turns`, with a body `turnBody` made. */
export async function startTurn(
  runner: Fetcher,
  secret: string,
  sessionId: string,
  body: Uint8Array,
): Promise<TurnStart> {
  const controller = new AbortController();
  // Only the stream's start: the same signal then aborts the stream, on `cancel()`.
  const timer = setTimeout(() => controller.abort(), TURN_START_TIMEOUT_MS);
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
    console.warn("channel-egress: the runner couldn't be reached for a turn", errorName(error));
    return unreachable;
  } finally {
    clearTimeout(timer);
  }
  const type = response.headers.get("content-type") ?? "";
  if (response.status === 200 && response.body && type.startsWith("application/x-ndjson")) {
    return { ok: true, turn: new RunnerTurn(response.body, controller) };
  }
  const answer = await answerOf(response);
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
): Promise<RunnerAnswer> {
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
): Promise<RunnerClose> {
  const answer = await call(runner, secret, `/sessions/${sessionId}`, { method: "DELETE" });
  if (answer.status === 200 && answer.ok === true) return { ok: true };
  return failureOf(answer) ?? unexpected(answer, "a close");
}

/** The runner's answer: its status and its JSON's `ok` and `reason`, when it has them. */
interface Answer {
  /** 0 when the call failed or timed out. */
  status: number;
  ok?: boolean;
  reason?: unknown;
}

/** A short call to the runner, bounded as `/health` is. */
async function call(
  runner: Fetcher,
  secret: string,
  path: string,
  init: { method: string; headers?: Record<string, string>; body?: string },
): Promise<Answer> {
  let response: Response;
  try {
    response = await runner.fetch(`http://runner${path}`, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${secret}` },
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    console.warn("channel-egress: the runner couldn't be reached", errorName(error));
    return { status: 0 };
  }
  return answerOf(response);
}

async function answerOf(response: Response): Promise<Answer> {
  const value = (await response.json().catch(() => null)) as Answer | null;
  return typeof value === "object" && value !== null && typeof value.ok === "boolean"
    ? { status: response.status, ok: value.ok, reason: value.reason }
    : { status: response.status };
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

/** The runner's `Retry-After`, in whole seconds, as ms. */
function retryAfterMs(header: string | null): number {
  return header !== null && /^\d{1,4}$/.test(header)
    ? Number(header) * 1_000
    : DEFAULT_RETRY_AFTER_MS;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
