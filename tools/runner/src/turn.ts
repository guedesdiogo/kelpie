import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKRateLimitInfo,
  SDKResultMessage,
  SDKSystemMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { SERVER_NAME, TOOL_PREFIX } from "./claude.ts";
import { forLog } from "./journal.ts";
import type {
  RunnerErrorCode,
  RunnerFrame,
  RunnerReply,
  RunnerToolCall,
  RunnerToolResult,
  RunnerUsage,
} from "./protocol.ts";
import type { ToolCall, ToolOutcome } from "./tools.ts";

/** Kelpie's own cut of a tool's output (`TOOL_OUTPUT_MAX_CHARS`), applied again here. */
export const TOOL_OUTPUT_MAX_CHARS = 10_000;
const CUT_NOTE = "\n[Cut: the result was longer.]";

/**
 * How long a turn's stream may stay silent, as while Kelpie runs a tool, before a `ping` frame
 * keeps the connections on its way open.
 */
export const PING_MS = 20_000;

/** What a call gets once its turn ended without its result. */
export const STOPPED: ToolOutcome = {
  output: "The turn stopped before this call's result came back.",
  isError: true,
};

// Fixed texts: Claude Code's own messages and stderr stay in the runner's log.
const ERROR_MESSAGES: Record<RunnerErrorCode, string> = {
  rate_limited: "Claude Code reached a usage limit",
  out_of_credits: "Claude Code's usage ran out",
  auth: "Claude Code's login on the server failed",
  server_error: "Claude Code failed",
};

interface Failure {
  code: RunnerErrorCode;
  resetsAt?: number;
  unverified?: boolean;
}

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; json: string }
  | { type: "other" };

/** One model reply, as its stream events build it, or as one message when it didn't stream. */
interface Reply {
  model: string;
  blocks: Block[];
  usage: Partial<Record<UsageField, number | null>>;
  stopReason: string | null;
}

type UsageField =
  | "input_tokens"
  | "output_tokens"
  | "cache_read_input_tokens"
  | "cache_creation_input_tokens";
const USAGE_FIELDS: readonly UsageField[] = [
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
];

interface Pending {
  call: RunnerToolCall;
  asked: boolean;
  settle: (outcome: ToolOutcome) => void;
}

/**
 * One turn of a session: Claude Code's messages in, the turn's NDJSON frames out. A reply whose
 * tool calls Claude Code runs goes out as a `round` once complete, before any of its calls; each
 * call then goes out as a `tool_call` and waits for its result until its deadline. The turn ends on
 * its result, its failure, or its stream's cancel; `onEnd` says whether it finished.
 */
export class Turn {
  readonly stream: ReadableStream<Uint8Array>;
  readonly #sessionId: string;
  readonly #waitMs: number;
  readonly #warn: (message: string) => void;
  readonly #onEnd: (finished: boolean) => void;
  readonly #encoder = new TextEncoder();
  #controller!: ReadableStreamDefaultController<Uint8Array>;
  #cancelled = false;
  #ping: ReturnType<typeof setTimeout> | undefined;
  #streaming: Reply | undefined;
  #latest: Reply | undefined;
  // Replies seen, streamed or whole, by message id: Claude Code also sends a streamed reply's blocks
  // as assistant messages.
  readonly #replies = new Set<string>();
  // Tool uses whose round went out, and calls Claude Code made.
  readonly #rounds = new Set<string>();
  readonly #calls = new Map<string, Pending>();
  // The turn's structured failure signals.
  #limit: SDKRateLimitInfo | undefined;
  #apiError: string | undefined;
  #refused = false;
  #compacted = false;

