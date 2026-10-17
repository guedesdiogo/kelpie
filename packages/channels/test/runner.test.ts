import { describe, expect, it } from "vitest";
import {
  parseRunnerToolResult,
  parseRunnerTurnRequest,
  RUNNER_SESSION_ID,
  type RunnerTurnRequest,
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

describe("RUNNER_SESSION_ID", () => {
  it("takes a lowercase UUID only", () => {
    expect(RUNNER_SESSION_ID.test(SESSION)).toBe(true);
    expect(RUNNER_SESSION_ID.test(crypto.randomUUID())).toBe(true);
    expect(RUNNER_SESSION_ID.test(SESSION.replace("1", "A"))).toBe(false);
    expect(RUNNER_SESSION_ID.test(`${SESSION}\n`)).toBe(false);
  });
});
