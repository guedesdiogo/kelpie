import {
  RUNNER_PROTOCOL,
  type RunnerVpsRequests,
  type RunnerVpsSessions,
  type RunnerVpsWaits,
} from "../../../packages/channels/src/runner.ts";

// A stand-in for the VPS runner behind its VPC Service (#294, #420), which vitest.config.ts binds
// as RUNNER. It runs in Node, outside the Worker's isolate: a test reads what it saw through
// `GET /__seen/:id`, a path the real runner doesn't have. It can't see a dropped stream, since
// Miniflare never cancels a response its caller dropped, so the cancel tests stub the binding.
// This file imports nothing else, so the tests import its constants too.

export const READY = "r".repeat(64);
/** A runner on a newer protocol. */
export const OUTDATED = "o".repeat(64);
/** A runner on protocol 1, which serves `/health` only, as before #295. */
export const PROTOCOL_1 = "p".repeat(64);
/** A runner on protocol 2, which serves the `claude-code` route but not the VPS's sessions. */
export const PROTOCOL_2 = "q".repeat(64);
/** A runner on protocol 3, which lists the VPS's sessions but can't act on them. */
export const PROTOCOL_3 = "t".repeat(64);
/** A runner that fails with a 500 on every path. */
export const BROKEN = "b".repeat(64);

const RUNNERS: Record<string, { version: string; protocol: number }> = {
  [READY]: { version: "0.1.0", protocol: RUNNER_PROTOCOL },
  [OUTDATED]: { version: "0.0.9", protocol: RUNNER_PROTOCOL + 1 },
  [PROTOCOL_1]: { version: "0.1.0", protocol: 1 },
  [PROTOCOL_2]: { version: "0.2.0", protocol: 2 },
  [PROTOCOL_3]: { version: "0.3.0", protocol: 3 },
};

const NOW = Date.UTC(2026, 9, 17, 18, 0, 0);

/** The VPS's sessions, as the runner lists them on protocol 3 (ADR-0057). */
export const VPS_SESSIONS: RunnerVpsSessions = {
  ok: true,
  now: NOW,
  truncated: false,
  sessions: [
    {
      id: "aaaaaaaa-1111-4222-8333-444444444444",
      state: "waiting_answer",
      since: NOW - 60_000,
      archivable: false,
      status: "waiting",
      statusUpdatedAt: NOW - 55_000,
      startedAt: NOW - 3_600_000,
      alive: true,
      startedBy: "app",
      entrypoint: "claude-desktop",
      title: "Review the runner",
      repository: "kelpie",
      branch: "feat/runner-vps-sessions",
      prUrl: "https://github.com/guedesdiogo/kelpie/pull/433",
      excerpt: "Which option should I take?",
    },
    {
      id: "bbbbbbbb-1111-4222-8333-444444444444",
      state: "ended",
      since: NOW - 7_200_000,
      // A terminal's session: only the app archives one.
      archivable: false,
      status: "idle",
      statusUpdatedAt: NOW - 7_200_000,
      startedAt: NOW - 9_000_000,
      alive: false,
      startedBy: "terminal",
      entrypoint: "cli",
      title: null,
      repository: null,
      branch: null,
      prUrl: null,
      excerpt: null,
    },
  ],
};

/** The waits on the owner, as the runner lists them; the fake keeps those opened since `since`. */
export const VPS_WAITS: RunnerVpsWaits = {
  ok: true,
  now: NOW,
  truncated: false,
  waits: [
    {
      sessionId: "aaaaaaaa-1111-4222-8333-444444444444",
      kind: "question",
      openedAt: NOW - 60_000,
      title: "Review the runner",
      repository: "kelpie",
    },
  ],
};

/** The permission prompts held open for a verdict, as the runner lists them on protocol 4. */
export const VPS_REQUESTS: RunnerVpsRequests = {
  ok: true,
  now: NOW,
  truncated: false,
  requests: [
    {
      id: "eeeeeeee-0000-4000-8000-00000000000e",
      sessionId: "aaaaaaaa-1111-4222-8333-444444444444",
      tool: "Bash",
      input: "command: rm -rf build description: Clean the build",
      truncated: false,
      openedAt: NOW - 30_000,
      title: "Review the runner",
      repository: "kelpie",
    },
  ],
};

/** The frames of a scripted turn, as the runner writes them, `ping` among them. */
export const TURN_TEXT = [
  { type: "text", delta: "Olá, " },
  { type: "ping" },
  { type: "text", delta: "Ana! 🦭" },
  {
    type: "finish",
    reason: "stop",
    message: { role: "assistant", parts: [{ type: "text", text: "Olá, Ana! 🦭" }] },
    usage: [],
    session: { id: "11111111-2222-4333-8444-555555555555", clean: true },
  },
]
  .map((frame) => `${JSON.stringify(frame)}\n`)
  .join("");
export const TURN_BYTES = new TextEncoder().encode(TURN_TEXT);

/** The scripted turn's bytes, cut inside a frame and inside a character's bytes too. */
function turnChunks(): Uint8Array[] {
  const bytesBefore = (text: string) =>
    new TextEncoder().encode(TURN_TEXT.slice(0, TURN_TEXT.indexOf(text))).byteLength;
  const inA = bytesBefore("á") + 1;
  const inSeal = bytesBefore("🦭") + 2;
  return [TURN_BYTES.slice(0, inA), TURN_BYTES.slice(inA, inSeal), TURN_BYTES.slice(inSeal)];
}

/**
 * How the fake answers a turn, by its conversation's name: these are the runner's refusals, and
 * any other name gets the scripted turn.
 */
