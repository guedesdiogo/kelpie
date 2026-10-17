import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { sessionOptions } from "./claude.ts";
import { forLog } from "./journal.ts";
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
  /** Deletes the session's transcript, so that nothing resumes it. */
  deleteSession: (id: string) => Promise<void>;
  /** The runner's environment, of which Claude Code gets an allowlist. */
  env: Record<string, string | undefined>;
  cwd: string;
  /** The runner's own log, for what Claude Code says on stderr and how a session ended. */
  warn: (message: string) => void;
  idleMs?: number;
  maxLive?: number;
  turnsPerMinute?: number;
  maxUnfinished?: number;
}

/** A session closes after this long without a turn. A later turn resumes it from its transcript. */
export const IDLE_MS = 15 * 60_000;
/** How much longer than the agent's tool bound a call waits for its result. */
export const RESULT_GRACE_MS = 2 * 60_000;
/**
 * How much longer than that Claude Code waits for a call, as the MCP server's timeout: the
 * runner's own deadline comes first, and fails the turn.
 */
export const CALL_TIMEOUT_MARGIN_MS = 10_000;
/**
 * Claude Code processes at most, live sessions and closing ones together, before a new session
 * starts: each takes up to about 420 MB. The systemd unit's memory bounds leave room for these, the
 * new one, and the runner.
 */
export const MAX_LIVE = 4;
/** Turns the runner admits in any minute, at most. A turn it then refuses gives its place back. */
export const TURNS_PER_MINUTE = 30;
/** Unfinished sessions remembered, so that none is resumed. Their transcripts are deleted too. */
export const MAX_UNFINISHED = 1_000;
/**
 * How long a closed session's process may take to exit. Past it, its room is released and its id
 * is never resumed, as the process may still write its transcript.
 */
export const CLOSING_MS = 30_000;

/** Messages only a process that began with its `system/init` may send: the turn's output. */
const OUTPUT = new Set(["assistant", "stream_event", "result"]);

/**
 * Why a turn can't start, which `409` carries. The provider then seeds a new session (#295):
 * - `lost`: no session to resume, live or on disk;
 * - `unfinished`: a turn is still running, or the session's last turn didn't finish, so Claude
 *   Code's transcript holds more than Kelpie's history, or its closed process hasn't exited yet;
 * - `mismatched`: the session belongs to another conversation or runs another prompt, model or
 *   tools, or a new session asks for an id already taken.
 */
export type Conflict = "lost" | "unfinished" | "mismatched";

/**
 * A turn the runner won't start: 409 for a conflict; 503 when no session can make room, as every
 * live one runs a turn or a closed one's process hasn't exited yet; 429 past the turns a minute
 * allows, with the seconds to wait.
 */
export type Refusal =
  | { status: 409; reason: Conflict }
  | { status: 503; reason: "full" }
  | { status: 429; reason: "rate"; retryAfter: number };

/** Every conversation's live session on Claude Code: one `query()` on streaming input each. */
export class Sessions {
  readonly #options: SessionsOptions;
  readonly #live = new Map<string, Session>();
  readonly #conversations = new Map<string, Session>();
  // Closed sessions whose process hasn't exited yet: they still take their room, for a while.
  readonly #closing = new Map<Session, ReturnType<typeof setTimeout>>();
  // Sessions whose last turn didn't finish: never resumed. Their transcripts are deleted as well,
  // for after a restart.
  readonly #unfinished = new Set<string>();
  // When the last minute's turns started.
  #started: number[] = [];

  constructor(options: SessionsOptions) {
    this.#options = options;
  }

  /** Starts a turn: its NDJSON stream, or why it can't start. */
  async turn(
    id: string,
    request: RunnerTurnRequest,
  ): Promise<{ stream: ReadableStream<Uint8Array> } | Refusal> {
    // The turn takes its place in the minute's before any wait, so a burst can't overshoot.
    const now = Date.now();
    this.#started = this.#started.filter((at) => at > now - 60_000);
    const [oldest] = this.#started;
    if (
      oldest !== undefined &&
      this.#started.length >= (this.#options.turnsPerMinute ?? TURNS_PER_MINUTE)
    ) {
      return { status: 429, reason: "rate", retryAfter: Math.ceil((oldest + 60_000 - now) / 1000) };
    }
    this.#started.push(now);
    const started = await this.#start(id, request);
    // A turn refused gives its place back: only the turns that start count.
    if (!("stream" in started)) this.#started.splice(this.#started.indexOf(now), 1);
    return started;
  }

