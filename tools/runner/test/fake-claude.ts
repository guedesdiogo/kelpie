// A stand-in for the Agent SDK's `query()`: each session records its options, hands the test its
// user messages, and says what the test scripts, as Claude Code's messages would.
import type {
  McpSdkServerConfigWithInstance,
  Options,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { RunnerFrame, RunnerTurnRequest } from "../src/protocol.ts";
import type { QueryFn } from "../src/sessions.ts";

export const SESSION = "11111111-2222-4333-8444-555555555555";
export const OTHER_SESSION = "66666666-7777-4888-9999-000000000000";

export function turnRequest(overrides: Partial<RunnerTurnRequest> = {}): RunnerTurnRequest {
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

/** An async queue: what one side pushes, the other reads in order. */
class Channel<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  #waiting: ((result: IteratorResult<T>) => void) | undefined;
  #failing: ((error: unknown) => void) | undefined;
  #ended = false;
  #error: unknown;

  push(item: T): void {
    if (this.#waiting) {
      const wake = this.#waiting;
      this.#waiting = undefined;
      wake({ value: item, done: false });
    } else {
      this.#items.push(item);
    }
  }

  end(error?: unknown): void {
    this.#ended = true;
    this.#error = error;
    const wake = this.#waiting;
    const fail = this.#failing;
    this.#waiting = undefined;
    if (error === undefined) wake?.({ value: undefined, done: true });
    else fail?.(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.#items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.#ended) {
          return this.#error === undefined
            ? Promise.resolve({ value: undefined, done: true })
            : Promise.reject(this.#error);
        }
        return new Promise((resolve, reject) => {
          this.#waiting = resolve;
          this.#failing = reject;
        });
      },
    };
  }
}

/** One `query()` the runner made. */
export class FakeSession {
  readonly options: Options;
  readonly #prompt: AsyncIterator<SDKUserMessage>;
  readonly #out = new Channel<SDKMessage>();
  closed = false;
  /** Whether the process begins with its `system/init`, as Claude Code's does. */
  begins = true;
  /** Whether the process outlives `close()` until `exit()`, as a slow one does. */
  lingers = false;
  #begun = false;

  constructor(prompt: AsyncIterable<SDKUserMessage>, options: Options) {
    this.options = options;
    this.#prompt = prompt[Symbol.asyncIterator]();
  }

  /** The next user message the runner sent, or undefined once its input ended. */
  async next(): Promise<SDKUserMessage | undefined> {
    const { value, done } = await this.#prompt.next();
    return done ? undefined : value;
  }

  send(...messages: SDKMessage[]): void {
    if (!this.#begun && this.begins) this.#out.push(init());
    this.#begun = true;
    for (const message of messages) this.#out.push(message);
  }

  /** Claude Code's process exits, cleanly or with an error. */
  exit(error?: unknown): void {
    this.#out.end(error);
  }

  close(): void {
    this.closed = true;
    if (!this.lingers) this.#out.end();
  }

  messages(): AsyncIterable<SDKMessage> {
    return this.#out;
  }

  /** The session's Kelpie server, as the runner configured it. */
  get kelpie(): McpSdkServerConfigWithInstance {
    return (this.options.mcpServers as Record<string, McpSdkServerConfigWithInstance>)
      .kelpie as McpSdkServerConfigWithInstance;
  }

  /** An MCP client on the session's Kelpie server, as Claude Code is. */
  async tools(): Promise<Client> {
    const [client, served] = InMemoryTransport.createLinkedPair();
    await this.kelpie.instance.connect(served);
    const mcp = new Client({ name: "fake-claude", version: "0.0.0" });
    await mcp.connect(client);
    return mcp;
  }
}

export function fakeClaude(): { query: QueryFn; sessions: FakeSession[] } {
  const sessions: FakeSession[] = [];
  const query: QueryFn = ({ prompt, options }) => {
    const session = new FakeSession(prompt, options);
    sessions.push(session);
    return {
      [Symbol.asyncIterator]: () => session.messages()[Symbol.asyncIterator](),
      close: () => session.close(),
    };
  };
  return { query, sessions };
}

/** A tool use as a reply streams it. */
export interface ToolUse {
  id: string;
  name: string;
  input: unknown;
}

const USAGE = {
  input_tokens: 12,
  output_tokens: 34,
  cache_read_input_tokens: 56,
  cache_creation_input_tokens: 78,
};

/** A reply's block as the Messages API has it. */
const contentOf = (block: string | ToolUse) =>
  typeof block === "string"
    ? { type: "text", text: block }
    : { type: "tool_use", id: block.id, name: block.name, input: block.input };

const assistant = (
  id: string,
  content: unknown[],
  body: { model: string; stop: string | null; usage: unknown; parent: string | null },
) =>
  ({
    type: "assistant",
    message: { id, model: body.model, content, stop_reason: body.stop, usage: body.usage },
    parent_tool_use_id: body.parent,
    session_id: SESSION,
  }) as unknown as SDKMessage;

/**
 * A model reply as Claude Code streams it: its events, from `message_start` to `message_stop`, with
 * each block also as an assistant message of its own, as Claude Code sends it. `final` is what
 * `message_delta` says of the usage; by default, only the output.
 */
export function reply(
  id: string,
  blocks: (string | ToolUse)[],
  {
    stop = blocks.some((block) => typeof block !== "string") ? "tool_use" : "end_turn",
    usage = USAGE as Record<string, number | null> | null,
    final = undefined as Record<string, number | null> | undefined,
    model = "claude-haiku-5-5",
    parent = null as string | null,
  } = {},
): SDKMessage[] {
  const event = (body: Record<string, unknown>) =>
    ({ type: "stream_event", event: body, parent_tool_use_id: parent }) as unknown as SDKMessage;
  const startUsage = usage ? { ...usage, output_tokens: 1 } : {};
  const events = [event({ type: "message_start", message: { id, model, usage: startUsage } })];
  blocks.forEach((block, index) => {
    if (typeof block === "string") {
      events.push(
        event({ type: "content_block_start", index, content_block: { type: "text", text: "" } }),
      );
      // Two deltas, as the API sends text in pieces.
      const half = Math.ceil(block.length / 2);
      for (const text of [block.slice(0, half), block.slice(half)]) {
        events.push(
          event({ type: "content_block_delta", index, delta: { type: "text_delta", text } }),
        );
      }
    } else {
      events.push(
        event({
          type: "content_block_start",
          index,
          content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
        }),
      );
      const json = JSON.stringify(block.input);
      events.push(
        event({
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: json },
        }),
      );
    }
    events.push(
      assistant(id, [contentOf(block)], { model, stop: null, usage: startUsage, parent }),
      event({ type: "content_block_stop", index }),
    );
  });
  events.push(
    event({
      type: "message_delta",
      delta: { stop_reason: stop },
      usage:
        final ??
        (usage ? { output_tokens: usage.output_tokens, input_tokens: null } : { output_tokens: 5 }),
    }),
    event({ type: "message_stop" }),
  );
  return events;
}

