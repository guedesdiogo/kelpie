// What Kelpie and its VPS runner say to each other (ADR-0035, #294). This file imports nothing, so
// the runner, which installs only its own dependencies, imports it by path.

/** The protocol's version. It changes when a request or an answer changes shape. */
export const RUNNER_PROTOCOL = 2;

/** A version as the runner reports it, such as `0.1.0`; anything else isn't the runner's answer. */
export const RUNNER_VERSION = /^[0-9A-Za-z.+-]{1,64}$/;

/**
 * The runner as `channel-egress` sees it, never with its secret:
 * - `not_configured`: `channel-egress` was deployed without the runner's VPC Service;
 * - `not_connected`: no secret was given through the secure form;
 * - `refused`: the runner answers 401 to the stored secret;
 * - `unreachable`: the call failed or timed out, or the answer isn't the runner's;
 * - `ready`, or `outdated` when it speaks another protocol version.
 */
export type RunnerState =
  | { state: "ready" | "outdated"; version: string; protocol: number }
  | { state: "not_configured" | "not_connected" | "refused" | "unreachable" };

/** A runner that answered its `/health`. */
export type RunnerAnswered = Extract<RunnerState, { version: string }>;

// A conversation's turns on Claude Code, through the runner (ADR-0037 §2, #295). The session's id,
// a lowercase UUID that Kelpie picks, is in each path: `/sessions/:id/...`.

export interface RunnerText {
  type: "text";
  text: string;
}

export interface RunnerToolCall {
  type: "tool_call";
  id: string;
  /** Kelpie's own name for the tool, without Claude Code's `mcp__kelpie__` prefix. */
  name: string;
  input: unknown;
}

/** A tool Kelpie offers the session, as `ToolSpec` describes it: its input is a JSON Schema. */
export interface RunnerToolSpec {
  name: string;
  description: string;
  inputSchema: { type: "object"; [key: string]: unknown };
}

/**
 * `POST /sessions/:id/turns`: one turn of a conversation's session. A new session (`resume` false)
 * takes the id; a resumed one goes on from it, live or from its transcript after a restart. A turn
 * that can't start answers 409, 429 or 503 with a `reason` (docs/runner.md).
 */
export interface RunnerTurnRequest {
  /** The conversation the session belongs to. Its new session closes its old one. */
  conversation: string;
  resume: boolean;
  model: string;
  /** Kelpie's system prompt, which replaces Claude Code's. */
  system: string;
  tools: RunnerToolSpec[];
  /**
   * What the turn sends: the new user messages on a resume, or the marked transcript that seeds a
   * new session. They reach Claude Code as one user message, their parts in order.
   */
  messages: { role: "user"; parts: RunnerText[] }[];
  /** The agent's bound on the turn's tools. A tool call's result is awaited 2 minutes longer. */
  toolLoopMs: number;
}

/** `POST /sessions/:id/tool-results`: the result of a call a `tool_call` frame asked for. */
export interface RunnerToolResult {
  callId: string;
  output: string;
  isError?: boolean;
}

