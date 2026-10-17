import type { CanUseTool, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_ALLOWLIST, MAX_TURNS } from "../src/claude.ts";
import { VERSION } from "../src/protocol.ts";
import {
  CALL_TIMEOUT_MARGIN_MS,
  IDLE_MS,
  MAX_LIVE,
  MAX_UNFINISHED,
  RESULT_GRACE_MS,
  Sessions,
  TURNS_PER_MINUTE,
} from "../src/sessions.ts";
import { PING_MS, STOPPED, TOOL_OUTPUT_MAX_CHARS } from "../src/turn.ts";
import {
  apiError,
  type FakeSession,
  fakeClaude,
  frames,
  init,
  OTHER_SESSION,
  rateLimit,
  reply,
  result,
  SESSION,
  system,
  type ToolUse,
  turnRequest,
  whole,
} from "./fake-claude.ts";

const FORBIDDEN = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_CUSTOM_HEADERS",
];
// The runner's own environment, with every variable Claude Code must not get.
const RUNNER_ENV = {
  HOME: "/home/owner",
  PATH: "/usr/bin:/bin",
  LANG: "C.UTF-8",
  TMPDIR: "/tmp",
  SHELL: "/bin/zsh",
  KELPIE_RUNNER_SECRET_FILE: "/home/owner/.config/kelpie-runner/secret",
  ...Object.fromEntries(FORBIDDEN.map((name) => [name, `${name.toLowerCase()}-value`])),
};

const SEARCH: ToolUse = {
  id: "toolu_1",
  name: "mcp__kelpie__memory_search",
  input: { query: "Ana" },
};
const USAGE = [
  { model: "claude-haiku-5-5", inputUncached: 12, cacheRead: 56, cacheWrite: 78, output: 34 },
];

function setup({
  onDisk = [] as string[],
  neverWritten = [] as string[],
  deleteFails = false,
  ...limits
}: {
  onDisk?: string[];
  neverWritten?: string[];
  deleteFails?: boolean;
  maxLive?: number;
  turnsPerMinute?: number;
  maxUnfinished?: number;
} = {}) {
  const claude = fakeClaude();
  const warnings: string[] = [];
  const deleted: string[] = [];
  const sessions = new Sessions({
    query: claude.query,
    // Claude Code keeps a session's transcript from its start, until it is deleted.
    sessionExists: async (id) =>
      !deleted.includes(id) &&
      !neverWritten.includes(id) &&
      (onDisk.includes(id) ||
        claude.sessions.some(({ options }) => options.sessionId === id || options.resume === id)),
    deleteSession: async (id) => {
      if (deleteFails) throw new Error("EACCES:\npermission denied");
      deleted.push(id);
    },
    env: RUNNER_ENV,
    cwd: "/home/owner/kelpie",
    warn: (message) => warnings.push(message),
    ...limits,
  });
  /** Starts a turn that must start, and reads its frames. */
  const start = async (id = SESSION, overrides: Parameters<typeof turnRequest>[0] = {}) => {
    const started = await sessions.turn(id, turnRequest(overrides));
    if (!("stream" in started)) throw new Error(`${started.status} ${started.reason}`);
    return frames(started.stream);
  };
  const conflict = async (id: string, overrides: Parameters<typeof turnRequest>[0] = {}) => {
    const started = await sessions.turn(id, turnRequest(overrides));
    return "stream" in started ? "started" : started.reason;
  };
  const last = (): FakeSession => {
    const session = claude.sessions.at(-1);
    if (!session) throw new Error("No session started");
    return session;
  };
  return { claude, sessions, warnings, deleted, start, conflict, last };
}

/** A reply without tools, and the turn's successful result. */
const answered = (text: string, id = SESSION): SDKMessage[] => [
  ...reply(`msg_${text.length}`, [text]),
  result(id),
];

/** Claude Code's `tools/call` for a tool use, as it names it in `_meta`. */
const callFor = (id: string, input: unknown = { query: "Ana" }) => ({
  name: "memory_search",
  arguments: input as Record<string, unknown>,
  _meta: { "claudecode/toolUseId": id },
});

