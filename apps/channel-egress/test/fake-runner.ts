import { RUNNER_PROTOCOL } from "../../../packages/channels/src/runner.ts";

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
/** A runner that fails with a 500 on every path. */
export const BROKEN = "b".repeat(64);

const RUNNERS: Record<string, { version: string; protocol: number }> = {
  [READY]: { version: "0.1.0", protocol: RUNNER_PROTOCOL },
  [OUTDATED]: { version: "0.0.9", protocol: RUNNER_PROTOCOL + 1 },
  [PROTOCOL_1]: { version: "0.1.0", protocol: 1 },
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
  action: "turns" | "tool-results" | "close";
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
