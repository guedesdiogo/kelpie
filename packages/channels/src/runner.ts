// What Kelpie and its VPS runner say to each other (ADR-0035, #294). This file imports nothing, so
// the runner, which installs only its own dependencies, imports it by path.

/**
 * The protocol's version. It changes when a request or an answer changes shape: 3 added the VPS's
 * sessions (ADR-0057, #433).
 */
export const RUNNER_PROTOCOL = 3;

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
 * - `ping`: the stream's first frame, so its headers go out at once, and again after each 20 s of
 *   silence, as while Kelpie runs a tool. It keeps the connections between Kelpie and the runner
 *   open, and maps onto no event.
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
/** A tool's input schema as JSON, and all the tools' schemas together, in UTF-16 code units. */
const MAX_SCHEMA_CHARS = 64 * 1024;
const MAX_SCHEMAS_CHARS = 1024 * 1024;
/** How deep a schema's JSON may nest objects and arrays. */
const MAX_SCHEMA_DEPTH = 64;
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
  if (!isRunnerToolLoopMs(toolLoopMs)) return null;
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

/**
 * A turn's tool bound, in ms: whole, from 1 s to an hour. llm-gateway checks a session's with it, at
 * its RPC boundary (#421).
 */
export function isRunnerToolLoopMs(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_TOOL_LOOP_MS &&
    value <= MAX_TOOL_LOOP_MS
  );
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
  let schemas = 0;
  for (const entry of value) {
    if (!hasKeys(entry, ["name", "description", "inputSchema"])) return null;
    const { name, description, inputSchema } = entry;
    if (typeof name !== "string" || !TOOL_NAME.test(name) || names.has(name)) return null;
    if (typeof description !== "string" || description.length > MAX_DESCRIPTION_CHARS) return null;
    if (!isObject(inputSchema) || inputSchema.type !== "object") return null;
    const length = runnerJsonLength(
      inputSchema,
      Math.min(MAX_SCHEMA_CHARS, MAX_SCHEMAS_CHARS - schemas),
    );
    if (length === null) return null;
    schemas += length;
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

/**
 * The length of `value` as `JSON.stringify` writes it, in UTF-16 code units, escapes left out; or
 * null past `budget`, or for what JSON can't carry as written: a BigInt, a function, a number that
 * isn't finite, an object other than a plain one or an array, or nesting deeper than
 * MAX_SCHEMA_DEPTH, which a cycle reaches. It stops as soon as the count passes the budget, so a huge
 * value costs no more than the budget to measure.
 */
export function runnerJsonLength(value: unknown, budget: number): number | null {
  let length = 0;
  const visit = (node: unknown, depth: number): boolean => {
    if (node === null) length += 4;
    else if (typeof node === "boolean") length += node ? 4 : 5;
    else if (typeof node === "string") length += node.length + 2;
    else if (typeof node === "number") {
      if (!Number.isFinite(node)) return false;
      length += String(node).length;
    } else if (Array.isArray(node)) {
      if (depth >= MAX_SCHEMA_DEPTH) return false;
      length += 2 + Math.max(node.length - 1, 0);
      for (const item of node) {
        // As JSON.stringify does, a list writes a missing value as null.
        if (!visit(item === undefined ? null : item, depth + 1)) return false;
      }
    } else if (typeof node === "object" && isPlain(node)) {
      if (depth >= MAX_SCHEMA_DEPTH) return false;
      length += 2;
      let first = true;
      for (const key of Object.keys(node)) {
        const item = (node as Record<string, unknown>)[key];
        // As JSON.stringify does, an object leaves out a property without a value.
        if (item === undefined) continue;
        length += key.length + 3 + (first ? 0 : 1);
        first = false;
        if (!visit(item, depth + 1)) return false;
      }
    } else return false;
    return length <= budget;
  };
  return visit(value, 0) ? length : null;
}

function isPlain(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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

// The Claude Code sessions on the owner's VPS, read only (ADR-0057, #433): every session but the
// runner's own, whatever started it. `GET /sessions` lists them; `GET /sessions/waits?since=` lists
// the waits on the owner opened since then and still open. Titles and excerpts are the owner's
// work, as untrusted text: the runner redacts secrets from them before they leave.

/**
 * A session's state (ADR-0057 §4):
 * - `working`: its session file says `busy`;
 * - `waiting_permission` and `waiting_answer`: a hook, or its session file's `waiting`, opened a
 *   wait that hasn't closed yet. A file's wait of unknown kind reads as one on an answer;
 * - `idle`: its session file says `idle`, since its last reply;
 * - `ended`: its process is gone, or it ended (`SessionEnd`) and nothing happened since;
 * - `unknown`: its session file has no status the runner knows.
 */
export type RunnerVpsState =
  | "working"
  | "waiting_permission"
  | "waiting_answer"
  | "idle"
  | "ended"
  | "unknown";

/** What its session file says, as Claude Code writes it: `waiting` opens a wait too (ADR-0059). */
export type RunnerVpsStatus = "busy" | "idle" | "waiting" | "unknown";

/** One session. Times are epoch ms; null where its session file didn't say, or a field was dropped. */
export interface RunnerVpsSession {
  /** Claude Code's id for the session, a lowercase UUID. */
  id: string;
  state: RunnerVpsState;
  /** When the state began, so its age is the answer's `now` minus this. */
  since: number | null;
  /**
   * Whether the owner could archive it in the Claude app: a session the app started that ended, or
   * has been idle for 3 hours or more. A terminal's shows only as ended.
   */
  archivable: boolean;
  status: RunnerVpsStatus;
  statusUpdatedAt: number | null;
  startedAt: number | null;
  /** Whether its process runs; null when its session file names none. */
  alive: boolean | null;
  /** From its `entrypoint`: `claude-desktop` is the app, and `cli` a terminal. */
  startedBy: "app" | "terminal" | "unknown";
  entrypoint: string | null;
  /** Its session file's `name`: the title the Claude app shows. */
  title: string | null;
  /** The main checkout's folder name, and the branch, of the folder it runs in. */
  repository: string | null;
  branch: string | null;
  /** Its transcript's last GitHub pull request link, if its last 1 MiB has one. */
  prUrl: string | null;
  /** Its last reply's first 500 characters, redacted. */
  excerpt: string | null;
}

/**
 * `GET /sessions`. `truncated` says the runner dropped fields, or sessions, to keep the answer
 * within RUNNER_MAX_SESSIONS_BYTES and RUNNER_MAX_VPS_SESSIONS.
 */
export interface RunnerVpsSessions {
  ok: true;
  /** The runner's clock, in epoch ms, for the ages. */
  now: number;
  sessions: RunnerVpsSession[];
  truncated: boolean;
}

/**
 * A wait on the owner: a permission, or an answer to a question. A session has one at most, and
 * its id and `openedAt` name it, whether a hook or its session file opened it.
 */
export interface RunnerVpsWait {
  sessionId: string;
  kind: "permission" | "question";
  openedAt: number;
  title: string | null;
  repository: string | null;
}

/** `GET /sessions/waits?since=`: the open waits opened at `since` or later, oldest first. */
export interface RunnerVpsWaits {
  ok: true;
  now: number;
  waits: RunnerVpsWait[];
  truncated: boolean;
}

/** The largest `/sessions` answer, in bytes of JSON. */
export const RUNNER_MAX_SESSIONS_BYTES = 512 * 1024;
/** The largest `/sessions/waits` answer, in bytes of JSON. */
export const RUNNER_MAX_WAITS_BYTES = 64 * 1024;
/** The most sessions, or waits, in one answer. */
export const RUNNER_MAX_VPS_SESSIONS = 200;
export const RUNNER_MAX_TITLE_CHARS = 200;
export const RUNNER_MAX_EXCERPT_CHARS = 500;
export const RUNNER_MAX_REPOSITORY_CHARS = 200;
export const RUNNER_MAX_BRANCH_CHARS = 255;
/** An `entrypoint` as Claude Code writes them: `claude-desktop`, `cli`, `sdk-cli`. */
export const RUNNER_ENTRYPOINT = /^[a-z0-9_-]{1,32}$/;
/** A GitHub pull request's address, the only link a session's entry carries. */
export const RUNNER_PR_URL =
  /^https:\/\/github\.com\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}\/pull\/[1-9][0-9]{0,9}$/;

const VPS_STATES: readonly string[] = [
  "working",
  "waiting_permission",
  "waiting_answer",
  "idle",
  "ended",
  "unknown",
];
const VPS_STATUSES: readonly string[] = ["busy", "idle", "waiting", "unknown"];
const STARTED_BY: readonly string[] = ["app", "terminal", "unknown"];
const VPS_SESSION_KEYS = [
  "id",
  "state",
  "since",
  "archivable",
  "status",
  "statusUpdatedAt",
  "startedAt",
  "alive",
  "startedBy",
  "entrypoint",
  "title",
  "repository",
  "branch",
  "prUrl",
  "excerpt",
] as const;

/** `/sessions`'s answer, checked field by field and rebuilt; null for anything else. */
export function parseRunnerVpsSessions(value: unknown): RunnerVpsSessions | null {
  if (!hasKeys(value, ["ok", "now", "sessions", "truncated"]) || value.ok !== true) return null;
  const { now, sessions, truncated } = value;
  if (!isRunnerTime(now) || typeof truncated !== "boolean") return null;
  if (!Array.isArray(sessions) || sessions.length > RUNNER_MAX_VPS_SESSIONS) return null;
  const parsed: RunnerVpsSession[] = [];
  for (const entry of sessions) {
    const session = parseVpsSession(entry);
    if (!session) return null;
    parsed.push(session);
  }
  return { ok: true, now, sessions: parsed, truncated };
}

function parseVpsSession(value: unknown): RunnerVpsSession | null {
  if (!hasKeys(value, VPS_SESSION_KEYS)) return null;
  const { id, state, since, archivable, status, statusUpdatedAt, startedAt, alive } = value;
  const { startedBy, entrypoint, title, repository, branch, prUrl, excerpt } = value;
  if (typeof id !== "string" || !RUNNER_SESSION_ID.test(id)) return null;
  if (typeof state !== "string" || !VPS_STATES.includes(state)) return null;
  if (typeof status !== "string" || !VPS_STATUSES.includes(status)) return null;
  if (typeof startedBy !== "string" || !STARTED_BY.includes(startedBy)) return null;
  if (typeof archivable !== "boolean" || (alive !== null && typeof alive !== "boolean")) {
    return null;
  }
  if (![since, statusUpdatedAt, startedAt].every((time) => time === null || isRunnerTime(time))) {
    return null;
  }
  if (
    entrypoint !== null &&
    (typeof entrypoint !== "string" || !RUNNER_ENTRYPOINT.test(entrypoint))
  )
    return null;
  if (prUrl !== null && (typeof prUrl !== "string" || !RUNNER_PR_URL.test(prUrl))) return null;
  if (
    !isOptionalText(title, RUNNER_MAX_TITLE_CHARS) ||
    !isOptionalText(repository, RUNNER_MAX_REPOSITORY_CHARS) ||
    !isOptionalText(branch, RUNNER_MAX_BRANCH_CHARS) ||
    !isOptionalText(excerpt, RUNNER_MAX_EXCERPT_CHARS)
  ) {
    return null;
  }
  return {
    id,
    state: state as RunnerVpsState,
    since: since as number | null,
    archivable,
    status: status as RunnerVpsStatus,
    statusUpdatedAt: statusUpdatedAt as number | null,
    startedAt: startedAt as number | null,
    alive,
    startedBy: startedBy as RunnerVpsSession["startedBy"],
    entrypoint,
    title,
    repository,
    branch,
    prUrl,
    excerpt,
  };
}

/** `/sessions/waits`'s answer, checked field by field and rebuilt; null for anything else. */
export function parseRunnerVpsWaits(value: unknown): RunnerVpsWaits | null {
  if (!hasKeys(value, ["ok", "now", "waits", "truncated"]) || value.ok !== true) return null;
  const { now, waits, truncated } = value;
  if (!isRunnerTime(now) || typeof truncated !== "boolean") return null;
  if (!Array.isArray(waits) || waits.length > RUNNER_MAX_VPS_SESSIONS) return null;
  const parsed: RunnerVpsWait[] = [];
  for (const entry of waits) {
    if (!hasKeys(entry, ["sessionId", "kind", "openedAt", "title", "repository"])) return null;
    const { sessionId, kind, openedAt, title, repository } = entry;
    if (typeof sessionId !== "string" || !RUNNER_SESSION_ID.test(sessionId)) return null;
    if ((kind !== "permission" && kind !== "question") || !isRunnerTime(openedAt)) return null;
    if (
      !isOptionalText(title, RUNNER_MAX_TITLE_CHARS) ||
      !isOptionalText(repository, RUNNER_MAX_REPOSITORY_CHARS)
    ) {
      return null;
    }
    parsed.push({ sessionId, kind, openedAt, title, repository });
  }
  return { ok: true, now, waits: parsed, truncated };
}

/** A time in epoch ms: a whole number, from 0. */
export function isRunnerTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isOptionalText(value: unknown, max: number): value is string | null {
  return value === null || isText(value, max);
}
