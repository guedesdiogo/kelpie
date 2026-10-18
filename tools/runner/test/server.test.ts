import { describe, expect, it, vi } from "vitest";
import {
  MAX_RESULT_BYTES,
  MAX_SESSIONS_BYTES,
  MAX_TURN_BYTES,
  MAX_WAITS_BYTES,
  PROTOCOL,
  VERSION,
} from "../src/protocol.ts";
import { createHandler, type HandlerOptions, type LogEntry } from "../src/server.ts";
import { Sessions } from "../src/sessions.ts";
import { VpsSessions } from "../src/vps-sessions.ts";
import { fakeClaude, frames, reply, result, SESSION, turnRequest } from "./fake-claude.ts";
import { fakeVps, NOW, sessionFields, writeSessionFile } from "./fake-vps.ts";

const SECRET = "a".repeat(64);
const TURNS = `/sessions/${SESSION}/turns`;
const RESULTS = `/sessions/${SESSION}/tool-results`;

function setup(
  sessions: HandlerOptions["sessions"] = stubSessions(),
  vps: HandlerOptions["vps"] = stubVps(),
) {
  const logs: LogEntry[] = [];
  const handle = createHandler({
    secrets: [SECRET],
    log: (entry) => logs.push(entry),
    sessions,
    vps,
  });
  // Bun's server, whose idle timeout a turn's stream lifts.
  const server = { timeout: vi.fn() };
  const call = (path: string, init: RequestInit = {}) =>
    handle(new Request(`http://runner${path}`, init), server);
  const auth = { authorization: `Bearer ${SECRET}` };
  const post = (path: string, body: unknown) =>
    call(path, { method: "POST", headers: auth, body: JSON.stringify(body) });
  return { logs, call, auth, post, sessions, vps, server };
}

const LISTED = { ok: true as const, now: NOW, sessions: [], truncated: false };
const WAITED = { ok: true as const, now: NOW, waits: [], truncated: false };

function stubVps() {
  return { list: vi.fn(() => LISTED), waits: vi.fn((_since: number) => WAITED) };
}

function stubSessions() {
  return {
    turn: vi.fn(async () => ({
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"type":"text","delta":"Hi"}\n'));
          controller.close();
        },
      }),
    })),
    answer: vi.fn(() => true),
    close: vi.fn(),
  };
}

describe("the runner's handler", () => {
  it("answers /health with its version and protocol", async () => {
    const { call, auth } = setup();
    const response = await call("/health", { headers: auth });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, version: VERSION, protocol: PROTOCOL });
    expect(PROTOCOL).toBe(3);
  });

  it("answers 401 without the secret, on any path and method, and says nothing more", async () => {
    const { call, sessions, vps } = setup();
    for (const [method, path] of [
      ["GET", "/health"],
      ["GET", "/anything"],
      ["POST", TURNS],
      ["POST", RESULTS],
      ["DELETE", `/sessions/${SESSION}`],
      ["GET", "/sessions"],
      ["GET", "/sessions/waits?since=0"],
    ] as const) {
      const response = await call(path, {
        method,
        headers: { authorization: "Bearer wrong" },
        ...(method === "POST" ? { body: JSON.stringify(turnRequest()) } : {}),
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ ok: false });
    }
    expect(sessions.turn).not.toHaveBeenCalled();
    expect(sessions.answer).not.toHaveBeenCalled();
    expect(sessions.close).not.toHaveBeenCalled();
    expect(vps.list).not.toHaveBeenCalled();
    expect(vps.waits).not.toHaveBeenCalled();
  });

  it("answers a URL that doesn't parse, as a malformed Host makes, with 401, or 400 once authorized", async () => {
    const { logs } = setup();
    const handle = createHandler({
      secrets: [SECRET],
      log: (entry) => logs.push(entry),
      sessions: stubSessions(),
      vps: stubVps(),
    });
    const broken = (authorization: string) =>
      ({
        url: "http://a b/health",
        method: "GET",
        headers: new Headers({ authorization }),
      }) as unknown as Request;
    const server = { timeout: vi.fn() };
    expect((await handle(broken("Bearer guess"), server)).status).toBe(401);
    expect((await handle(broken(`Bearer ${SECRET}`), server)).status).toBe(400);
    expect(logs).toEqual([
      { method: "GET", path: "?", status: 401 },
      { method: "GET", path: "?", status: 400 },
    ]);
  });

  it("answers 404 for an unknown path once authorized", async () => {
    const { call, auth } = setup();
    for (const path of [
      "/nope",
      `/sessions/${SESSION}/turns/1`,
      "/sessions/",
      `/sessions/${SESSION}/other`,
    ]) {
      expect((await call(path, { method: "POST", headers: auth })).status).toBe(404);
    }
  });

  it.each([
    ["/health", "POST", "GET"],
    [TURNS, "GET", "POST"],
    [RESULTS, "PUT", "POST"],
    [`/sessions/${SESSION}`, "POST", "DELETE"],
    ["/sessions", "POST", "GET"],
    ["/sessions/waits", "DELETE", "GET"],
  ])("answers 405 for another method on %s", async (path, method, allow) => {
    const { call, auth } = setup();
    const response = await call(path, { method, headers: auth });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe(allow);
  });

  it("logs each request's method, path and status, never its headers", async () => {
    const { call, logs, auth } = setup();
    await call("/health?x=1", { headers: auth });
    await call("/health", { headers: { authorization: "Bearer guess" } });
    expect(logs).toEqual([
      { method: "GET", path: "/health", status: 200 },
      { method: "GET", path: "/health", status: 401 },
    ]);
    expect(JSON.stringify(logs)).not.toContain(SECRET);
  });
});

