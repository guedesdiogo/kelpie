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
 * takes the id; a resumed one goes on from it, live or from its transcript after a restart.
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
 *   signal other failures share.
 */
export type RunnerFrame =
  | { type: "text"; delta: string }
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
