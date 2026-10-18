import { describe, expect, it } from "vitest";
import {
  isRunnerTime,
  isRunnerToolLoopMs,
  parseRunnerToolResult,
  parseRunnerTurnRequest,
  parseRunnerVpsSessions,
  parseRunnerVpsWaits,
  RUNNER_MAX_EXCERPT_CHARS,
  RUNNER_MAX_TITLE_CHARS,
  RUNNER_MAX_VPS_SESSIONS,
  RUNNER_PROTOCOL,
  RUNNER_SESSION_ID,
  type RunnerTurnRequest,
  type RunnerVpsSession,
  type RunnerVpsWait,
  runnerJsonLength,
} from "../src/runner.ts";

// The checks the runner makes on what it receives, and channel-egress on what it relays (#420).

const SESSION = "11111111-2222-4333-8444-555555555555";

function turnRequest(overrides: Partial<RunnerTurnRequest> = {}): RunnerTurnRequest {
  return {
    conversation: "agent:kelpie/owner",
    resume: false,
    model: "claude-haiku-5-5",
    system: "You are Kelpie.",
    tools: [
      {
        name: "memory_search",
        description: "Searches memory.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string", minLength: 1 } },
          required: ["query"],
          additionalProperties: false,
        },
      },
    ],
    messages: [{ role: "user", parts: [{ type: "text", text: "Where does Ana live?" }] }],
    toolLoopMs: 120_000,
    ...overrides,
  };
}

const TOOL = turnRequest().tools[0];

/** A schema whose JSON nests `depth` objects and arrays: itself, then lists in lists. */
function nested(depth: number): Record<string, unknown> {
  let value: unknown[] = [];
  for (let level = 2; level < depth; level += 1) value = [value];
  return { type: "object", default: value };
}

function cyclic(): Record<string, unknown> {
  const schema: Record<string, unknown> = { type: "object" };
  schema.properties = { self: schema };
  return schema;
}
const withTool = (tool: unknown) => ({ ...turnRequest(), tools: [tool] });
const withMessage = (message: unknown) => ({ ...turnRequest(), messages: [message] });
const withPart = (part: unknown) => withMessage({ role: "user", parts: [part] });
const without = (key: string) => {
  const { [key as keyof ReturnType<typeof turnRequest>]: _, ...rest } = turnRequest();
  return rest;
};

