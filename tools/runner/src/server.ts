import { isAuthorized } from "./auth.ts";
import { PROTOCOL, VERSION } from "./protocol.ts";
import {
  MAX_RESULT_BYTES,
  MAX_TURN_BYTES,
  parseToolResult,
  parseTurnRequest,
  readJson,
  SESSION_ID,
} from "./requests.ts";
import type { Sessions } from "./sessions.ts";

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
}

/** What the handler uses of Bun's server: a request's own idle timeout, in seconds. */
export interface ServerTimeouts {
  timeout(request: Request, seconds: number): void;
}

/** `/sessions/:id`, `/sessions/:id/turns` or `/sessions/:id/tool-results`. */
const SESSION_PATH = /^\/sessions\/([^/]+)(\/turns|\/tool-results)?$/;

/** The runner's HTTP handler. Bun's server calls it for each request that reaches loopback. */
export function createHandler({
  secrets,
  log,
  sessions,
}: HandlerOptions): (request: Request, server: ServerTimeouts) => Promise<Response> {
  return async (request, server) => {
    const path = pathOf(request.url);
    const response = await route(request, path, secrets, sessions, server);
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
  return action === "/turns"
    ? turn(request, id, sessions, server)
    : toolResult(request, id, sessions);
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

function notAllowed(allow: string): Response {
  return new Response(null, { status: 405, headers: { allow } });
}