describe("the session routes' input checks", () => {
  it.each([
    "11111111-2222-4333-8444-55555555555",
    "11111111-2222-4333-8444-5555555555555",
    "11111111-2222-4333-8444-55555555555G",
    // Claude Code's ids are lowercase, as Kelpie's are.
    "ABCDEF11-2222-4333-8444-555555555555",
    "not-a-uuid",
  ])("answers 400 for the session id %s", async (id) => {
    const { call, post, auth, sessions } = setup();
    expect((await post(`/sessions/${id}/turns`, turnRequest())).status).toBe(400);
    expect((await post(`/sessions/${id}/tool-results`, { callId: "t", output: "o" })).status).toBe(
      400,
    );
    expect((await call(`/sessions/${id}`, { method: "DELETE", headers: auth })).status).toBe(400);
    expect(sessions.turn).not.toHaveBeenCalled();
    expect(sessions.answer).not.toHaveBeenCalled();
    expect(sessions.close).not.toHaveBeenCalled();
  });

  it.each([
    ["isn't JSON", "{"],
    ["is empty", null],
    ["isn't UTF-8", new Uint8Array([0x22, 0xff, 0x22])],
    ["has the wrong shape", JSON.stringify({ ...turnRequest(), extra: true })],
  ])("answers 400 for a body that %s", async (_, body) => {
    const { call, auth, sessions } = setup();
    for (const path of [TURNS, RESULTS]) {
      const response = await call(path, { method: "POST", headers: auth, body });
      expect(response.status).toBe(400);
    }
    expect(sessions.turn).not.toHaveBeenCalled();
    expect(sessions.answer).not.toHaveBeenCalled();
  });

  it.each([
    [TURNS, MAX_TURN_BYTES],
    [RESULTS, MAX_RESULT_BYTES],
  ])("answers 413 for a body to %s over its bound, declared or streamed", async (path, max) => {
    const { call, auth } = setup();
    const declared = await call(path, {
      method: "POST",
      headers: { ...auth, "content-length": String(max + 1) },
      body: "{}",
    });
    expect(declared.status).toBe(413);
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    let sent = 0;
    const streamed = await call(path, {
      method: "POST",
      headers: auth,
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          sent += chunk.byteLength;
          if (sent > max + chunk.byteLength) controller.close();
          else controller.enqueue(chunk);
        },
      }),
      duplex: "half",
    } as RequestInit);
    expect(streamed.status).toBe(413);
  });
});