/** A model reply that didn't stream, as after Claude Code fell back from a failed stream. */
export function whole(
  id: string,
  blocks: (string | ToolUse)[],
  { stop = blocks.some((block) => typeof block !== "string") ? "tool_use" : "end_turn" } = {},
): SDKMessage {
  return assistant(id, blocks.map(contentOf), {
    model: "claude-haiku-5-5",
    stop,
    usage: USAGE,
    parent: null,
  });
}

/** Claude Code's `system/init` for a session the runner isolated, with any field replaced. */
export function init(overrides: Record<string, unknown> = {}): SDKMessage {
  return {
    type: "system",
    subtype: "init",
    tools: ["mcp__kelpie__memory_search"],
    mcp_servers: [{ name: "kelpie", status: "connected", source: "sdk" }],
    apiKeySource: "none",
    session_id: SESSION,
    ...overrides,
  } as unknown as SDKMessage;
}

export function result(
  sessionId: string,
  { subtype = "success", isError = false }: { subtype?: string; isError?: boolean } = {},
): SDKMessage {
  return {
    type: "result",
    subtype,
    is_error: isError,
    session_id: sessionId,
    num_turns: 1,
  } as unknown as SDKMessage;
}

export function rateLimit(info: Record<string, unknown>): SDKMessage {
  return {
    type: "rate_limit_event",
    rate_limit_info: info,
    session_id: SESSION,
  } as unknown as SDKMessage;
}

/** Claude Code's own message for a failed API call: it never streams. */
export function apiError(error: string, parent: string | null = null): SDKMessage {
  return {
    type: "assistant",
    message: {
      id: "msg_error",
      model: "<synthetic>",
      content: [{ type: "text", text: "API Error: 429 secret detail" }],
      stop_reason: "stop_sequence",
    },
    parent_tool_use_id: parent,
    error,
    session_id: SESSION,
  } as unknown as SDKMessage;
}

export function system(subtype: string): SDKMessage {
  return { type: "system", subtype, session_id: SESSION } as unknown as SDKMessage;
}

/** Reads a turn's NDJSON frames as they come. */
export function frames(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const queue: RunnerFrame[] = [];
  let buffer = "";
  let done = false;
  const fill = async () => {
    while (queue.length === 0 && !done) {
      const chunk = await reader.read();
      if (chunk.done) {
        done = true;
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) queue.push(JSON.parse(line) as RunnerFrame);
    }
  };
  return {
    /** The next frame, or undefined once the stream ended. */
    async next(): Promise<RunnerFrame | undefined> {
      await fill();
      return queue.shift();
    },
    /** Every frame left, until the stream ends. */
    async rest(): Promise<RunnerFrame[]> {
      const all: RunnerFrame[] = [];
      for (let frame = await this.next(); frame; frame = await this.next()) all.push(frame);
      return all;
    },
    cancel: () => reader.cancel(),
  };
}