/** Token counts for one model reply, as `Usage` has them. */
export interface RunnerUsage {
  model: string;
  inputUncached: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface RunnerReply {
  role: "assistant";
  parts: (RunnerText | RunnerToolCall)[];
}

/** The failures a turn reports. All are retryable, so the router may try the next route. */
export type RunnerErrorCode = "rate_limited" | "out_of_credits" | "auth" | "server_error";

/**
 * One line of a turn's NDJSON stream. Each maps onto one `LlmEvent`, or onto an `LlmError`:
 * - `text`: a piece of the reply's text, as it streams;
 * - `round`: a reply whose tool calls Claude Code runs (`tool_round`). `usage` is empty when the
 *   reply didn't say;
 * - `tool_call`: a call of that round to run now (`tool_request`). Its result goes back through
 *   `/tool-results`;
 * - `finish`: the last reply. `clean` is false when the session no longer matches the turn, as
 *   after Claude Code compacted it;
 * - `error`: the turn failed. `resetsAt` is in epoch ms; `unverified` marks a code read from a
 *   signal other failures share;
 * - `ping`: nothing happened for a while, as while Kelpie runs a tool. It keeps the connections
 *   between Kelpie and the runner open, and maps onto no event.
 */
export type RunnerFrame =
  | { type: "text"; delta: string }
  | { type: "ping" }
  | { type: "round"; message: RunnerReply; usage: RunnerUsage[] }
  | { type: "tool_call"; call: RunnerToolCall }
  | {
      type: "finish";
      reason: "stop" | "length" | "refusal";
      message: RunnerReply;
      usage: RunnerUsage[];
      session: { id: string; clean: boolean };
    }
  | {
      type: "error";
      code: RunnerErrorCode;
      retryable: true;
      message: string;
      resetsAt?: number;
      unverified?: boolean;
    };

// The checks a request to the runner passes. The runner checks what it receives, and
// `channel-egress` checks what it relays at its RPC boundary (#420): with one set of checks, a
// request one side takes, the other takes too.

/** A session's id in a path: a lowercase UUID, as Kelpie picks them and Claude Code takes them. */
export const RUNNER_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The largest turn's body, in bytes: a seed carries a conversation's transcript and checkpoint. */
export const RUNNER_MAX_TURN_BYTES = 8 * 1024 * 1024;
/** The largest tool result's body, in bytes. */
export const RUNNER_MAX_RESULT_BYTES = 256 * 1024;

const MAX_CONVERSATION_CHARS = 256;
const MAX_SYSTEM_CHARS = 200_000;
const MAX_TOOLS = 128;
const MAX_DESCRIPTION_CHARS = 10_000;
const MAX_MESSAGES = 1_000;
const MAX_PARTS = 1_000;
const MAX_CALL_ID_CHARS = 256;
/** llm-gateway's own bound on an answer. The runner then cuts it as Kelpie's tools do. */
const MAX_OUTPUT_CHARS = 20_000;
const MIN_TOOL_LOOP_MS = 1_000;
const MAX_TOOL_LOOP_MS = 3_600_000;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,127}$/;
/** The Messages API's rule for a tool's name. */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** A turn's body, checked field by field and rebuilt: anything else, or anything more, is refused. */
export function parseRunnerTurnRequest(value: unknown): RunnerTurnRequest | null {
  if (
    !hasKeys(value, [
      "conversation",
      "resume",
      "model",
      "system",
      "tools",
      "messages",
      "toolLoopMs",
    ])
  ) {
    return null;
  }
  const { conversation, resume, model, system, tools, messages, toolLoopMs } = value;
  if (!isText(conversation, MAX_CONVERSATION_CHARS) || typeof resume !== "boolean") return null;
  if (typeof model !== "string" || !MODEL.test(model) || !isText(system, MAX_SYSTEM_CHARS)) {
    return null;
  }
  if (
    typeof toolLoopMs !== "number" ||
    !Number.isInteger(toolLoopMs) ||
    toolLoopMs < MIN_TOOL_LOOP_MS ||
    toolLoopMs > MAX_TOOL_LOOP_MS
  ) {
    return null;
  }
  const specs = parseTools(tools);
  const sent = parseMessages(messages);
  if (specs === null || sent === null) return null;
  return {
    conversation,
    resume,
    model,
    system,
    tools: specs,
    messages: sent,
    toolLoopMs,
  };
}

/** A tool call's result, as llm-gateway checks it, rebuilt. */
export function parseRunnerToolResult(value: unknown): RunnerToolResult | null {
  if (!hasKeys(value, ["callId", "output"], ["isError"])) return null;
  const { callId, output, isError } = value;
  if (!isText(callId, MAX_CALL_ID_CHARS)) return null;
  if (typeof output !== "string" || output.length > MAX_OUTPUT_CHARS) return null;
  if (isError !== undefined && typeof isError !== "boolean") return null;
  return { callId, output, ...(isError === undefined ? {} : { isError }) };
}

function parseTools(value: unknown): RunnerToolSpec[] | null {
  if (!Array.isArray(value) || value.length > MAX_TOOLS) return null;
  const names = new Set<string>();
  const specs: RunnerToolSpec[] = [];
  for (const entry of value) {
    if (!hasKeys(entry, ["name", "description", "inputSchema"])) return null;
    const { name, description, inputSchema } = entry;
    if (typeof name !== "string" || !TOOL_NAME.test(name) || names.has(name)) return null;
    if (typeof description !== "string" || description.length > MAX_DESCRIPTION_CHARS) return null;
    if (!isObject(inputSchema) || inputSchema.type !== "object") return null;
    names.add(name);
    specs.push({ name, description, inputSchema: inputSchema as RunnerToolSpec["inputSchema"] });
  }
  return specs;
}

function parseMessages(value: unknown): RunnerTurnRequest["messages"] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MESSAGES) return null;
  const messages: RunnerTurnRequest["messages"] = [];
  for (const entry of value) {
    if (!hasKeys(entry, ["role", "parts"]) || entry.role !== "user") return null;
    const { parts } = entry;
    if (!Array.isArray(parts) || parts.length === 0 || parts.length > MAX_PARTS) return null;
    const texts: RunnerText[] = [];
    for (const part of parts) {
      if (!hasKeys(part, ["type", "text"]) || part.type !== "text") return null;
      // The Messages API refuses an empty text block. The body's size bounds the text.
      if (typeof part.text !== "string" || part.text === "") return null;
      texts.push({ type: "text", text: part.text });
    }
    messages.push({ role: "user", parts: texts });
  }
  return messages;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An object with every required key, and no key outside `required` and `optional`. */
function hasKeys<K extends string, O extends string = never>(
  value: unknown,
  required: readonly K[],
  optional: readonly O[] = [],
): value is Record<K, unknown> & Partial<Record<O, unknown>> {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every(
      (key) =>
        (required as readonly string[]).includes(key) ||
        (optional as readonly string[]).includes(key),
    )
  );
}

function isText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}
