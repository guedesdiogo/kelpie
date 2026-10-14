import { isAuthorized } from "./auth.ts";
import { PROTOCOL, VERSION } from "./protocol.ts";

/** One request, as the runner logs it: never its headers, its query or its body. */
export interface LogEntry {
  method: string;
  path: string;
  status: number;
}

export interface HandlerOptions {
  secrets: readonly string[];
  log: (entry: LogEntry) => void;
}

/** The runner's HTTP handler. Bun's server calls it for each request that reaches loopback. */
export function createHandler({ secrets, log }: HandlerOptions): (request: Request) => Response {
  return (request) => {
    const path = pathOf(request.url);
    const response = route(request, path, secrets);
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

function route(request: Request, path: string | null, secrets: readonly string[]): Response {
  // The secret comes first, so a caller without it learns nothing, not even which paths exist.
  if (!isAuthorized(request.headers.get("authorization"), secrets)) {
    return Response.json({ ok: false }, { status: 401 });
  }
  if (path === null) return Response.json({ ok: false }, { status: 400 });
  if (path === "/health") {
    if (request.method !== "GET")
      return new Response(null, { status: 405, headers: { allow: "GET" } });
    return Response.json({ ok: true, version: VERSION, protocol: PROTOCOL });
  }
  return Response.json({ ok: false }, { status: 404 });
}