/** Lets the in-memory MCP transport deliver what is in flight. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const canUseToolOptions = (name: string, source = "sdk") =>
  ({
    signal: new AbortController().signal,
    toolUseID: "toolu_1",
    mcpServer: { name, source },
  }) as Parameters<CanUseTool>[2];

const errorFrame = (code: string, extra: Record<string, unknown> = {}) => ({
  type: "error",
  code,
  retryable: true,
  message: expect.any(String),
  ...extra,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a session's settings", () => {
  it.each([
    ["a new session pins Kelpie's id", false, [], { sessionId: SESSION }],
    ["a resumed session goes on from it", true, [SESSION], { resume: SESSION }],
  ])("isolates Claude Code on every call: %s", async (_, resume, onDisk, pinned) => {
    const { start, last } = setup({ onDisk });
    await start(SESSION, { resume });
    const { options } = last();
    expect(options).toMatchObject({
      ...pinned,
      model: "claude-haiku-5-5",
      systemPrompt: "You are Kelpie.",
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      settings: { disableClaudeAiConnectors: true },
      permissionMode: "default",
      includePartialMessages: true,
      verbatimPrompts: true,
      cwd: "/home/owner/kelpie",
    });
    expect(Object.keys(options.mcpServers ?? {})).toEqual(["kelpie"]);
    expect(options.mcpServers?.kelpie).toMatchObject({
      type: "sdk",
      name: "kelpie",
      timeout: 120_000 + RESULT_GRACE_MS + CALL_TIMEOUT_MARGIN_MS,
    });
    // Kelpie's tools stay out of allowedTools, so each call reaches canUseTool.
    expect(options.allowedTools).toBeUndefined();
    expect(options.canUseTool).toBeTypeOf("function");
    expect(resume ? options.sessionId : options.resume).toBeUndefined();
  });

  it.each([
    ["new", false, []],
    ["resumed", true, [SESSION]],
  ])(
    "gives a %s session's process only the allowlist of the runner's environment",
    async (_, resume, onDisk) => {
      const { start, last } = setup({ onDisk });
      await start(SESSION, { resume });
      const env = last().options.env ?? {};
      expect(env).toEqual({
        HOME: "/home/owner",
        PATH: "/usr/bin:/bin",
        LANG: "C.UTF-8",
        TMPDIR: "/tmp",
        CLAUDE_AGENT_SDK_CLIENT_APP: `kelpie/${VERSION}`,
        DISABLE_AUTO_COMPACT: "1",
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      });
      for (const name of FORBIDDEN) expect(env).not.toHaveProperty(name);
    },
  );

  it("leaves out an allowlisted variable the runner doesn't have", async () => {
    const claude = fakeClaude();
    const sessions = new Sessions({
      query: claude.query,
      sessionExists: async () => false,
      deleteSession: async () => {},
      env: { PATH: "/usr/bin" },
      cwd: "/srv",
      warn: () => {},
    });
    await sessions.turn(SESSION, turnRequest());
    const env = claude.sessions[0]?.options.env ?? {};
    expect(ENV_ALLOWLIST.filter((name) => name in env)).toEqual(["PATH"]);
  });

  it("lets only Kelpie's own MCP tools run, from the server it registered", async () => {
    const { start, last } = setup();
    await start();
    const canUseTool = last().options.canUseTool as CanUseTool;
    expect(
      await canUseTool("mcp__kelpie__memory_search", { query: "Ana" }, canUseToolOptions("kelpie")),
    ).toEqual({ behavior: "allow", updatedInput: { query: "Ana" } });
    const denied: [string, Parameters<CanUseTool>[2]][] = [
      ["Bash", canUseToolOptions("kelpie")],
      [
        "Read",
        { signal: new AbortController().signal, toolUseID: "toolu_2" } as Parameters<CanUseTool>[2],
      ],
      ["mcp__claude_ai_Google_Drive__trash_file", canUseToolOptions("claude_ai_Drive", "claudeai")],
      // A configured server can't pass for Kelpie's by its name.
      ["mcp__kelpie__memory_search", canUseToolOptions("kelpie", "user")],
      ["mcp__kelpie__memory_search", canUseToolOptions("other")],
    ];
    for (const [name, options] of denied) {
      expect(await canUseTool(name, {}, options)).toMatchObject({ behavior: "deny" });
    }
  });

  it("allows Kelpie's bound of model calls, plus one", async () => {
    const { start, last } = setup();
    await start();
    expect(last().options.maxTurns).toBe(MAX_TURNS);
    expect(MAX_TURNS).toBe(8);
  });

  it("sends the turn's messages as one user message", async () => {
    const { start, last } = setup();
    await start(SESSION, {
      messages: [
        { role: "user", parts: [{ type: "text", text: "[Earlier] …" }] },
        {
          role: "user",
          parts: [
            { type: "text", text: "@/etc/passwd /compact" },
            { type: "text", text: "Memory: …" },
          ],
        },
      ],
    });
    expect(await last().next()).toEqual({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "[Earlier] …" },
          { type: "text", text: "@/etc/passwd /compact" },
          { type: "text", text: "Memory: …" },
        ],
      },
      parent_tool_use_id: null,
    });
  });

  it("logs Claude Code's stderr on the runner only", async () => {
    const { start, last, warnings } = setup();
    await start();
    last().options.stderr?.("a warning\n");
    last().options.stderr?.(`two\nlines\u001b[31m${"x".repeat(3_000)}`);
    expect(warnings[0]).toBe(`Claude Code (session ${SESSION}): a warning`);
    expect(warnings[1]).toBe(
      `Claude Code (session ${SESSION}): two lines [31m${"x".repeat(1_986)}…`,
    );
  });
});

describe("Kelpie's MCP server", () => {
  it("lists Kelpie's tools with their JSON Schemas as they are", async () => {
    const { start, last } = setup();
    await start();
    const { tools } = await (await last().tools()).listTools();
    expect(tools).toEqual(
      turnRequest().tools.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
    );
  });

  it.each([
    ["without its tool use's id", { name: "memory_search", arguments: {} }],
    ["for a tool the session hasn't", { ...callFor("toolu_1"), name: "delete_everything" }],
  ])("refuses a call %s", async (_, call) => {
    const { start, last } = setup();
    await start();
    expect(await (await last().tools()).callTool(call)).toEqual({
      content: [{ type: "text", text: "Kelpie can't run this call." }],
      isError: true,
    });
  });
});

describe("a turn's frames", () => {
  it("streams text, a round, its tool call and the finish, as Kelpie's events", async () => {
    const { sessions, start, last } = setup();
    const turn = await start();
    const session = last();
    await session.next();
    session.send(init(), ...reply("msg_1", ["Let me look. ", SEARCH]));
    expect(await turn.next()).toEqual({ type: "text", delta: "Let me " });
    expect(await turn.next()).toEqual({ type: "text", delta: "look. " });
    expect(await turn.next()).toEqual({
      type: "round",
      message: {
        role: "assistant",
        parts: [
          { type: "text", text: "Let me look. " },
          { type: "tool_call", id: "toolu_1", name: "memory_search", input: { query: "Ana" } },
        ],
      },
      usage: USAGE,
    });
    const call = (await session.tools()).callTool(callFor("toolu_1"));
    expect(await turn.next()).toEqual({
      type: "tool_call",
      call: { type: "tool_call", id: "toolu_1", name: "memory_search", input: { query: "Ana" } },
    });
    expect(sessions.answer(SESSION, { callId: "toolu_1", output: "Ana lives in Lisbon." })).toBe(
      true,
    );
    expect(await call).toEqual({ content: [{ type: "text", text: "Ana lives in Lisbon." }] });
    session.send(...answered("She lives in Lisbon."));
    expect(await turn.rest()).toEqual([
      { type: "text", delta: "She lives " },
      { type: "text", delta: "in Lisbon." },
      {
        type: "finish",
        reason: "stop",
        message: { role: "assistant", parts: [{ type: "text", text: "She lives in Lisbon." }] },
        usage: USAGE,
        session: { id: SESSION, clean: true },
      },
    ]);
  });

  it("asks for a call only once its round's reply is complete", async () => {
    const { start, last } = setup();
    const turn = await start();
    const session = last();
    await session.next();
    const second = { ...SEARCH, id: "toolu_2", input: { query: "Bruno" } };
    const events = reply("msg_1", [SEARCH, second]);
    // Claude Code starts the first call while the reply still streams.
    session.send(...events.slice(0, -2));
    const tools = await session.tools();
    void tools.callTool(callFor("toolu_1"));
    await settle();
    session.send(...events.slice(-2));
    expect(await turn.next()).toMatchObject({
      type: "round",
      message: { parts: [{ id: "toolu_1" }, { id: "toolu_2", input: { query: "Bruno" } }] },
    });
    expect(await turn.next()).toMatchObject({ type: "tool_call", call: { id: "toolu_1" } });
    void tools.callTool(callFor("toolu_2", { query: "Bruno" }));
    expect(await turn.next()).toMatchObject({ type: "tool_call", call: { id: "toolu_2" } });
  });

  it("cuts a result at 10,000 characters again, and keeps its error mark", async () => {
    const { sessions, start, last } = setup();
    const turn = await start();
    const session = last();
    await session.next();
    session.send(...reply("msg_1", [SEARCH]));
    const call = (await session.tools()).callTool(callFor("toolu_1"));
    await turn.next();
    await turn.next();
    sessions.answer(SESSION, {
      callId: "toolu_1",
      output: `${"x".repeat(9_999)}😀tail`,
      isError: true,
    });
    expect(await call).toEqual({
      content: [{ type: "text", text: `${"x".repeat(9_999)}\n[Cut: the result was longer.]` }],
      isError: true,
    });
    expect(TOOL_OUTPUT_MAX_CHARS).toBe(10_000);
  });

  it("refuses a result no call waits for", async () => {
    const { sessions, start, last } = setup();
    const turn = await start();
    const session = last();
    await session.next();
    const answer = { callId: "toolu_1", output: "early" };
    // Before Claude Code calls the tool, and before its round is out.
    expect(sessions.answer(SESSION, answer)).toBe(false);
    const events = reply("msg_1", [SEARCH]);
    session.send(...events.slice(0, -2));
    void (await session.tools()).callTool(callFor("toolu_1"));
    await settle();
    expect(sessions.answer(SESSION, answer)).toBe(false);
    session.send(...events.slice(-2));
    await turn.next();
    await turn.next();
    expect(sessions.answer(SESSION, { ...answer, callId: "toolu_9" })).toBe(false);
    expect(sessions.answer(OTHER_SESSION, answer)).toBe(false);
    expect(sessions.answer(SESSION, answer)).toBe(true);
    // Answered once only.
    expect(sessions.answer(SESSION, answer)).toBe(false);
  });

  it("fails the turn when a call's result doesn't come by its deadline, before Claude Code's", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { start, last, conflict } = setup();
    const turn = await start();
    const session = last();
    await session.next();
    session.send(...reply("msg_1", [SEARCH]));
    // Claude Code waits as long as the server's timeout says.
    const timeout = session.kelpie.timeout as number;
    expect(timeout).toBe(120_000 + RESULT_GRACE_MS + CALL_TIMEOUT_MARGIN_MS);
    const call = (await session.tools()).callTool(callFor("toolu_1"), undefined, { timeout });
    await turn.next();
    await turn.next();
    vi.advanceTimersByTime(120_000 + RESULT_GRACE_MS - 1);
    await settle();
    vi.advanceTimersByTime(1);
    const all = await turn.rest();
    expect(all.filter((frame) => frame.type !== "ping")).toEqual([errorFrame("server_error")]);
    expect(await call).toEqual({
      content: [{ type: "text", text: STOPPED.output }],
      isError: true,
    });
    expect(session.closed).toBe(true);
    expect(await conflict(SESSION, { resume: true })).toBe("unfinished");
  });

  it("stops waiting for a call Claude Code cancels, and the turn goes on", async () => {
    const { sessions, start, last } = setup();
    const turn = await start();
    const session = last();
    await session.next();
    session.send(...reply("msg_1", [SEARCH]));
    const abort = new AbortController();
    const call = (await session.tools()).callTool(callFor("toolu_1"), undefined, {
      signal: abort.signal,
    });
    await turn.next();
    await turn.next();
    abort.abort();
    await expect(call).rejects.toThrow();
    await settle();
    expect(sessions.answer(SESSION, { callId: "toolu_1", output: "late" })).toBe(false);
    session.send(...answered("Done."));
    expect((await turn.rest()).at(-1)).toMatchObject({ type: "finish", reason: "stop" });
  });

  it("answers a call that comes after its turn ended with a stopped result", async () => {
    const { sessions, start, last } = setup();
    const turn = await start();
    const session = last();
    await session.next();
    session.send(...answered("Hello."));
    await turn.rest();
    expect(await (await session.tools()).callTool(callFor("toolu_1"))).toEqual({
      content: [{ type: "text", text: STOPPED.output }],
      isError: true,
    });
    expect(sessions.answer(SESSION, { callId: "toolu_1", output: "late" })).toBe(false);
  });

  it("gives a waiting call a stopped result when its turn ends", async () => {
    const { sessions, start, last } = setup();
    const turn = await start();
    const session = last();
    await session.next();
    session.send(...reply("msg_1", [SEARCH]));
    const call = (await session.tools()).callTool(callFor("toolu_1"));
    await turn.next();
    await turn.next();
    sessions.close(SESSION);
    expect(await turn.rest()).toEqual([errorFrame("server_error")]);
    expect(await call).toEqual({
      content: [{ type: "text", text: STOPPED.output }],
      isError: true,
    });
  });

  it("takes a call without arguments as an empty input", async () => {
    const { start, last } = setup();
    const turn = await start();
    const session = last();
    await session.next();
    session.send(...reply("msg_1", [{ ...SEARCH, input: {} }]));
    const { arguments: _, ...call } = callFor("toolu_1");
    void (await session.tools()).callTool(call);
    await turn.next();
    expect(await turn.next()).toMatchObject({
      type: "tool_call",
      call: { id: "toolu_1", input: {} },
    });
  });

  it("leaves usage out when the reply doesn't give it, never zeros", async () => {
    const { start, last } = setup();
    const turn = await start();
    const session = last();
    await session.next();
    session.send(...reply("msg_1", ["Hi."], { usage: null }), result(SESSION));
    expect((await turn.rest()).at(-1)).toMatchObject({ type: "finish", usage: [] });
  });

  it("takes a reply's final counts from its end, over those at its start", async () => {
    const { start, last } = setup();
    const turn = await start();
    const session = last();
    await session.next();
    const final = {
      input_tokens: 100,
      output_tokens: 7,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 300,
    };
    session.send(...reply("msg_1", ["Hi."], { final }), result(SESSION));
    expect((await turn.rest()).at(-1)).toMatchObject({
      type: "finish",
      usage: [
        {
          model: "claude-haiku-5-5",
          inputUncached: 100,
          cacheRead: 200,
          cacheWrite: 300,
          output: 7,
        },
      ],
    });
  });

  it("keeps each text block of the last reply", async () => {
    const { start, last } = setup();
    const turn = await start();
    const session = last();
    await session.next();
    session.send(...reply("msg_1", ["First.", "Second."]), result(SESSION));
    expect((await turn.rest()).at(-1)).toMatchObject({
      type: "finish",
      message: {
        role: "assistant",
        parts: [
          { type: "text", text: "First." },
          { type: "text", text: "Second." },
        ],
      },
    });
  });

  it("counts a reply that used no cache as no cached tokens", async () => {
    const { start, last } = setup();
    const turn = await start();
    const session = last();
    await session.next();
    const usage = {
      input_tokens: 5,
      output_tokens: 6,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
    };
    session.send(...reply("msg_1", ["Hi."], { usage }), result(SESSION));
    expect((await turn.rest()).at(-1)).toMatchObject({
      type: "finish",
      usage: [
        { model: "claude-haiku-5-5", inputUncached: 5, cacheRead: 0, cacheWrite: 0, output: 6 },
      ],
    });
  });

  it.each([
    ["max_tokens", "length"],
    ["model_context_window_exceeded", "length"],
    ["stop_sequence", "stop"],
  ])("maps the stop reason %s to %s", async (stop, reason) => {
    const { start, last } = setup();
    const turn = await start();
    const session = last();
    await session.next();
    // A call cut off by the limit never runs, so it stays out of the reply.
    session.send(...reply("msg_1", ["Long", SEARCH], { stop }), result(SESSION));
    expect((await turn.rest()).at(-1)).toMatchObject({
      type: "finish",
      reason,
      message: { parts: [{ type: "text", text: "Long" }] },
    });
  });

  it.each([
    ["the reply's stop reason", reply("msg_1", ["I can't help"], { stop: "refusal" })],
    ["Claude Code's notice", [system("model_refusal_no_fallback")]],
  ])("keeps a refusal a stop reason, from %s", async (_, messages) => {
    const { start, last } = setup();
    const turn = await start();
    const session = last();
    await session.next();
    session.send(...messages, apiError("invalid_request"), result(SESSION, { isError: true }));
    expect((await turn.rest()).at(-1)).toMatchObject({ type: "finish", reason: "refusal" });
  });

  it.each([
    ["after Claude Code compacted the session", [system("compact_boundary")], SESSION],
    ["when Claude Code names another session", [], OTHER_SESSION],
  ])("says the session isn't clean %s", async (_, before, id) => {
    const { start, last } = setup();
    const turn = await start();
    const session = last();
    await session.next();
    session.send(...before, ...answered("Hi.", id));
    expect((await turn.rest()).at(-1)).toMatchObject({
      type: "finish",
      session: { id, clean: false },
    });
  });

  it("ignores a subagent's messages, and what a reply's stream doesn't explain", async () => {
    const { start, last } = setup();
    const turn = await start();
    const session = last();
    await session.next();
    const event = (body: Record<string, unknown>) =>
      ({ type: "stream_event", event: body, parent_tool_use_id: null }) as unknown as SDKMessage;
    session.send(
      ...reply("msg_sub", ["Subagent text"], { parent: "toolu_0" }),
      apiError("rate_limit", "toolu_0"),
      // Events outside a reply.
      event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } }),
      event({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} }),
      event({ type: "message_stop" }),
      // A reply with thinking, a tool use without input and one whose input isn't JSON.
      event({ type: "message_start", message: { id: "msg_1", model: "m", usage: {} } }),
      event({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      }),
      event({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "hm" },
      }),
      event({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{" },
      }),
      event({
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "toolu_a",
          name: "mcp__kelpie__memory_search",
          input: {},
        },
      }),
      event({
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_use", id: "toolu_b", name: "Bash", input: {} },
      }),
      event({
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: "{oops" },
      }),
      event({
        type: "content_block_delta",
        index: 2,
        delta: { type: "text_delta", text: "stray" },
      }),
      event({
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 3 },
      }),
      event({ type: "message_stop" }),
    );
    expect(await turn.next()).toEqual({
      type: "round",
      message: {
        role: "assistant",
        parts: [
          { type: "tool_call", id: "toolu_a", name: "memory_search", input: {} },
          { type: "tool_call", id: "toolu_b", name: "Bash", input: "{oops" },
        ],
      },
      usage: [],
    });
    session.send(...answered("Hi."));
    expect(await turn.rest()).toEqual([
      { type: "text", delta: "Hi" },
      { type: "text", delta: "." },
      expect.objectContaining({ type: "finish", reason: "stop" }),
    ]);
  });
});

describe("a turn's failures", () => {
  const RESET_S = 1_792_000_000;
  it.each<[string, SDKMessage[], Record<string, unknown>]>([
    [
      "a rejected limit, with its reset in epoch ms",
      [
        rateLimit({ status: "rejected", resetsAt: RESET_S, rateLimitType: "five_hour" }),
        apiError("rate_limit"),
      ],
      { code: "rate_limited", resetsAt: RESET_S * 1000 },
    ],
    [
      "a rejected limit without a reset",
      [rateLimit({ status: "rejected" })],
      { code: "rate_limited" },
    ],
    [
      "spent included usage, which is verified",
      [
        rateLimit({ status: "rejected", errorCode: "credits_required", resetsAt: RESET_S }),
        apiError("rate_limit"),
      ],
      { code: "out_of_credits" },
    ],
    ["Claude Code's rate_limit error", [apiError("rate_limit")], { code: "rate_limited" }],
    [
      "a billing error, unverified",
      [apiError("billing_error")],
      { code: "out_of_credits", unverified: true },
    ],
    ["a failed login", [apiError("authentication_failed")], { code: "auth" }],
    [
      "an organization barred from Claude Code",
      [apiError("oauth_org_not_allowed")],
      { code: "auth" },
    ],
    ["an account on hold", [apiError("account_on_hold")], { code: "auth" }],
    ["an account to verify", [apiError("verification_required")], { code: "auth" }],
    ["another API error", [apiError("overloaded")], { code: "server_error" }],
    [
      "an allowed limit, which explains nothing",
      [rateLimit({ status: "allowed_warning", resetsAt: RESET_S }), apiError("overloaded")],
      { code: "server_error" },
    ],
  ])("reports %s", async (_, signals, expected) => {
    const { start, last } = setup();
    const turn = await start();
    const session = last();
    await session.next();
    session.send(...signals, result(SESSION, { isError: true }));
    const all = await turn.rest();
    expect(all).toEqual([errorFrame(expected.code as string, expected)]);
    // Claude Code's own text stays out of the frame.
    expect(JSON.stringify(all)).not.toContain("secret detail");
  });

  it.each<[string, SDKMessage[]]>([
    ["an error result", [result(SESSION, { subtype: "error_max_turns", isError: true })]],
    ["a result without a last reply", [...reply("msg_1", [SEARCH]), result(SESSION)]],
    ["a result before any reply", [result(SESSION)]],
  ])("reports %s as a server error", async (_, messages) => {
    const { start, last } = setup();
    const turn = await start();
    const session = last();
    await session.next();
    session.send(...messages);
    expect((await turn.rest()).at(-1)).toEqual(errorFrame("server_error"));
  });

  it("finishes a turn a limit didn't stop", async () => {
    const { start, last } = setup();
    const turn = await start();
    const session = last();
    await session.next();
    session.send(rateLimit({ status: "rejected", resetsAt: RESET_S }), ...answered("Hi."));
    expect((await turn.rest()).at(-1)).toMatchObject({ type: "finish", reason: "stop" });
  });

  it.each([
    [
      "crashes",
      new Error("Claude Code process exited with code 1: secret stderr"),
      "failed: Claude Code process exited with code 1: secret stderr",
    ],
    ["exits", undefined, "ended"],
  ])(
    "reports a server error when Claude Code %s mid-turn, and logs it on the runner only",
    async (_, error, logged) => {
      const { start, last, warnings, conflict } = setup();
      const turn = await start();
      const session = last();
      await session.next();
      session.exit(error);
      const all = await turn.rest();
      expect(all).toEqual([errorFrame("server_error")]);
      expect(JSON.stringify(all)).not.toContain("secret");
      expect(warnings).toEqual([`Claude Code's session ${SESSION} ${logged}`]);
      expect(await conflict(SESSION, { resume: true })).toBe("unfinished");
    },
  );

  it("logs a thrown value that isn't an Error", async () => {
    const { start, last, warnings } = setup();
    await start();
    last().exit("boom");
    await settle();
    expect(warnings).toEqual([`Claude Code's session ${SESSION} failed: boom`]);
  });
});

describe("sessions", () => {
  it("goes on with a resumed turn in the live session", async () => {
    const { claude, start, last } = setup();
    const first = await start();
    const session = last();
    await session.next();
    session.send(...answered("Hi."));
    await first.rest();
    const second = await start(SESSION, {
      resume: true,
      messages: [{ role: "user", parts: [{ type: "text", text: "And Bruno?" }] }],
    });
    expect(claude.sessions).toHaveLength(1);
    expect(await session.next()).toMatchObject({
      message: { content: [{ type: "text", text: "And Bruno?" }] },
    });
    session.send(...answered("In Porto."));
    expect((await second.rest()).at(-1)).toMatchObject({ type: "finish", reason: "stop" });
  });

  it("answers 409 for a session whose turn is still running", async () => {
    const { conflict, start } = setup();
    await start();
    expect(await conflict(SESSION, { resume: true })).toBe("unfinished");
  });

  it.each([
    ["another conversation's", { resume: true, conversation: "agent:other/owner" }],
    ["another prompt's", { resume: true, system: "You are someone else." }],
    ["another model's", { resume: true, model: "claude-sonnet-5-5" }],
    ["other tools'", { resume: true, tools: [] }],
    ["another bound's", { resume: true, toolLoopMs: 600_000 }],
    ["a new session's, with an id already live", { resume: false }],
  ])("answers 409 for %s turn on a live session", async (_, overrides) => {
    const { conflict, start, last } = setup();
    const turn = await start();
    await last().next();
    last().send(...answered("Hi."));
    await turn.rest();
    expect(await conflict(SESSION, overrides)).toBe("mismatched");
  });

  it("answers 409 for a new session whose id Claude Code already keeps", async () => {
    const { conflict } = setup({ onDisk: [SESSION] });
    expect(await conflict(SESSION)).toBe("mismatched");
  });

  it("answers 409 for a session to resume that is neither live nor on disk", async () => {
    const { conflict, claude } = setup();
    expect(await conflict(SESSION, { resume: true })).toBe("lost");
    expect(claude.sessions).toHaveLength(0);
  });

  it("answers 409 for a session whose last turn failed, and deletes its transcript", async () => {
    const { conflict, start, last, deleted } = setup();
    const turn = await start();
    await last().next();
    last().send(apiError("rate_limit"), result(SESSION, { isError: true }));
    await turn.rest();
    expect(last().closed).toBe(true);
    expect(deleted).toEqual([SESSION]);
    expect(await conflict(SESSION, { resume: true })).toBe("unfinished");
  });

  it("remembers the last unfinished sessions; an older one's deleted transcript can't resume", async () => {
    const { conflict, start, last } = setup({ maxUnfinished: 1 });
    for (const id of [SESSION, OTHER_SESSION]) {
      const turn = await start(id, { conversation: id });
      await last().next();
      last().send(result(id, { isError: true }));
      await turn.rest();
    }
    expect(await conflict(SESSION, { resume: true, conversation: SESSION })).toBe("lost");
    expect(await conflict(OTHER_SESSION, { resume: true, conversation: OTHER_SESSION })).toBe(
      "unfinished",
    );
    expect(MAX_UNFINISHED).toBe(1_000);
  });

  it("logs a transcript it couldn't delete, on one line", async () => {
    const { start, last, warnings } = setup({ deleteFails: true });
    const turn = await start();
    await last().next();
    last().send(result(SESSION, { isError: true }));
    await turn.rest();
    await settle();
    expect(warnings).toEqual([
      `Couldn't delete Claude Code's session ${SESSION}: Error: EACCES: permission denied`,
    ]);
  });

  it("refuses the second of two new sessions racing for one id", async () => {
    const { sessions, claude } = setup();
    const [first, second] = await Promise.all([
      sessions.turn(SESSION, turnRequest()),
      sessions.turn(SESSION, turnRequest()),
    ]);
    expect(first).toHaveProperty("stream");
    expect(second).toEqual({ status: 409, reason: "mismatched" });
    expect(claude.sessions).toHaveLength(1);
  });

  it("closes a conversation's old session when it starts a new one", async () => {
    const { claude, start, last } = setup();
    const turn = await start();
    await last().next();
    last().send(...answered("Hi."));
    await turn.rest();
    await start(OTHER_SESSION);
    expect(claude.sessions.map((session) => session.closed)).toEqual([true, false]);
  });

  it("closes an idle session after 15 minutes, and a later turn resumes it from disk", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { claude, start, last, warnings } = setup();
    const turn = await start();
    await last().next();
    last().send(...answered("Hi."));
    await turn.rest();
    vi.advanceTimersByTime(IDLE_MS - 1);
    expect(last().closed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(last().closed).toBe(true);
    await settle();
    expect(warnings).toEqual([]);
    await start(SESSION, { resume: true });
    expect(claude.sessions).toHaveLength(2);
    expect(last().options.resume).toBe(SESSION);
    expect(IDLE_MS).toBe(15 * 60_000);
  });

  it("keeps a session that a turn uses from closing as idle", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { start, last } = setup();
    const first = await start();
    await last().next();
    last().send(...answered("Hi."));
    await first.rest();
    vi.advanceTimersByTime(IDLE_MS - 1);
    await start(SESSION, { resume: true });
    vi.advanceTimersByTime(IDLE_MS);
    expect(last().closed).toBe(false);
  });

  it("closes a session on DELETE, which a later turn may resume", async () => {
    const { sessions, start, last, claude, deleted } = setup();
    const turn = await start();
    await last().next();
    last().send(...answered("Hi."));
    await turn.rest();
    sessions.close(SESSION);
    expect(last().closed).toBe(true);
    // A session that isn't live closes as nothing.
    sessions.close(OTHER_SESSION);
    await settle();
    await start(SESSION, { resume: true });
    expect(claude.sessions).toHaveLength(2);
    expect(deleted).toEqual([]);
  });

  it("fails a running turn on DELETE, and its session can't be resumed", async () => {
    const { sessions, start, last, conflict } = setup();
    const turn = await start();
    sessions.close(SESSION);
    expect(await turn.rest()).toEqual([errorFrame("server_error")]);
    expect(last().closed).toBe(true);
    expect(await conflict(SESSION, { resume: true })).toBe("unfinished");
  });

  it("closes the session when Kelpie drops a turn's stream", async () => {
    const { start, last, conflict } = setup();
    const turn = await start();
    await last().next();
    last().send(...reply("msg_1", ["Partial"]).slice(0, 3));
    await turn.next();
    await turn.cancel();
    expect(last().closed).toBe(true);
    expect(await conflict(SESSION, { resume: true })).toBe("unfinished");
  });

  it("stays resumable when Claude Code exits between turns", async () => {
    const { claude, start, last, warnings } = setup();
    const turn = await start();
    await last().next();
    last().send(...answered("Hi."));
    await turn.rest();
    last().exit();
    await settle();
    expect(warnings).toEqual([`Claude Code's session ${SESSION} ended`]);
    await start(SESSION, { resume: true });
    expect(claude.sessions).toHaveLength(2);
  });

  it("ends the session's input when it closes", async () => {
    const { sessions, start, last } = setup();
    const turn = await start();
    const session = last();
    await session.next();
    session.send(...answered("Hi."));
    await turn.rest();
    const next = session.next();
    sessions.close(SESSION);
    expect(await next).toBeUndefined();
  });
});

describe("a session's isolation, checked on Claude Code's init", () => {
  it("lets the turn go on when Claude Code has only Kelpie's tools, its server and the login", async () => {
    const { start, last, warnings } = setup();
    const turn = await start();
    await last().next();
    last().send(init(), ...answered("Hi."));
    expect((await turn.rest()).at(-1)).toMatchObject({ type: "finish", reason: "stop" });
    expect(warnings).toEqual([]);
  });

  it.each([
    [
      "a built-in tool",
      { tools: ["mcp__kelpie__memory_search", "Bash"] },
      "a tool other than Kelpie's, Bash",
    ],
    [
      "a claude.ai connector",
      {
        mcp_servers: [
          { name: "kelpie", status: "connected", source: "sdk" },
          { name: "claude.ai Google Drive", status: "connected", source: "claudeai" },
        ],
      },
      "MCP servers other than Kelpie's",
    ],
    [
      "a configured server named as Kelpie's",
      { mcp_servers: [{ name: "kelpie", status: "connected", source: "user" }] },
      "MCP servers other than Kelpie's",
    ],
    ["no MCP server", { mcp_servers: [] }, "MCP servers other than Kelpie's: []"],
    [
      "an API key",
      { apiKeySource: "ANTHROPIC_API_KEY" },
      "a credential other than the server's login: ANTHROPIC_API_KEY",
    ],
  ])("fails the turn on %s, and closes the session as unfinished", async (_, fields, logged) => {
    const { start, last, warnings, deleted, conflict } = setup();
    const turn = await start();
    await last().next();
    last().send(init(fields), ...answered("Hi."));
    expect(await turn.rest()).toEqual([errorFrame("server_error")]);
    await settle();
    expect(warnings).toEqual([
      expect.stringContaining(`Claude Code's session ${SESSION} isn't isolated: ${logged}`),
    ]);
    expect(last().closed).toBe(true);
    expect(deleted).toEqual([SESSION]);
    expect(await conflict(SESSION, { resume: true })).toBe("unfinished");
  });
});

describe("a reply that didn't stream", () => {
  it("goes out as a round when Claude Code runs its calls", async () => {
    const { sessions, start, last } = setup();
    const turn = await start();
    const session = last();
    await session.next();
    session.send(whole("msg_1", ["Looking.", SEARCH]));
    expect(await turn.next()).toEqual({ type: "text", delta: "Looking." });
    expect(await turn.next()).toEqual({
      type: "round",
      message: {
        role: "assistant",
        parts: [
          { type: "text", text: "Looking." },
          { type: "tool_call", id: "toolu_1", name: "memory_search", input: { query: "Ana" } },
        ],
      },
      usage: USAGE,
    });
    const call = (await session.tools()).callTool(callFor("toolu_1"));
    expect(await turn.next()).toMatchObject({ type: "tool_call", call: { id: "toolu_1" } });
    sessions.answer(SESSION, { callId: "toolu_1", output: "Lisbon" });
    expect(await call).toEqual({ content: [{ type: "text", text: "Lisbon" }] });
  });

  it("goes out as the finish when it is the last reply", async () => {
    const { start, last } = setup();
    const turn = await start();
    const session = last();
    await session.next();
    // A stream that failed partway, then the reply Claude Code asked for again without one.
    const lisbon = whole("msg_2", ["", "Lisbon."]);
    // Its thinking isn't Kelpie's to keep.
    (lisbon as unknown as { message: { content: unknown[] } }).message.content.unshift({
      type: "thinking",
      thinking: "The note says Lisbon.",
    });
    session.send(...reply("msg_1", ["Lis"]).slice(0, 3), lisbon);
    // A reply that comes twice counts once.
    session.send(whole("msg_2", ["Lisbon."]), result(SESSION));
    expect(await turn.rest()).toEqual([
      { type: "text", delta: "Li" },
      { type: "text", delta: "Lisbon." },
      {
        type: "finish",
        reason: "stop",
        message: { role: "assistant", parts: [{ type: "text", text: "Lisbon." }] },
        usage: USAGE,
        session: { id: SESSION, clean: true },
      },
    ]);
  });
});

describe("a turn's keepalive", () => {
  it("sends a ping after each 20 s the stream stays silent, until the turn ends", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { start, last } = setup();
    const turn = await start();
    const session = last();
    await session.next();
    vi.advanceTimersByTime(PING_MS);
    const events = reply("msg_1", ["Hi."]);
    session.send(...events.slice(0, 3));
    await settle();
    vi.advanceTimersByTime(PING_MS - 1);
    await settle();
    vi.advanceTimersByTime(1);
    session.send(...events.slice(3), result(SESSION));
    await settle();
    vi.advanceTimersByTime(10 * PING_MS);
    expect(await turn.rest()).toEqual([
      { type: "ping" },
      { type: "text", delta: "Hi" },
      { type: "ping" },
      { type: "text", delta: "." },
      expect.objectContaining({ type: "finish" }),
    ]);
    expect(PING_MS).toBe(20_000);
  });
});

describe("the runner's limits", () => {
  const id = (n: number) => `${String(n).padStart(8, "0")}-2222-4333-8444-555555555555`;

  it("closes the session idle the longest to make room past 4 live sessions", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { claude, start } = setup();
    const turnOn = async (n: number, resume: boolean) => {
      vi.setSystemTime(n * 1_000);
      const turn = await start(id(n % 10), { conversation: `c${n % 10}`, resume });
      const session = claude.sessions[(n % 10) - 1] as FakeSession;
      await session.next();
      session.send(...answered("Hi.", id(n % 10)));
      await turn.rest();
    };
    for (let n = 1; n <= MAX_LIVE; n += 1) await turnOn(n, false);
    // The first session's later turn leaves the second idle the longest.
    await turnOn(11, true);
    vi.setSystemTime(12_000);
    await start(id(5), { conversation: "c5" });
    expect(claude.sessions.map((session) => session.closed)).toEqual([
      false,
      true,
      false,
      false,
      false,
    ]);
    // It stays resumable.
    await start(id(2), { conversation: "c2", resume: true });
    expect(claude.sessions).toHaveLength(6);
    expect(MAX_LIVE).toBe(4);
  });

  it("answers 503 when every live session runs a turn", async () => {
    const { claude, start, conflict } = setup({ maxLive: 2 });
    await start(id(1), { conversation: "c1" });
    await start(id(2), { conversation: "c2" });
    expect(await conflict(id(3), { conversation: "c3" })).toBe("full");
    expect(claude.sessions).toHaveLength(2);
  });

  it("replaces a conversation's running session even at the cap: its turn fails, unfinished", async () => {
    const { claude, start, conflict } = setup({ maxLive: 1 });
    const old = await start(id(1), { conversation: "c1" });
    await start(id(2), { conversation: "c1" });
    expect(await old.rest()).toEqual([errorFrame("server_error")]);
    expect(claude.sessions.map((session) => session.closed)).toEqual([true, false]);
    expect(await conflict(id(1), { conversation: "c1", resume: true })).toBe("unfinished");
  });

  it("answers 429 past the turns a minute allows, with the seconds to wait", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(100_000);
    const { sessions, start, last } = setup({ turnsPerMinute: 2 });
    const first = await start();
    await last().next();
    last().send(...answered("Hi."));
    await first.rest();
    vi.setSystemTime(110_000);
    await start(SESSION, { resume: true });
    vi.setSystemTime(120_000);
    expect(await sessions.turn(OTHER_SESSION, turnRequest({ conversation: "c2" }))).toEqual({
      status: 429,
      reason: "rate",
      retryAfter: 40,
    });
    vi.setSystemTime(160_001);
    expect(await sessions.turn(OTHER_SESSION, turnRequest({ conversation: "c2" }))).toHaveProperty(
      "stream",
    );
    expect(TURNS_PER_MINUTE).toBe(30);
  });
});

describe("a session's process", () => {
  it("fails the turn when it doesn't begin with its init, and the session closes unfinished", async () => {
    const { start, last, warnings, deleted, conflict } = setup();
    const turn = await start();
    const session = last();
    await session.next();
    session.begins = false;
    session.send(...answered("Hi."));
    expect(await turn.rest()).toEqual([errorFrame("server_error")]);
    await settle();
    expect(warnings).toEqual([
      `Claude Code's session ${SESSION} didn't begin with its init, but stream_event`,
    ]);
    expect(session.closed).toBe(true);
    expect(deleted).toEqual([SESSION]);
    expect(await conflict(SESSION, { resume: true })).toBe("unfinished");
  });

  it("isn't asked for its init once its session closed", async () => {
    const { sessions, start, last, warnings } = setup();
    await start();
    const session = last();
    session.begins = false;
    session.send(...answered("Hi."));
    sessions.close(SESSION);
    await settle();
    expect(warnings).toEqual([]);
  });

  it("deletes an unfinished session's transcript only once its process exited", async () => {
    const { sessions, start, last, deleted } = setup();
    await start();
    const session = last();
    session.lingers = true;
    sessions.close(SESSION);
    await settle();
    expect(deleted).toEqual([]);
    session.exit();
    await settle();
    expect(deleted).toEqual([SESSION]);
  });

  it("leaves alone an unfinished session whose transcript Claude Code never wrote", async () => {
    const { sessions, start, deleted, warnings } = setup({ neverWritten: [SESSION] });
    await start();
    sessions.close(SESSION);
    await settle();
    expect(deleted).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("logs a ping that can't go out, and the turn goes on", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { start, last, warnings } = setup();
    const turn = await start();
    const session = last();
    await session.next();
    const encode = vi.spyOn(TextEncoder.prototype, "encode").mockImplementationOnce(() => {
      throw new Error("the stream broke");
    });
    expect(() => vi.advanceTimersByTime(PING_MS)).not.toThrow();
    encode.mockRestore();
    expect(warnings).toEqual([`A ping of session ${SESSION} failed: Error: the stream broke`]);
    session.send(...answered("Hi."));
    expect((await turn.rest()).at(-1)).toMatchObject({ type: "finish", reason: "stop" });
  });
});

describe("the runner's admission", () => {
  const id = (n: number) => `${String(n).padStart(8, "0")}-2222-4333-8444-555555555555`;

  it("counts a turn when it is admitted, so a burst can't go past the minute's", async () => {
    const { sessions, claude } = setup({ turnsPerMinute: 2 });
    const started = await Promise.all(
      [1, 2, 3].map((n) => sessions.turn(id(n), turnRequest({ conversation: `c${n}` }))),
    );
    expect(started.map((turn) => ("stream" in turn ? "started" : turn.status))).toEqual([
      "started",
      "started",
      429,
    ]);
    expect(claude.sessions).toHaveLength(2);
  });

  it("gives a refused turn's place back", async () => {
    const { conflict } = setup({ turnsPerMinute: 1 });
    expect(await conflict(SESSION, { resume: true })).toBe("lost");
    expect(await conflict(SESSION)).toBe("started");
  });

  it("counts a closed session until its process exits", async () => {
    const { claude, start, conflict } = setup({ maxLive: 2 });
    for (const n of [1, 2]) {
      const turn = await start(id(n), { conversation: `c${n}` });
      const session = claude.sessions[n - 1] as FakeSession;
      await session.next();
      session.lingers = true;
      session.send(...answered("Hi.", id(n)));
      await turn.rest();
    }
    // The first session closes to make room, but its process lingers.
    await start(id(3), { conversation: "c3" });
    expect(claude.sessions.map((session) => session.closed)).toEqual([true, false, false]);
    expect(await conflict(id(4), { conversation: "c4" })).toBe("full");
    // Its transcript can't be taken while it may still write it.
    expect(await conflict(id(1), { conversation: "c1", resume: true })).toBe("unfinished");
    claude.sessions[0]?.exit();
    await settle();
    expect(await conflict(id(4), { conversation: "c4" })).toBe("started");
  });
});