describe("parseRunnerTurnRequest", () => {
  it("takes a turn's body as it is", () => {
    expect(parseRunnerTurnRequest(turnRequest())).toEqual(turnRequest());
    const resumed = turnRequest({
      resume: true,
      tools: [],
      toolLoopMs: 600_000,
      model: "claude-opus-5-5[1m]",
    });
    expect(parseRunnerTurnRequest(resumed)).toEqual(resumed);
  });

  it.each([
    ["a body that isn't an object", []],
    ["null", null],
    ["an extra field", { ...turnRequest(), effort: "high" }],
    ...["conversation", "resume", "model", "system", "tools", "messages", "toolLoopMs"].map(
      (key) => [`a body without ${key}`, without(key)] as [string, unknown],
    ),
    ["an empty conversation", { ...turnRequest(), conversation: "" }],
    ["a conversation over 256 characters", { ...turnRequest(), conversation: "c".repeat(257) }],
    ["a resume that isn't a boolean", { ...turnRequest(), resume: "true" }],
    ["a model with a space", { ...turnRequest(), model: "claude haiku" }],
    ["a model that isn't a string", { ...turnRequest(), model: 5 }],
    ["a model over 128 characters", { ...turnRequest(), model: `m${"x".repeat(128)}` }],
    ["an empty system prompt", { ...turnRequest(), system: "" }],
    ["a system prompt over 200,000 characters", { ...turnRequest(), system: "s".repeat(200_001) }],
    ["a bound under a second", { ...turnRequest(), toolLoopMs: 999 }],
    ["a bound over an hour", { ...turnRequest(), toolLoopMs: 3_600_001 }],
    ["a bound that isn't whole", { ...turnRequest(), toolLoopMs: 120_000.5 }],
    ["a bound as text", { ...turnRequest(), toolLoopMs: "120000" }],
    ["tools that aren't a list", { ...turnRequest(), tools: {} }],
    [
      "over 128 tools",
      {
        ...turnRequest(),
        tools: Array.from({ length: 129 }, (_, i) => ({ ...TOOL, name: `t${i}` })),
      },
    ],
    ["a tool with an extra field", withTool({ ...TOOL, strict: true })],
    ["a tool without a schema", withTool({ name: "t", description: "d" })],
    ["a tool name with a dot", withTool({ ...TOOL, name: "memory.search" })],
    ["a tool name over 64 characters", withTool({ ...TOOL, name: "t".repeat(65) })],
    ["a tool name that isn't a string", withTool({ ...TOOL, name: 1 })],
    ["two tools of one name", { ...turnRequest(), tools: [TOOL, TOOL] }],
    [
      "a description over 10,000 characters",
      withTool({ ...TOOL, description: "d".repeat(10_001) }),
    ],
    ["a description that isn't a string", withTool({ ...TOOL, description: null })],
    ["a schema that isn't an object", withTool({ ...TOOL, inputSchema: [] })],
    ["a schema for an array", withTool({ ...TOOL, inputSchema: { type: "array" } })],
    [
      "a schema over 64 KiB as JSON",
      withTool({ ...TOOL, inputSchema: { type: "object", description: "d".repeat(64 * 1024) } }),
    ],
    [
      "schemas over 1 MiB together, each within 64 KiB",
      {
        ...turnRequest(),
        tools: Array.from({ length: 17 }, (_, i) => ({
          ...TOOL,
          name: `t${i}`,
          inputSchema: { type: "object", description: "d".repeat(64_000) },
        })),
      },
    ],
    ["a schema nested deeper than 64", withTool({ ...TOOL, inputSchema: nested(65) })],
    ["a schema with a BigInt", withTool({ ...TOOL, inputSchema: { type: "object", default: 1n } })],
    ["a schema with a cycle", withTool({ ...TOOL, inputSchema: cyclic() })],
    [
      "a schema with a number JSON can't write",
      withTool({ ...TOOL, inputSchema: { type: "object", maximum: Number.POSITIVE_INFINITY } }),
    ],
    [
      "a schema with an object other than a plain one",
      withTool({ ...TOOL, inputSchema: { type: "object", default: new Date(0) } }),
    ],
    [
      "a schema with a function",
      withTool({ ...TOOL, inputSchema: { type: "object", default: () => 1 } }),
    ],
    ["messages that aren't a list", { ...turnRequest(), messages: "Hi" }],
    ["no message", { ...turnRequest(), messages: [] }],
    [
      "over 1,000 messages",
      { ...turnRequest(), messages: Array(1_001).fill(turnRequest().messages[0]) },
    ],
    [
      "an assistant message",
      withMessage({ role: "assistant", parts: [{ type: "text", text: "x" }] }),
    ],
    ["a message with an extra field", withMessage({ ...turnRequest().messages[0], name: "x" })],
    ["a message without parts", withMessage({ role: "user", parts: [] })],
    ["parts that aren't a list", withMessage({ role: "user", parts: "x" })],
    [
      "over 1,000 parts",
      withMessage({ role: "user", parts: Array(1_001).fill({ type: "text", text: "x" }) }),
    ],
    ["an image part", withPart({ type: "image", text: "x" })],
    ["a part with an extra field", withPart({ type: "text", text: "x", cache: true })],
    ["an empty text", withPart({ type: "text", text: "" })],
    ["a text that isn't a string", withPart({ type: "text", text: 1 })],
  ])("refuses %s", (_, body) => {
    expect(parseRunnerTurnRequest(body)).toBeNull();
  });
});

describe("parseRunnerToolResult", () => {
  it("takes a result, with or without its error mark", () => {
    expect(parseRunnerToolResult({ callId: "toolu_1", output: "" })).toEqual({
      callId: "toolu_1",
      output: "",
    });
    expect(
      parseRunnerToolResult({ callId: "toolu_1", output: "x".repeat(20_000), isError: true }),
    ).toEqual({
      callId: "toolu_1",
      output: "x".repeat(20_000),
      isError: true,
    });
  });

  it.each([
    ["a list", []],
    ["an extra field", { callId: "toolu_1", output: "x", name: "memory_search" }],
    ["no call id", { output: "x" }],
    ["an empty call id", { callId: "", output: "x" }],
    ["a call id over 256 characters", { callId: "t".repeat(257), output: "x" }],
    ["no output", { callId: "toolu_1" }],
    ["an output that isn't text", { callId: "toolu_1", output: { text: "x" } }],
    ["an output over 20,000 characters", { callId: "toolu_1", output: "x".repeat(20_001) }],
    ["an error mark that isn't a boolean", { callId: "toolu_1", output: "x", isError: "yes" }],
  ])("refuses %s", (_, body) => {
    expect(parseRunnerToolResult(body)).toBeNull();
  });
});

