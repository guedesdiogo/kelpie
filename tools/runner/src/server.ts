import { isAuthorized } from "./auth.ts";
import {
  MAX_RESULT_BYTES,
  MAX_TURN_BYTES,
  PROTOCOL,
  parseMessageRequest,
  parseToolResult,
  parseTurnRequest,
  parseVerdictRequest,
  type RunnerActAnswer,
  SESSION_ID,
  VERSION,
} from "./protocol.ts";
import { readJson } from "./requests.ts";
import type { Sessions } from "./sessions.ts";
import type { VpsSessions } from "./vps-sessions.ts";

/** One request, as the runner logs it: never its headers, its query or its body. */
export interface LogEntry {
  method: string;
  path: string;
  status: number;
}

export interface HandlerOptions {
  secrets: readonly string[];
  log: (entry: LogEntry) => void;
  sessions: Pick<Sessions, "turn" | "answer" | "close">;
  /** The VPS's Claude Code sessions (ADR-0057), and acting on them (ADR-0069). */
  vps: Pick<VpsSessions, "list" | "waits" | "requests" | "verdict" | "message" | "end">;
}

/** What the handler uses of Bun's server: a request's own idle timeout, in seconds. */
export interface ServerTimeouts {
  timeout(request: Request, seconds: number): void;
}

/**
 * `/sessions/:id`, `/sessions/:id/turns` or `/sessions/:id/tool-results`, the `claude-code` route's;
 * or `/sessions/:id/message` and `/sessions/:id/end`, the server's other sessions' (ADR-0069).
 */
const SESSION_PATH = /^\/sessions\/([^/]+)(\/turns|\/tool-results|\/message|\/end)?$/;
/** `/sessions/requests/:id`: a verdict on a permission request. */
const REQUEST_PATH = /^\/sessions\/requests\/([^/]+)$/;
/** The largest verdict's, message's or end's body: a message of 4,000 characters, all escaped. */
const MAX_ACTION_BYTES = 64 * 1024;
/** `since` in `/sessions/waits?since=`: epoch ms, digits only. */
const SINCE = /^\d{1,16}$/;

/** The runner's HTTP handler. Bun's server calls it for each request that reaches loopback. */
export function createHandler({
  secrets,
  log,
  sessions,
  vps,
}: HandlerOptions): (request: Request, server: ServerTimeouts) => Promise<Response> {
  return async (request, server) => {
    const path = pathOf(request.url);
    const response = await route(request, path, secrets, sessions, vps, server);
    log({ method: request.method, path: path ?? "?", status: response.status });
    return response;
  };
}

