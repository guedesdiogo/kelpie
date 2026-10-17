/**
 * Providers with a native adapter (ADR-0008), and `claude-code`, Claude Code on the owner's
 * subscription through the VPS runner (ADR-0037). That one has no adapter yet (#295), so route
 * tables and model settings still refuse it (`PROVIDERS`).
 */
export type ProviderId = "anthropic" | "openai" | "claude-code";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the tool input. */
  inputSchema: { type: "object"; [key: string]: unknown };
}

export interface TextPart {
  type: "text";
  text: string;
}

export interface ToolCallPart {
  type: "tool_call";
  id: string;
  name: string;
  input: unknown;
}

export interface UserMessage {
  role: "user";
  parts: TextPart[];
}

/**
 * A model reply, in two views:
 * - `parts` is provider-neutral. The runtime reads it, and it is what another provider receives.
 * - `native` is the provider's own output. It is replayed verbatim to the same provider, because
 *   thinking blocks and encrypted reasoning are only valid when every earlier turn is unchanged.
 *   It is absent when only part of a reply was kept (a delivery cut short), and then every
 *   provider receives the parts.
 */
export interface AssistantMessage {
  role: "assistant";
  parts: (TextPart | ToolCallPart)[];
  native?: NativeOutput;
}

export interface NativeOutput {
  provider: ProviderId;
  /** The model that produced the output, which can differ from the one requested. */
  model: string;
  /** Anthropic content blocks or OpenAI output items, as the provider returned them. */
  content: unknown[];
}

export interface ToolResult {
  callId: string;
  output: string;
  /** Anthropic marks the result as an error; OpenAI has no equivalent field. */
  isError?: boolean;
}

export interface ToolResultsMessage {
  role: "tool";
  results: ToolResult[];
}

export type ChatMessage = UserMessage | AssistantMessage | ToolResultsMessage;

/**
 * A provider-neutral completion request. It is plain data so it can cross Worker RPC.
 *
 * Keep `system`, `tools` and earlier messages identical across a conversation: providers reject or
 * drop replayed reasoning when the prefix before it changed.
 */
export interface LlmRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxOutputTokens: number;
  /** Only for models that accept it. Claude Haiku 4.5 rejects it. */
  effort?: Effort;
  /**
   * Text this request adds, such as the memories a turn retrieved. Every adapter places it the same
   * way: as a last text part of the last user message, or after a reply as a user message of its
   * own. A caller that sends it again on later requests puts it back there, as a text part of that
   * message, so the prefix stays what the model saw (#137). The messages before it stay cacheable.
   */
  context?: string;
}

/**
 * A conversation's session on a route that keeps the conversation itself, such as `claude-code`
 * (ADR-0037 §2, #295): one live session per conversation.
 */
export interface RouteSession {
  /** The conversation the session belongs to. */
  conversation: string;
  /** The session's id: the one to resume, or the one a new session takes. */
  id: string;
  /** Whether `id` names a session to resume. Otherwise a new session starts with that id. */
  resume: boolean;
}

/**
 * The caller's answers to `tool_request` events, for a route that runs its own tool loop (#295).
 * `wait` resolves with the result of the call `callId` once the caller answers it, and rejects when
 * `signal` aborts or the call ends first.
 */
export interface ToolAnswers {
  wait(callId: string, signal?: AbortSignal): Promise<ToolResult>;
}

export interface StreamOptions {
  signal?: AbortSignal;
  /** The conversation's session. Only a call with one reaches a provider that `needsSession`. */
  session?: RouteSession;
  /** Where a provider that sends `tool_request` events gets their results. */
  answers?: ToolAnswers;
}

/** Token counts for one model attempt. The four counts don't overlap. */
export interface Usage {
  model: string;
  inputUncached: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/**
 * - `stop`: the reply is complete.
 * - `tool_calls`: run the calls in `message.parts`, then send their results.
 * - `length`: cut off at `maxOutputTokens`. Incomplete tool calls are left out of the message.
 * - `refusal`: the model or a safety classifier declined. Discard any partial text.
 */
export type StopReason = "stop" | "tool_calls" | "length" | "refusal";

/**
 * - `text`: a piece of the reply's text, as it streams.
 * - `tool_round`: a reply whose tool calls the route's own loop runs, as `claude-code`'s does
 *   (#295). The stream goes on with the model's next reply. `usage` is that reply's.
 * - `tool_request`: a call of that loop the caller must run now. Its result goes back through
 *   `StreamOptions.answers`, and the stream waits for it.
 * - `finish`: the last reply. A route that keeps a session names it in `session`. `clean` is false
 *   when the session no longer matches the conversation's history, as after its own compaction or
 *   a cut.
 */
export type LlmEvent =
  | { type: "text"; delta: string }
  | { type: "tool_round"; message: AssistantMessage; usage: Usage[] }
  | { type: "tool_request"; call: ToolCallPart }
  | {
      type: "finish";
      reason: StopReason;
      message: AssistantMessage;
      usage: Usage[];
      session?: { id: string; clean: boolean };
    };

export interface LlmProvider {
  readonly id: ProviderId;
  /**
   * Set by a provider that serves only a call with a session (`StreamOptions.session`), because the
   * conversation lives in the route. The router skips it for any other call, so checkpoints, Dream
   * and conflict resolve never reach it (#295).
   */
  readonly needsSession?: true;
  stream(request: LlmRequest, options?: StreamOptions): AsyncIterable<LlmEvent>;
}