describe("a tool's schema", () => {
  it("takes one of 64 KiB as JSON, and 1 MiB for all the tools together", () => {
    const schema = (length: number) => {
      const value = { type: "object", description: "" };
      value.description = "d".repeat(length - JSON.stringify(value).length);
      return value;
    };
    expect(JSON.stringify(schema(64 * 1024))).toHaveLength(64 * 1024);
    const one = withTool({ ...TOOL, inputSchema: schema(64 * 1024) });
    expect(parseRunnerTurnRequest(one)).toEqual(one);
    const all = {
      ...turnRequest(),
      tools: Array.from({ length: 16 }, (_, i) => ({
        ...TOOL,
        name: `t${i}`,
        inputSchema: schema(64 * 1024),
      })),
    };
    expect(parseRunnerTurnRequest(all)).toEqual(all);
    expect(parseRunnerTurnRequest(withTool({ ...TOOL, inputSchema: nested(64) }))).not.toBeNull();
  });
});

describe("runnerJsonLength", () => {
  it("counts a value as JSON.stringify writes it, a property without a value left out", () => {
    const value = {
      type: "object",
      properties: { query: { type: "string", minLength: 1, enum: ["a", "b"] } },
      required: ["query"],
      additionalProperties: false,
      nothing: null,
      unset: undefined,
      list: [1.5, -2, true, null, [], {}],
    };
    expect(runnerJsonLength(value, 1_000)).toBe(JSON.stringify(value).length);
  });

  it("stops as soon as the count passes its budget", () => {
    let read = 0;
    const wide: Record<string, string> = {};
    for (let i = 0; i < 1_000; i += 1) {
      Object.defineProperty(wide, `k${i}`, {
        enumerable: true,
        get: () => {
          read += 1;
          return "v".repeat(100);
        },
      });
    }
    expect(runnerJsonLength(wide, 1_000)).toBeNull();
    expect(read).toBeLessThanOrEqual(10);
  });
});

describe("isRunnerToolLoopMs", () => {
  it("takes a whole bound from a second to an hour, as llm-gateway checks a session's (#421)", () => {
    for (const bound of [1_000, 120_000, 3_600_000]) expect(isRunnerToolLoopMs(bound)).toBe(true);
    for (const bound of [999, 3_600_001, 120_000.5, "120000", null, Number.NaN]) {
      expect(isRunnerToolLoopMs(bound)).toBe(false);
    }
  });
});

describe("RUNNER_SESSION_ID", () => {
  it("takes a lowercase UUID only", () => {
    expect(RUNNER_SESSION_ID.test(SESSION)).toBe(true);
    expect(RUNNER_SESSION_ID.test(crypto.randomUUID())).toBe(true);
    expect(RUNNER_SESSION_ID.test(SESSION.replace("1", "A"))).toBe(false);
    expect(RUNNER_SESSION_ID.test(`${SESSION}\n`)).toBe(false);
  });
});

// The VPS's sessions (ADR-0057, #433): channel-egress checks the runner's answers with these.

const NOW = Date.UTC(2026, 9, 17, 18, 0, 0);

function vpsSession(overrides: Partial<RunnerVpsSession> = {}): RunnerVpsSession {
  return {
    id: SESSION,
    state: "waiting_permission",
    since: NOW - 60_000,
    archivable: false,
    status: "busy",
    statusUpdatedAt: NOW - 600_000,
    startedAt: NOW - 3_600_000,
    alive: true,
    startedBy: "app",
    entrypoint: "claude-desktop",
    title: "Review the runner",
    repository: "kelpie",
    branch: "feat/runner-vps-sessions",
    prUrl: "https://github.com/guedesdiogo/kelpie/pull/433",
    excerpt: "Opened the PR.",
    ...overrides,
  };
}