describe("the session routes", () => {
  it("streams a turn's frames as NDJSON, with Bun's idle timeout lifted for it alone", async () => {
    const { post, call, auth, sessions, server } = setup();
    await call("/health", { headers: auth });
    await post(RESULTS, { callId: "toolu_1", output: "x" });
    expect(server.timeout).not.toHaveBeenCalled();
    const request = new Request(`http://runner${TURNS}`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify(turnRequest()),
    });
    const response = await createHandler({
      secrets: [SECRET],
      log: () => {},
      sessions,
      vps: stubVps(),
    })(request, server);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson");
    expect(await response.text()).toBe('{"type":"text","delta":"Hi"}\n');
    expect(sessions.turn).toHaveBeenCalledWith(SESSION, turnRequest());
    expect(server.timeout).toHaveBeenCalledExactlyOnceWith(request, 0);
  });

  it.each([
    [{ status: 409 as const, reason: "lost" as const }, 409, {}],
    [{ status: 503 as const, reason: "full" as const }, 503, {}],
    [
      { status: 429 as const, reason: "rate" as const, retryAfter: 17 },
      429,
      { "retry-after": "17" },
    ],
  ])(
    "answers a turn that can't start with its status and reason: %j",
    async (refusal, status, headers) => {
      const sessions = { ...stubSessions(), turn: vi.fn(async () => refusal) };
      const { post, server } = setup(sessions);
      const response = await post(TURNS, turnRequest({ resume: true }));
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ ok: false, reason: refusal.reason });
      for (const [name, value] of Object.entries(headers)) {
        expect(response.headers.get(name)).toBe(value);
      }
      expect(response.headers.has("retry-after")).toBe(status === 429);
      expect(server.timeout).not.toHaveBeenCalled();
    },
  );

  it("gives a call its result, or answers 409 when no call waits for it", async () => {
    const sessions = stubSessions();
    const { post } = setup(sessions);
    const answer = { callId: "toolu_1", output: "Ana lives in Lisbon.", isError: false };
    const response = await post(RESULTS, answer);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(sessions.answer).toHaveBeenCalledWith(SESSION, answer);
    sessions.answer.mockReturnValue(false);
    const late = await post(RESULTS, answer);
    expect(late.status).toBe(409);
    expect(await late.json()).toEqual({ ok: false });
  });

  it("closes a session on DELETE, whether or not it is live", async () => {
    const { call, auth, sessions } = setup();
    const response = await call(`/sessions/${SESSION}`, { method: "DELETE", headers: auth });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(sessions.close).toHaveBeenCalledWith(SESSION);
  });

  it("runs a turn with a tool call end to end, through Claude Code's stand-in", async () => {
    const claude = fakeClaude();
    const { post, call, auth } = setup(
      new Sessions({
        query: claude.query,
        sessionExists: async () => false,
        deleteSession: async () => {},
        env: {},
        cwd: "/srv",
        warn: () => {},
      }),
    );
    const response = await post(TURNS, turnRequest());
    const turn = frames(response.body as ReadableStream<Uint8Array>);
    const session = claude.sessions[0];
    if (!session) throw new Error("No session");
    await session.next();
    session.send(
      ...reply("msg_1", [
        { id: "toolu_1", name: "mcp__kelpie__memory_search", input: { query: "Ana" } },
      ]),
    );
    const done = (await session.tools()).callTool({
      name: "memory_search",
      arguments: { query: "Ana" },
      _meta: { "claudecode/toolUseId": "toolu_1" },
    });
    expect(await turn.next()).toEqual({ type: "ping" });
    expect(await turn.next()).toMatchObject({ type: "round" });
    expect(await turn.next()).toMatchObject({ type: "tool_call", call: { id: "toolu_1" } });
    expect((await post(RESULTS, { callId: "toolu_1", output: "Lisbon" })).status).toBe(200);
    expect(await done).toEqual({ content: [{ type: "text", text: "Lisbon" }] });
    session.send(...reply("msg_2", ["Lisbon."]), result(SESSION));
    expect((await turn.rest()).at(-1)).toMatchObject({ type: "finish", reason: "stop" });
    expect((await call(`/sessions/${SESSION}`, { method: "DELETE", headers: auth })).status).toBe(
      200,
    );
    expect(session.closed).toBe(true);
  });
});

describe("the VPS's sessions routes", () => {
  it("lists the sessions, and logs neither the query nor the answer", async () => {
    const { call, auth, vps, logs } = setup();
    const response = await call("/sessions", { headers: auth });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(LISTED);
    expect(vps.list).toHaveBeenCalledOnce();
    await call("/sessions/waits?since=1760700000000&x=1", { headers: auth });
    expect(logs).toEqual([
      { method: "GET", path: "/sessions", status: 200 },
      { method: "GET", path: "/sessions/waits", status: 200 },
    ]);
  });

  it.each([
    ["0", 0],
    ["1760700000000", 1_760_700_000_000],
    [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
  ])("lists the waits since %s", async (since, expected) => {
    const { call, auth, vps } = setup();
    const response = await call(`/sessions/waits?since=${since}`, { headers: auth });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(WAITED);
    expect(vps.waits).toHaveBeenCalledExactlyOnceWith(expected);
  });

  it.each([
    ["no since", "/sessions/waits"],
    ["an empty since", "/sessions/waits?since="],
    ["a negative since", "/sessions/waits?since=-1"],
    ["a fractional since", "/sessions/waits?since=1.5"],
    ["a since in words", "/sessions/waits?since=yesterday"],
    ["a since past a safe integer", "/sessions/waits?since=9007199254740992"],
    ["a since of 17 digits", "/sessions/waits?since=10000000000000000"],
  ])("answers 400 for %s", async (_, path) => {
    const { call, auth, vps } = setup();
    const response = await call(path, { headers: auth });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false });
    expect(vps.waits).not.toHaveBeenCalled();
  });

  it("answers within its bounds, from the session files on disk", async () => {
    const disk = fakeVps();
    try {
      for (let pid = 1; pid <= 250; pid += 1) {
        writeSessionFile(
          disk,
          sessionFields({
            pid,
            sessionId: `${String(pid).padStart(8, "0")}-1111-4222-8333-444444444444`,
            name: "\u0001".repeat(200),
          }),
        );
      }
      const vps = new VpsSessions({
        claudeDir: disk.claudeDir,
        spoolDir: disk.spoolDir,
        workDir: disk.workDir,
        holds: () => false,
        secrets: [SECRET],
        warn: () => {},
        alive: () => true,
      });
      const { call, auth } = setup(stubSessions(), vps);
      const list = await (await call("/sessions", { headers: auth })).arrayBuffer();
      expect(list.byteLength).toBeLessThanOrEqual(MAX_SESSIONS_BYTES);
      expect(JSON.parse(new TextDecoder().decode(list))).toMatchObject({ truncated: true });
      const waits = await (await call("/sessions/waits?since=0", { headers: auth })).arrayBuffer();
      expect(waits.byteLength).toBeLessThanOrEqual(MAX_WAITS_BYTES);
    } finally {
      disk.cleanup();
    }
  });
});