  async #start(
    id: string,
    request: RunnerTurnRequest,
  ): Promise<{ stream: ReadableStream<Uint8Array> } | Refusal> {
    const known = this.#known(id, request);
    if (known) return known;
    const exists = await this.#options.sessionExists(id);
    if (exists !== request.resume) {
      return { status: 409, reason: request.resume ? "lost" : "mismatched" };
    }
    // Another request may have started it meanwhile.
    const raced = this.#known(id, request);
    if (raced) return raced;
    // A conversation's new session closes its old one. Past the cap, the session idle the
    // longest closes too, and it stays resumable. A closed session's process counts until it
    // exits, so at most one more than the cap runs: the one closing to make room.
    const max = this.#options.maxLive ?? MAX_LIVE;
    if (this.#live.size + this.#closing.size > max) return { status: 503, reason: "full" };
    const old = this.#conversations.get(request.conversation);
    if (this.#live.size - (old ? 1 : 0) >= max) {
      const idlest = this.#idlest(old);
      if (!idlest) return { status: 503, reason: "full" };
      idlest.close();
    }
    old?.close();
    const session = new Session(id, request, this.#options, {
      closed: (clean) => this.#closed(session, clean),
      exited: (clean) => void this.#exited(session, clean),
    });
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
  ): { stream: ReadableStream<Uint8Array> } | Refusal | undefined {
    if (this.#unfinished.has(id)) return { status: 409, reason: "unfinished" };
    // Its process may still write the transcript: a new one mustn't take it yet.
    for (const session of this.#closing.keys()) {
      if (session.id === id) return { status: 409, reason: "unfinished" };
    }
    const live = this.#live.get(id);
    if (!live) return undefined;
    if (!request.resume || !live.serves(request)) return { status: 409, reason: "mismatched" };
    if (live.busy) return { status: 409, reason: "unfinished" };
    return { stream: live.start(request) };
  }

  /** The live session idle the longest, other than `except`, if any is idle. */
  #idlest(except: Session | undefined): Session | undefined {
    let idlest: Session | undefined;
    for (const session of this.#live.values()) {
      if (session === except || session.idleSince === undefined) continue;
      if (!idlest || session.idleSince < (idlest.idleSince as number)) idlest = session;
    }
    return idlest;
  }

  // A session closes once, before another of its id or its conversation starts.
  #closed(session: Session, clean: boolean): void {
    this.#live.delete(session.id);
    this.#conversations.delete(session.conversation);
    this.#closing.set(
      session,
      setTimeout(() => this.#abandon(session), CLOSING_MS),
    );
    if (!clean) this.#markUnfinished(session.id);
  }

  /**
   * A closed session whose process hasn't exited in CLOSING_MS: its room is released, its id is
   * never resumed, and its transcript stays, as the process may still be alive.
   */
  #abandon(session: Session): void {
    this.#closing.delete(session);
    this.#markUnfinished(session.id);
    this.#options.warn(
      forLog(
        `Claude Code's session ${session.id} didn't exit ${CLOSING_MS / 1000} s after it closed: its room is released, and it won't be resumed`,
      ),
    );
  }

  #markUnfinished(id: string): void {
    this.#unfinished.add(id);
    if (this.#unfinished.size > (this.#options.maxUnfinished ?? MAX_UNFINISHED)) {
      this.#unfinished.delete(this.#unfinished.values().next().value as string);
    }
  }

  /**
   * A closed session's process exited. An unfinished session's transcript goes then, when nothing
   * can write it again. One Claude Code never wrote is fine.
   */
  async #exited(session: Session, clean: boolean): Promise<void> {
    clearTimeout(this.#closing.get(session));
    this.#closing.delete(session);
    if (clean) return;
    try {
      if (await this.#options.sessionExists(session.id)) {
        await this.#options.deleteSession(session.id);
      }
    } catch (error) {
      this.#options.warn(
        `Couldn't delete Claude Code's session ${session.id}: ${forLog(String(error))}`,
      );
    }
  }
}

/** One conversation's live session: Claude Code's process, its input, and its turn. */
class Session {
  readonly id: string;
  readonly conversation: string;
  readonly #key: string;
  readonly #options: SessionsOptions;
  readonly #events: SessionEvents;
  readonly #inbox = new Inbox();
  readonly #query: SessionQuery;
  #turn: Turn | undefined;
  #idle: ReturnType<typeof setTimeout> | undefined;
  #closed = false;
  #clean = true;
  // Whether the process began with its `system/init`, which the turn checks the isolation on.
  #initialized = false;
  /** When its last turn ended; undefined while a turn runs. */
  idleSince: number | undefined;

  constructor(
    id: string,
    request: RunnerTurnRequest,
    options: SessionsOptions,
    events: SessionEvents,
  ) {
    this.id = id;
    this.conversation = request.conversation;
    this.#key = keyOf(request);
    this.#options = options;
    this.#events = events;
    const server = kelpieServer(
      request.tools,
      (call, signal) => this.#call(call, signal),
      request.toolLoopMs + RESULT_GRACE_MS + CALL_TIMEOUT_MARGIN_MS,
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
        stderr: (data) => options.warn(`Claude Code (session ${id}): ${forLog(data.trimEnd())}`),
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
    this.idleSince = undefined;
    const turn = new Turn(
      this.id,
      request.toolLoopMs + RESULT_GRACE_MS,
      this.#options.warn,
      (finished) => this.#ended(turn, finished),
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
    if (!finished) {
      this.#shutdown(false);
      return;
    }
    this.idleSince = Date.now();
    this.#idle = setTimeout(() => this.close(), this.#options.idleMs ?? IDLE_MS);
  }

  /**
   * Hands Claude Code's messages to the turn. A process whose output comes before its init can't
   * have been checked, so it fails the turn; other messages before the init pass, unread. The
   * process ending ends the session.
   */
  async #read(): Promise<void> {
    let ending = "ended";
    try {
      for await (const message of this.#query) {
        if (!this.#initialized && !this.#closed) {
          if (message.type === "system" && message.subtype === "init") {
            this.#initialized = true;
          } else if (OUTPUT.has(message.type)) {
            this.#options.warn(
              `Claude Code's session ${this.id} sent ${forLog(message.type)} before its init`,
            );
            this.#shutdown(false);
          } else {
            continue;
          }
        }
        this.#turn?.handle(message);
      }
    } catch (error) {
      ending = `failed: ${forLog(error instanceof Error ? error.message : String(error))}`;
    }
    if (!this.#closed) this.#options.warn(`Claude Code's session ${this.id} ${ending}`);
    this.#shutdown(true);
    this.#events.exited(this.#clean);
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
    this.#clean = clean && turn === undefined;
    this.#events.closed(this.#clean);
  }
}

/** What a session tells its registry: that it closed, and later that its process exited. */
interface SessionEvents {
  closed(clean: boolean): void;
  exited(clean: boolean): void;
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