const sessionsAnswer = (sessions: unknown[], extra: Record<string, unknown> = {}) => ({
  ok: true,
  now: NOW,
  sessions,
  truncated: false,
  ...extra,
});

function vpsWait(overrides: Partial<RunnerVpsWait> = {}): RunnerVpsWait {
  return {
    sessionId: SESSION,
    kind: "question",
    openedAt: NOW - 60_000,
    title: "Review the runner",
    repository: "kelpie",
    ...overrides,
  };
}

const waitsAnswer = (waits: unknown[], extra: Record<string, unknown> = {}) => ({
  ok: true,
  now: NOW,
  waits,
  truncated: false,
  ...extra,
});

describe("parseRunnerVpsSessions", () => {
  it("is protocol 3's", () => {
    expect(RUNNER_PROTOCOL).toBe(3);
  });

  it("takes the runner's list as it is, nulls included", () => {
    const blank = vpsSession({
      state: "unknown",
      since: null,
      status: "unknown",
      statusUpdatedAt: null,
      startedAt: null,
      alive: null,
      startedBy: "unknown",
      entrypoint: null,
      title: null,
      repository: null,
      branch: null,
      prUrl: null,
      excerpt: null,
    });
    const answer = sessionsAnswer([vpsSession(), blank], { truncated: true });
    expect(parseRunnerVpsSessions(answer)).toEqual(answer);
    expect(parseRunnerVpsSessions(sessionsAnswer([]))).toEqual(sessionsAnswer([]));
  });

  it.each([
    ["a body that isn't an object", null],
    ["ok false", { ...sessionsAnswer([]), ok: false }],
    ["an extra field", { ...sessionsAnswer([]), extra: 1 }],
    ["no now", { ok: true, sessions: [], truncated: false }],
    ["a now that isn't a time", sessionsAnswer([], { now: -1 })],
    ["a truncated that isn't a boolean", sessionsAnswer([], { truncated: "no" })],
    ["sessions that aren't a list", sessionsAnswer([], { sessions: {} })],
    [
      "too many sessions",
      sessionsAnswer(Array.from({ length: RUNNER_MAX_VPS_SESSIONS + 1 }, () => vpsSession())),
    ],
    ["a session that isn't an object", sessionsAnswer(["x"])],
    ["a session with an extra field", sessionsAnswer([{ ...vpsSession(), cwd: "/home" }])],
    ["a session without its excerpt", sessionsAnswer([{ ...vpsSession(), excerpt: undefined }])],
    ["an id that isn't a UUID", sessionsAnswer([vpsSession({ id: "../x" })])],
    ["another state", sessionsAnswer([vpsSession({ state: "sleeping" as never })])],
    ["another status", sessionsAnswer([vpsSession({ status: "busy!" as never })])],
    ["another starter", sessionsAnswer([vpsSession({ startedBy: "kelpie" as never })])],
    [
      "an archivable that isn't a boolean",
      sessionsAnswer([vpsSession({ archivable: 1 as never })]),
    ],
    ["an alive that isn't a boolean", sessionsAnswer([vpsSession({ alive: "yes" as never })])],
    ["a since that isn't a time", sessionsAnswer([vpsSession({ since: 1.5 })])],
    ["a statusUpdatedAt that isn't a time", sessionsAnswer([vpsSession({ statusUpdatedAt: -1 })])],
    ["a startedAt that isn't a time", sessionsAnswer([vpsSession({ startedAt: "now" as never })])],
    ["an entrypoint with markup", sessionsAnswer([vpsSession({ entrypoint: "<b>" })])],
    ["an entrypoint that isn't text", sessionsAnswer([vpsSession({ entrypoint: 1 as never })])],
    [
      "a link that isn't a pull request's",
      sessionsAnswer([vpsSession({ prUrl: "https://evil.example/pull/1" })]),
    ],
    ["a link that isn't text", sessionsAnswer([vpsSession({ prUrl: 1 as never })])],
    [
      "a title too long",
      sessionsAnswer([vpsSession({ title: "t".repeat(RUNNER_MAX_TITLE_CHARS + 1) })]),
    ],
    ["an empty title", sessionsAnswer([vpsSession({ title: "" })])],
    ["a repository too long", sessionsAnswer([vpsSession({ repository: "r".repeat(201) })])],
    ["a branch too long", sessionsAnswer([vpsSession({ branch: "b".repeat(256) })])],
    [
      "an excerpt too long",
      sessionsAnswer([vpsSession({ excerpt: "e".repeat(RUNNER_MAX_EXCERPT_CHARS + 1) })]),
    ],
  ])("refuses %s", (_, value) => {
    expect(parseRunnerVpsSessions(value)).toBeNull();
  });
});