/** The request's path, or null when its URL doesn't parse, as with a malformed `Host`. */
function pathOf(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

async function route(
  request: Request,
  path: string | null,
  secrets: readonly string[],
  sessions: HandlerOptions["sessions"],
  vps: HandlerOptions["vps"],
  server: ServerTimeouts,
): Promise<Response> {
  // The secret comes first, so a caller without it learns nothing, not even which paths exist.
  if (!isAuthorized(request.headers.get("authorization"), secrets)) {
    return Response.json({ ok: false }, { status: 401 });
  }
  if (path === null) return Response.json({ ok: false }, { status: 400 });
  if (path === "/health") {
    if (request.method !== "GET") return notAllowed("GET");
    return Response.json({ ok: true, version: VERSION, protocol: PROTOCOL });
  }
  if (path === "/sessions" || path === "/sessions/waits" || path === "/sessions/requests") {
    if (request.method !== "GET") return notAllowed("GET");
    if (path === "/sessions") return Response.json(vps.list());
    if (path === "/sessions/requests") return Response.json(vps.requests());
    const since = sinceOf(request.url);
    if (since === null) return Response.json({ ok: false }, { status: 400 });
    return Response.json(vps.waits(since));
  }
  const requestId = REQUEST_PATH.exec(path)?.[1];
  if (requestId !== undefined) return verdict(request, requestId, vps);
  const match = SESSION_PATH.exec(path);
  if (!match) return Response.json({ ok: false }, { status: 404 });
  const id = match[1] as string;
  const action = match[2];
  if (action === undefined) {
    if (request.method !== "DELETE") return notAllowed("DELETE");
    if (!SESSION_ID.test(id)) return Response.json({ ok: false }, { status: 400 });
    sessions.close(id);
    return Response.json({ ok: true });
  }
  if (request.method !== "POST") return notAllowed("POST");
  if (!SESSION_ID.test(id)) return Response.json({ ok: false }, { status: 400 });
  if (action === "/end") return acted(vps.end(id));
  if (action === "/message") return message(request, id, vps);
  return action === "/turns"
    ? turn(request, id, sessions, server)
    : toolResult(request, id, sessions);
}

/** `POST /sessions/requests/:id`: 409 when the request isn't open, or took a verdict already. */
async function verdict(
  request: Request,
  id: string,
  vps: HandlerOptions["vps"],
): Promise<Response> {
  if (request.method !== "POST") return notAllowed("POST");
  if (!SESSION_ID.test(id)) return Response.json({ ok: false }, { status: 400 });
  const body = await readJson(request, MAX_ACTION_BYTES);
  if ("status" in body) return Response.json({ ok: false }, { status: body.status });
  const given = parseVerdictRequest(body.value);
  if (!given) return Response.json({ ok: false }, { status: 400 });
  const answer = await vps.verdict(id, given.verdict);
  return Response.json(answer, { status: answer.ok ? 200 : 409 });
}

/** `POST /sessions/:id/message`: the text to the session's inbox. */
async function message(
  request: Request,
  id: string,
  vps: HandlerOptions["vps"],
): Promise<Response> {
  const body = await readJson(request, MAX_ACTION_BYTES);
  if ("status" in body) return Response.json({ ok: false }, { status: body.status });
  const given = parseMessageRequest(body.value);
  if (!given) return Response.json({ ok: false }, { status: 400 });
  return acted(await vps.message(id, given.text));
}

/** An action's answer: 409 with its reason when the runner didn't act, never 404, an old path's. */
function acted(answer: RunnerActAnswer): Response {
  return Response.json(answer, { status: answer.ok ? 200 : 409 });
}

/** `POST /sessions/:id/turns`: the turn's frames, as NDJSON, until it ends. */
async function turn(
  request: Request,
  id: string,
  sessions: HandlerOptions["sessions"],
  server: ServerTimeouts,
): Promise<Response> {
  const body = await readJson(request, MAX_TURN_BYTES);
  if ("status" in body) return Response.json({ ok: false }, { status: body.status });
  const turnRequest = parseTurnRequest(body.value);
  if (!turnRequest) return Response.json({ ok: false }, { status: 400 });
  const started = await sessions.turn(id, turnRequest);
  if (!("stream" in started)) {
    return Response.json(
      { ok: false, reason: started.reason },
      {
        status: started.status,
        ...(started.status === 429
          ? { headers: { "retry-after": String(started.retryAfter) } }
          : {}),
      },
    );
  }
  // The stream stays silent while Kelpie runs a tool, up to a ping: Bun mustn't close it as idle.
  server.timeout(request, 0);
  return new Response(started.stream, {
    headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
  });
}

/** `POST /sessions/:id/tool-results`: 409 when no call of the session waits for this result. */
async function toolResult(
  request: Request,
  id: string,
  sessions: HandlerOptions["sessions"],
): Promise<Response> {
  const body = await readJson(request, MAX_RESULT_BYTES);
  if ("status" in body) return Response.json({ ok: false }, { status: body.status });
  const result = parseToolResult(body.value);
  if (!result) return Response.json({ ok: false }, { status: 400 });
  return sessions.answer(id, result)
    ? Response.json({ ok: true })
    : Response.json({ ok: false }, { status: 409 });
}

/** The `since` of a waits request, in epoch ms; null when it is missing or isn't one. */
function sinceOf(url: string): number | null {
  const since = new URL(url).searchParams.get("since") ?? "";
  return SINCE.test(since) && Number(since) <= Number.MAX_SAFE_INTEGER ? Number(since) : null;
}

function notAllowed(allow: string): Response {
  return new Response(null, { status: 405, headers: { allow } });
}
