import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { sessionOptions } from "./claude.ts";
import type { RunnerToolResult, RunnerTurnRequest } from "./protocol.ts";
import { kelpieServer, type ToolCall, type ToolOutcome } from "./tools.ts";
import { STOPPED, Turn } from "./turn.ts";

/** What the runner uses of the Agent SDK's `query()`, so tests can give a fake. */
export interface SessionQuery extends AsyncIterable<SDKMessage> {
  close(): void;
}
export type QueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => SessionQuery;

export interface SessionsOptions {
  query: QueryFn;
  /** Whether Claude Code keeps the session's transcript, which a resume needs. */
  sessionExists: (id: string) => Promise<boolean>;
  /** The runner's environment, of which Claude Code gets an allowlist. */
  env: Record<string, string | undefined>;
  cwd: string;
  /** The runner's own log, for what Claude Code says on stderr and how a session ended. */
  warn: (message: string) => void;
  idleMs?: number;
}

/** A session closes after this long without a turn. A later turn resumes it from its transcript. */
export const IDLE_MS = 15 * 60_000;
/** How much longer than the agent's tool bound a call waits for its result. */
export const RESULT_GRACE_MS = 2 * 60_000;

/**
 * Why a turn can't start, which `409` carries. The provider then seeds a new session (#295):
 * - `lost`: no session to resume, live or on disk;
 * - `unfinished`: a turn is still running, or the session's last turn didn't finish, so Claude
 *   Code's transcript holds more than Kelpie's history;
 * - `mismatched`: the session belongs to another conversation or runs another prompt, model or
 *   tools, or a new session asks for an id already taken.
 */
export type Conflict = "lost" | "unfinished" | "mismatched";

/** Every conversation's live session on Claude Code: one `query()` on streaming input each. */
export class Sessions {
  readonly #options: SessionsOptions;
  readonly #live = new Map<string, Session>();
  readonly #conversations = new Map<string, Session>();
  // Sessions whose last turn didn't finish, until the runner restarts: never resumed.
  readonly #unfinished = new Set<string>();

  constructor(options: SessionsOptions) {
    this.#options = options;
  }

  /** Starts a turn: its NDJSON stream, or why it can't start. */
  async turn(
    id: string,
    request: RunnerTurnRequest,
  ): Promise<{ stream: ReadableStream<Uint8Array> } | { conflict: Conflict }> {
    const known = this.#known(id, request);
    if (known) return known;
    const exists = await this.#options.sessionExists(id);
    if (exists !== request.resume) return { conflict: request.resume ? "lost" : "mismatched" };
    // Another request may have started it meanwhile.
    const raced = this.#known(id, request);
    if (raced) return raced;
    // A conversation's new session closes its old one.
    this.#conversations.get(request.conversation)?.close();
    const session = new Session(id, request, this.#options, (clean) =>
      this.#closed(session, clean),
    );
    this.#live.set(id, session);
    this.#conversations.set(request.conversation, session);
    return { stream: session.start(request) };
  }

  /** Gives a call its result. False when the session has no call waiting for it. */
  answer(id: string, result: RunnerToolResult): boolean {
    return this.#live.get(id)?.answer(result) ?? false;
  }

  /** Closes a live session. A turn it was running fails. */
  close(id: string): void {
    this.#live.get(id)?.close();
  }

  /** A live or unfinished session's answer to a turn, or nothing when Claude Code must start one. */
  #known(
    id: string,
    request: RunnerTurnRequest,
  ): { stream: ReadableStream<Uint8Array> } | { conflict: Conflict } | undefined {
    if (this.#unfinished.has(id)) return { conflict: "unfinished" };
    const live = this.#live.get(id);
    if (!live) return undefined;
    if (!request.resume || !live.serves(request)) return { conflict: "mismatched" };
    if (live.busy) return { conflict: "unfinished" };
    return { stream: live.start(request) };
  }

  // A session closes once, before another of its id or its conversation starts.
  #closed(session: Session, clean: boolean): void {
    this.#live.delete(session.id);
    this.#conversations.delete(session.conversation);
    if (!clean) this.#unfinished.add(session.id);
  }
}