  constructor(
    sessionId: string,
    waitMs: number,
    warn: (message: string) => void,
    onEnd: (finished: boolean) => void,
  ) {
    this.#sessionId = sessionId;
    this.#waitMs = waitMs;
    this.#warn = warn;
    this.#onEnd = onEnd;
    this.stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#controller = controller;
      },
      cancel: () => {
        this.#cancelled = true;
        this.#end(false);
      },
    });
    this.#keepAlive();
  }

  handle(message: SDKMessage): void {
    switch (message.type) {
      case "stream_event":
        // A subagent's events: Kelpie's sessions have none, as `tools` is empty.
        if (message.parent_tool_use_id === null) this.#onEvent(message.event);
        return;
      case "assistant":
        if (message.parent_tool_use_id === null) this.#onAssistant(message);
        return;
      case "rate_limit_event":
        // Only a rejection explains a failure; the latest one stands.
        if (
          message.rate_limit_info.status === "rejected" ||
          message.rate_limit_info.errorCode === "credits_required"
        ) {
          this.#limit = message.rate_limit_info;
        }
        return;
      case "system":
        if (message.subtype === "init") this.#checkIsolation(message);
        if (message.subtype === "compact_boundary") this.#compacted = true;
        if (message.subtype === "model_refusal_no_fallback") this.#refused = true;
        return;
      case "result":
        this.#onResult(message);
        return;
    }
  }

  /** Runs a call Claude Code made, through Kelpie: once its round is out, it is asked for. */
  call({ id, name, input }: ToolCall, signal: AbortSignal): Promise<ToolOutcome> {
    return new Promise((resolve) => {
      const pending: Pending = {
        call: { type: "tool_call", id, name, input },
        asked: false,
        settle: (outcome) => {
          clearTimeout(deadline);
          signal.removeEventListener("abort", stop);
          this.#calls.delete(id);
          resolve(outcome);
        },
      };
      // A result that never comes fails the turn: Kelpie has stopped answering.
      const deadline = setTimeout(() => {
        pending.settle(STOPPED);
        this.fail({ code: "server_error" });
      }, this.#waitMs);
      const stop = () => pending.settle(STOPPED);
      signal.addEventListener("abort", stop, { once: true });
      this.#calls.set(id, pending);
      if (this.#rounds.has(id)) this.#ask(pending);
    });
  }

  /** Gives a waiting call its result. False when no call waits for it. */
  answer(result: RunnerToolResult): boolean {
    const pending = this.#calls.get(result.callId);
    if (!pending?.asked) return false;
    pending.settle({ output: cut(result.output), isError: result.isError === true });
    return true;
  }

  /** Ends the turn with an error frame. */
  fail(failure: Failure): void {
    this.#emit({
      type: "error",
      code: failure.code,
      retryable: true,
      message: ERROR_MESSAGES[failure.code],
      ...(failure.resetsAt === undefined ? {} : { resetsAt: failure.resetsAt }),
      ...(failure.unverified === undefined ? {} : { unverified: failure.unverified }),
    });
    this.#end(false);
  }

  /**
   * Fails the turn when Claude Code's session isn't the one the runner set up (ADR-0037 §2): a tool
   * other than Kelpie's, an MCP server other than its own, or a credential other than the login.
   */
  #checkIsolation(init: SDKSystemMessage): void {
    const servers = init.mcp_servers;
    const tool = init.tools.find((name) => !name.startsWith(TOOL_PREFIX));
    const breach =
      tool !== undefined
        ? `a tool other than Kelpie's, ${tool}`
        : servers.length !== 1 || servers[0]?.name !== SERVER_NAME || servers[0].source !== "sdk"
          ? `MCP servers other than Kelpie's: ${JSON.stringify(servers.map(({ name, source }) => ({ name, source })))}`
          : init.apiKeySource !== "none"
            ? `a credential other than the server's login: ${init.apiKeySource}`
            : undefined;
    if (breach === undefined) return;
    this.#warn(`Claude Code's session ${this.#sessionId} isn't isolated: ${forLog(breach)}`);
    this.fail({ code: "server_error" });
  }

  /**
   * An assistant message: Claude Code's own error message, or a reply that didn't stream, as after
   * Claude Code fell back from a failed stream. A streamed reply's blocks come again here: its
   * events already built it.
   */
  #onAssistant({ error, message }: SDKAssistantMessage): void {
    if (error !== undefined) {
      this.#apiError = error;
      return;
    }
    if (this.#replies.has(message.id)) return;
    this.#replies.add(message.id);
    const reply: Reply = {
      model: message.model,
      blocks: [],
      usage: usageOf(message.usage),
      stopReason: message.stop_reason,
    };
    for (const block of message.content) {
      if (block.type === "text") {
        reply.blocks.push({ type: "text", text: block.text });
        if (block.text !== "") this.#emit({ type: "text", delta: block.text });
      } else if (block.type === "tool_use") {
        const json = JSON.stringify(block.input);
        reply.blocks.push({ type: "tool_use", id: block.id, name: block.name, json });
      }
    }
    this.#settle(reply);
  }

  #onEvent(event: Extract<SDKMessage, { type: "stream_event" }>["event"]): void {
    switch (event.type) {
      case "message_start": {
        this.#replies.add(event.message.id);
        this.#streaming = {
          model: event.message.model,
          blocks: [],
          usage: usageOf(event.message.usage),
          stopReason: null,
        };
        return;
      }
      case "content_block_start": {
        const block = event.content_block;
        if (this.#streaming) {
          this.#streaming.blocks[event.index] =
            block.type === "text"
              ? { type: "text", text: block.text }
              : block.type === "tool_use"
                ? { type: "tool_use", id: block.id, name: block.name, json: "" }
                : { type: "other" };
        }
        return;
      }
      case "content_block_delta": {
        const block = this.#streaming?.blocks[event.index];
        if (event.delta.type === "text_delta" && block?.type === "text") {
          block.text += event.delta.text;
          this.#emit({ type: "text", delta: event.delta.text });
        } else if (event.delta.type === "input_json_delta" && block?.type === "tool_use") {
          block.json += event.delta.partial_json;
        }
        return;
      }
      case "message_delta":
        if (this.#streaming) {
          this.#streaming.stopReason = event.delta.stop_reason;
          for (const field of USAGE_FIELDS) {
            const value = event.usage[field];
            if (typeof value === "number") this.#streaming.usage[field] = value;
          }
        }
        return;
      case "message_stop":
        if (this.#streaming) this.#settle(this.#streaming);
        this.#streaming = undefined;
        return;
    }
  }

  /** A complete reply: a round when Claude Code runs its calls, else maybe the turn's last. */
  #settle(reply: Reply): void {
    this.#latest = reply;
    const calls = reply.blocks.filter((block) => block.type === "tool_use");
    if (reply.stopReason !== "tool_use" || calls.length === 0) return;
    this.#emit({ type: "round", message: toMessage(reply, true), usage: toUsage(reply) });
    for (const { id } of calls) {
      this.#rounds.add(id);
      const pending = this.#calls.get(id);
      if (pending && !pending.asked) this.#ask(pending);
    }
  }

  #ask(pending: Pending): void {
    pending.asked = true;
    this.#emit({ type: "tool_call", call: pending.call });
  }

  #onResult(result: SDKResultMessage): void {
    const last = this.#latest;
    // A refusal is a stop reason, whatever the result says.
    if (this.#refused || last?.stopReason === "refusal") {
      this.#finish("refusal", last, result.session_id);
    } else if (result.is_error || result.subtype !== "success") {
      this.fail(this.#failure());
    } else if (last === undefined || last.stopReason === "tool_use") {
      // Claude Code ended the turn without a last reply.
      this.fail({ code: "server_error" });
    } else {
      const length =
        last.stopReason === "max_tokens" || last.stopReason === "model_context_window_exceeded";
      this.#finish(length ? "length" : "stop", last, result.session_id);
    }
  }

  #finish(
    reason: "stop" | "length" | "refusal",
    reply: Reply | undefined,
    sessionId: string,
  ): void {
    this.#emit({
      type: "finish",
      reason,
      message: reply ? toMessage(reply, false) : { role: "assistant", parts: [] },
      usage: reply ? toUsage(reply) : [],
      // A compacted session, or one Claude Code renamed, no longer holds the conversation as is.
      session: { id: sessionId, clean: !this.#compacted && sessionId === this.#sessionId },
    });
    this.#end(true);
  }

  /** Why the turn failed, from structured signals only. */
  #failure(): Failure {
    const limit = this.#limit;
    // The subscription's included usage is spent: no text to guess from.
    if (limit?.errorCode === "credits_required") return { code: "out_of_credits" };
    if (limit?.status === "rejected") {
      // Claude Code gives the reset in epoch seconds; Kelpie's errors carry epoch ms.
      return limit.resetsAt === undefined
        ? { code: "rate_limited" }
        : { code: "rate_limited", resetsAt: limit.resetsAt * 1000 };
    }
    switch (this.#apiError) {
      case "rate_limit":
        return { code: "rate_limited" };
      case "billing_error":
        return { code: "out_of_credits", unverified: true };
      // The login failed, or its account or organization may not use Claude Code now.
      case "authentication_failed":
      case "oauth_org_not_allowed":
      case "account_on_hold":
      case "verification_required":
        return { code: "auth" };
      default:
        return { code: "server_error" };
    }
  }

  #emit(frame: RunnerFrame): void {
    this.#controller.enqueue(this.#encoder.encode(`${JSON.stringify(frame)}\n`));
    this.#keepAlive();
  }

  /** Sends a `ping` once the stream has been silent for PING_MS, and again after each. */
  #keepAlive(): void {
    clearTimeout(this.#ping);
    this.#ping = setTimeout(() => this.#emit({ type: "ping" }), PING_MS);
  }

  /** Ends the turn, once: its session then hands it no more messages, calls or results. */
  #end(finished: boolean): void {
    clearTimeout(this.#ping);
    if (!this.#cancelled) this.#controller.close();
    for (const pending of [...this.#calls.values()]) pending.settle(STOPPED);
    this.#onEnd(finished);
  }
}

/** A reply as Kelpie keeps it: its text, and its calls when Claude Code runs them. */
function toMessage(reply: Reply, withCalls: boolean): RunnerReply {
  const parts: RunnerReply["parts"] = [];
  for (const block of reply.blocks) {
    if (block.type === "text" && block.text !== "") parts.push({ type: "text", text: block.text });
    if (block.type === "tool_use" && withCalls) {
      parts.push({
        type: "tool_call",
        id: block.id,
        name: block.name.startsWith(TOOL_PREFIX)
          ? block.name.slice(TOOL_PREFIX.length)
          : block.name,
        input: parseInput(block.json),
      });
    }
  }
  return { role: "assistant", parts };
}

/** A tool call's input, from its streamed JSON. A call without input streams none. */
function parseInput(json: string): unknown {
  if (json === "") return {};
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}

/** The token counts a reply's usage gives. */
function usageOf(usage: Partial<Record<UsageField, number | null>>): Reply["usage"] {
  const counts: Reply["usage"] = {};
  for (const field of USAGE_FIELDS) {
    const count = usage[field];
    if (count !== undefined) counts[field] = count;
  }
  return counts;
}

/** The reply's token counts, or none when it didn't give them: never zeros in their place. */
function toUsage({ model, usage }: Reply): RunnerUsage[] {
  const { input_tokens: input, output_tokens: output } = usage;
  if (typeof input !== "number" || typeof output !== "number") return [];
  return [
    {
      model,
      inputUncached: input,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
      output,
    },
  ];
}

/** Cuts a tool's output as Kelpie does, without splitting a surrogate pair. */
export function cut(output: string): string {
  if (output.length <= TOOL_OUTPUT_MAX_CHARS) return output;
  return `${output.slice(0, TOOL_OUTPUT_MAX_CHARS).replace(/[\uD800-\uDBFF]$/, "")}${CUT_NOTE}`;
}