const REFUSALS: Record<string, () => Response> = {
  lost: () => Response.json({ ok: false, reason: "lost" }, { status: 409 }),
  unfinished: () => Response.json({ ok: false, reason: "unfinished" }, { status: 409 }),
  mismatched: () => Response.json({ ok: false, reason: "mismatched" }, { status: 409 }),
  full: () => Response.json({ ok: false, reason: "full" }, { status: 503 }),
  rate: () =>
    Response.json({ ok: false, reason: "rate" }, { status: 429, headers: { "retry-after": "7" } }),
};

/** What one request looked like, for the tests: never its secret. */
export interface Seen {
  method: string;
  action:
    | "turns"
    | "tool-results"
    | "close"
    | "sessions"
    | "waits"
    | "requests"
    | "verdict"
    | "message"
    | "end";
  /** The query of a waits request, or the id an action named. */
  query?: string;
  /** Whether it carried the stored secret as a bearer token. */
  bearer: boolean;
  body?: unknown;
}

const seen = new Map<string, Seen[]>();

function see(id: string, entry: Seen): void {
  seen.set(id, [...(seen.get(id) ?? []), entry]);
}

const ndjson = { "content-type": "application/x-ndjson" };

export async function fakeRunner(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  const seenPath = /^\/__seen\/(.+)$/.exec(path);
  if (seenPath) return Response.json(seen.get(seenPath[1] as string) ?? []);
  const secret = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  if (secret === BROKEN) return new Response("boom", { status: 500 });
  const runner = RUNNERS[secret];
  if (!runner) return Response.json({ ok: false }, { status: 401 });
  if (path === "/health") return Response.json({ ok: true, ...runner });
  if (path === "/sessions" || path === "/sessions/waits")
    return vps(request, path, runner.protocol);
  const acted = await act(request, path, runner.protocol);
  if (acted) return acted;
  const session = /^\/sessions\/([^/]+)(?:\/(turns|tool-results))?$/.exec(path);
  if (!session || runner.protocol < 2) return Response.json({ ok: false }, { status: 404 });
  const id = session[1] as string;
  const bearer = request.headers.get("authorization") === `Bearer ${READY}`;
  if (!session[2]) {
    see(id, { method: request.method, action: "close", bearer });
    return Response.json({ ok: true });
  }
  const body: unknown = await request.json();
  if (session[2] === "tool-results") {
    see(id, { method: request.method, action: "tool-results", bearer, body });
    return (body as { callId?: unknown }).callId === "toolu_01"
      ? Response.json({ ok: true })
      : Response.json({ ok: false }, { status: 409 });
  }
  see(id, { method: request.method, action: "turns", bearer, body });
  const conversation = String((body as { conversation?: unknown }).conversation);
  const refusal = REFUSALS[conversation];
  if (refusal) return refusal();
  const chunks = turnChunks();
  const stream = new ReadableStream<Uint8Array>({
    pull: (controller) => {
      const chunk = chunks.shift();
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  });
  return new Response(stream, { headers: ndjson });
}

/**
 * Acting on the VPS's sessions (ADR-0069), by the runner's protocol: below 4, `/sessions/requests`
 * is a session's id, which only `DELETE`s (405), and the other paths aren't there (404). The fake
 * knows one open request, and one live session: anything else is closed, or not found.
 */
async function act(request: Request, path: string, protocol: number): Promise<Response | null> {
  const bearer = request.headers.get("authorization") === `Bearer ${READY}`;
  const verdict = /^\/sessions\/requests\/([^/]+)$/.exec(path);
  const session = /^\/sessions\/([^/]+)\/(message|end)$/.exec(path);
  if (path === "/sessions/requests") {
    if (protocol < 4) return new Response(null, { status: 405, headers: { allow: "DELETE" } });
    see("vps", { method: request.method, action: "requests", bearer });
    return Response.json(VPS_REQUESTS);
  }
  if (!verdict && !session) return null;
  if (protocol < 4) return Response.json({ ok: false }, { status: 404 });
  const body: unknown = await request.json();
  if (verdict) {
    see("vps", {
      method: request.method,
      action: "verdict",
      bearer,
      body,
      query: verdict[1] as string,
    });
    return verdict[1] === VPS_REQUESTS.requests[0]?.id
      ? Response.json({ ok: true, applied: true })
      : Response.json({ ok: false, reason: "closed" }, { status: 409 });
  }
  const [, id, action] = session as RegExpExecArray;
  see("vps", {
    method: request.method,
    action: action as "message" | "end",
    bearer,
    body,
    query: id as string,
  });
  return id === VPS_SESSIONS.sessions[0]?.id
    ? Response.json({ ok: true })
    : Response.json({ ok: false, reason: "not_found" }, { status: 409 });
}

/**
 * The VPS's sessions, by the runner's protocol: below 3, `/sessions` is a path the runner doesn't
 * have (404), and protocol 2 takes `/sessions/waits` for a session's id, which only `DELETE` (405).
 */
function vps(request: Request, path: string, protocol: number): Response {
  const bearer = request.headers.get("authorization") === `Bearer ${READY}`;
  const { search } = new URL(request.url);
  if (protocol < 3 && (protocol < 2 || path === "/sessions")) {
    return Response.json({ ok: false }, { status: 404 });
  }
  if (protocol < 3) return new Response(null, { status: 405, headers: { allow: "DELETE" } });
  if (path === "/sessions") {
    see("vps", { method: request.method, action: "sessions", bearer });
    return Response.json(VPS_SESSIONS);
  }
  see("vps", { method: request.method, action: "waits", bearer, query: search });
  const since = Number(new URL(request.url).searchParams.get("since"));
  return Response.json({
    ...VPS_WAITS,
    waits: VPS_WAITS.waits.filter((wait) => wait.openedAt >= since),
  });
}