/** One conversation's live session: Claude Code's process, its input, and its turn. */
class Session {
  readonly id: string;
  readonly conversation: string;
  readonly #key: string;
  readonly #options: SessionsOptions;
  readonly #onClose: (clean: boolean) => void;
  readonly #inbox = new Inbox();
  readonly #query: SessionQuery;
  #turn: Turn | undefined;
  #idle: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  constructor(
    id: string,
    request: RunnerTurnRequest,
    options: SessionsOptions,
    onClose: (clean: boolean) => void,
  ) {
    this.id = id;
    this.conversation = request.conversation;
    this.#key = keyOf(request);
    this.#options = options;
    this.#onClose = onClose;
    const server = kelpieServer(
      request.tools,
      (call, signal) => this.#call(call, signal),
      request.toolLoopMs + RESULT_GRACE_MS,
    );
    this.#query = options.query({
      prompt: this.#inbox,
      options: sessionOptions({
        id,
        resume: request.resume,
        model: request.model,
        system: request.system,
        server,
        env: options.env,
        cwd: options.cwd,
        stderr: (data) => options.warn(`Claude Code (session ${id}): ${data.trimEnd()}`),
      }),
    });
    void this.#read();
  }

  get busy(): boolean {
    return this.#turn !== undefined;
  }

  /** Whether the session runs what this turn asks for: its conversation, prompt, model and tools. */
  serves(request: RunnerTurnRequest): boolean {
    return request.conversation === this.conversation && keyOf(request) === this.#key;
  }

  start(request: RunnerTurnRequest): ReadableStream<Uint8Array> {
    clearTimeout(this.#idle);
    const turn = new Turn(this.id, request.toolLoopMs + RESULT_GRACE_MS, (finished) =>
      this.#ended(turn, finished),
    );
    this.#turn = turn;
    this.#inbox.push({
      type: "user",
      message: {
        role: "user",
        content: request.messages.flatMap((message) =>
          message.parts.map((part) => ({ type: "text" as const, text: part.text })),
        ),
      },
      parent_tool_use_id: null,
    });
    return turn.stream;
  }

  answer(result: RunnerToolResult): boolean {
    return this.#turn?.answer(result) ?? false;
  }

  /** Closes the session. It stays resumable unless a turn was running. */
  close(): void {
    this.#shutdown(true);
  }

  #call(call: ToolCall, signal: AbortSignal): Promise<ToolOutcome> {
    return this.#turn?.call(call, signal) ?? Promise.resolve(STOPPED);
  }

  #ended(turn: Turn, finished: boolean): void {
    if (this.#turn !== turn) return;
    this.#turn = undefined;
    // A turn that didn't finish leaves more in Claude Code's transcript than in Kelpie's history.
    if (!finished) this.#shutdown(false);
    else this.#idle = setTimeout(() => this.close(), this.#options.idleMs ?? IDLE_MS);
  }

  /** Hands Claude Code's messages to the turn. Its process ending ends the session. */
  async #read(): Promise<void> {
    let ending = "ended";
    try {
      for await (const message of this.#query) this.#turn?.handle(message);
    } catch (error) {
      ending = `failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (!this.#closed) this.#options.warn(`Claude Code's session ${this.id} ${ending}`);
    this.#shutdown(true);
  }

  #shutdown(clean: boolean): void {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#idle);
    const turn = this.#turn;
    this.#turn = undefined;
    turn?.fail({ code: "server_error" });
    this.#inbox.end();
    this.#query.close();
    this.#onClose(clean && turn === undefined);
  }
}

/** What a live session can't change: its prompt, model and tools, and so its tools' timeout. */
function keyOf(request: RunnerTurnRequest): string {
  return JSON.stringify([request.model, request.system, request.tools, request.toolLoopMs]);
}

/** The session's streaming input: one user message per turn, until the session closes. */
class Inbox implements AsyncIterable<SDKUserMessage> {
  readonly #queue: SDKUserMessage[] = [];
  #wake: (() => void) | undefined;
  #ended = false;

  push(message: SDKUserMessage): void {
    this.#queue.push(message);
    this.#wake?.();
  }

  end(): void {
    this.#ended = true;
    this.#wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      const next = this.#queue.shift();
      if (next) {
        yield next;
      } else if (this.#ended) {
        return;
      } else {
        await new Promise<void>((resolve) => {
          this.#wake = resolve;
        });
        this.#wake = undefined;
      }
    }
  }
}
