/** Providers with a native adapter (ADR-0008). */
export type ProviderId = "anthropic" | "openai";

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
 */
export interface AssistantMessage {
  role: "assistant";
  parts: (TextPart | ToolCallPart)[];
  native: NativeOutput;
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
}

export interface StreamOptions {
  signal?: AbortSignal;
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
 * - `length`: cut off at `maxOutputTokens`. Incomplete tool calls are left out of `parts`.
 * - `refusal`: the model or a safety classifier declined. Discard any partial text.
 */
export type StopReason = "stop" | "tool_calls" | "length" | "refusal";

export type LlmEvent =
  | { type: "text"; delta: string }
  | { type: "finish"; reason: StopReason; message: AssistantMessage; usage: Usage[] };

export interface LlmProvider {
  readonly id: ProviderId;
  stream(request: LlmRequest, options?: StreamOptions): AsyncIterable<LlmEvent>;
}
