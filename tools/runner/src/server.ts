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
    const path = new URL(request.url).pathname;
    const response = route(request, path, secrets);
    log({ method: request.method, path, status: response.status });
    return response;
  };
}

function route(request: Request, path: string, secrets: readonly string[]): Response {
  // The secret comes first, so a caller without it learns nothing, not even which paths exist.
  if (!isAuthorized(request.headers.get("authorization"), secrets)) {
    return Response.json({ ok: false }, { status: 401 });
  }
  if (path === "/health") {
    if (request.method !== "GET")
      return new Response(null, { status: 405, headers: { allow: "GET" } });
    return Response.json({ ok: true, version: VERSION, protocol: PROTOCOL });
  }
  return Response.json({ ok: false }, { status: 404 });
}