describe("the VPS's one-line fields", () => {
  it.each([
    ["a line break", "a\nb"],
    ["a carriage return", "a\rb"],
    ["a bell", "a\u0007b"],
    ["a C1 control", "a\u0085b"],
    ["a line separator", "a\u2028b"],
    ["a right-to-left override", "a\u202eb"],
    ["a left-to-right isolate", "a\u2066b"],
    ["a right-to-left mark", "a\u200fb"],
    ["a zero-width space", "a\u200bb"],
    ["a zero-width non-joiner", "a\u200cb"],
    ["a zero-width joiner", "a\u200db"],
    ["a word joiner", "a\u2060b"],
    ["a byte-order mark", "a\ufeffb"],
    ["a Hangul filler", "a\u3164b"],
    ["a tag character", "a\u{e0041}b"],
    ["a cancel tag", "a\u{e007f}b"],
  ])("refuses %s in a title, a repository or a branch", (_, text) => {
    for (const field of ["title", "repository", "branch"] as const) {
      expect(parseRunnerVpsSessions(sessionsAnswer([vpsSession({ [field]: text })]))).toBeNull();
    }
    for (const field of ["title", "repository"] as const) {
      expect(parseRunnerVpsWaits(waitsAnswer([vpsWait({ [field]: text })]))).toBeNull();
    }
  });

  it("takes an excerpt of several lines, and a title in any script", () => {
    const session = vpsSession({ excerpt: "Done.\nThe PR is open.", title: "Revisão do 漢 🦭" });
    expect(parseRunnerVpsSessions(sessionsAnswer([session]))).toEqual(sessionsAnswer([session]));
  });
});

describe("parseRunnerVpsWaits", () => {
  it("takes the runner's waits as they are", () => {
    const answer = waitsAnswer([
      vpsWait(),
      vpsWait({ kind: "permission", title: null, repository: null }),
    ]);
    expect(parseRunnerVpsWaits(answer)).toEqual(answer);
  });

  it.each([
    ["a body that isn't an object", "x"],
    ["ok false", { ...waitsAnswer([]), ok: false }],
    ["a now that isn't a time", waitsAnswer([], { now: "now" })],
    ["a truncated that isn't a boolean", waitsAnswer([], { truncated: null })],
    ["waits that aren't a list", waitsAnswer([], { waits: "none" })],
    [
      "too many waits",
      waitsAnswer(Array.from({ length: RUNNER_MAX_VPS_SESSIONS + 1 }, () => vpsWait())),
    ],
    ["a wait with an extra field", waitsAnswer([{ ...vpsWait(), excerpt: "x" }])],
    [
      "a session id that isn't a UUID",
      waitsAnswer([vpsWait({ sessionId: "ABCDEF11-2222-4333-8444-555555555555" })]),
    ],
    ["another kind", waitsAnswer([vpsWait({ kind: "idle" as never })])],
    ["an openedAt that isn't a time", waitsAnswer([vpsWait({ openedAt: -5 })])],
    ["a title too long", waitsAnswer([vpsWait({ title: "t".repeat(RUNNER_MAX_TITLE_CHARS + 1) })])],
    ["a repository that isn't text", waitsAnswer([vpsWait({ repository: 7 as never })])],
  ])("refuses %s", (_, value) => {
    expect(parseRunnerVpsWaits(value)).toBeNull();
  });
});

describe("isRunnerTime", () => {
  it("takes whole epoch ms from 0", () => {
    expect(isRunnerTime(0)).toBe(true);
    expect(isRunnerTime(NOW)).toBe(true);
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", null, Number.NaN]) {
      expect(isRunnerTime(value)).toBe(false);
    }
  });
});
