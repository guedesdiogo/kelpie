import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { errorFromStatus, LlmError } from "./errors.ts";
import type {
  AssistantMessage,
  ChatMessage,
  LlmEvent,
  LlmProvider,
  LlmRequest,
  StopReason,
  StreamOptions,
  TextPart,
  ToolCallPart,
  Usage,
} from "./types.ts";

type ContentBlock = Anthropic.Beta.BetaContentBlock;
type ContentBlockParam = Anthropic.Beta.BetaContentBlockParam;
type MessageParam = Anthropic.Beta.BetaMessageParam;

export interface AnthropicConfig {
  apiKey: string;
  /** AI Gateway passthrough: `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic`. */
  baseURL?: string;
  /** Extra headers, such as `cf-aig-authorization` for an authenticated gateway. */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

// Models that accept server-side refusal fallback. On a policy decline the API retries the same
// request on a substitute model chosen by refusal category, inside the same call.
const REFUSAL_FALLBACK_MODELS = new Set([
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5-5",
]);
const REFUSAL_FALLBACK_BETA = "server-side-fallback-2026-07-01";

/**
 * Anthropic Messages, streamed. Thinking is left at the model default (adaptive where available),
 * no sampling parameters or forced tool choice are sent, and the conversation is cached with
 * top-level `cache_control`. Tool input is not streamed eagerly: the runtime never acts on partial
 * input, and the API keeps validating it.
 */
export class AnthropicMessagesProvider implements LlmProvider {
  readonly id = "anthropic";
  readonly #client: Anthropic;

  constructor(config: AnthropicConfig) {
    this.#client = new Anthropic({
      apiKey: config.apiKey,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      ...(config.headers ? { defaultHeaders: config.headers } : {}),
      ...(config.fetch ? { fetch: config.fetch } : {}),
      // The router falls back to another provider, so one SDK retry is enough.
      maxRetries: 1,
    });
  }

  async *stream(request: LlmRequest, options: StreamOptions = {}): AsyncIterable<LlmEvent> {
    let final: Anthropic.Beta.BetaMessage;
    try {
      const stream = this.#client.beta.messages.stream(toParams(request), {
        ...(options.signal ? { signal: options.signal } : {}),
      });
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield { type: "text", delta: event.delta.text };
        }
      }
      final = await stream.finalMessage();
    } catch (error) {
      throw toLlmError(error);
    }
    yield toFinish(final, request.model);
  }
}

function toParams(request: LlmRequest): BetaMessageStreamParams {
  const fallback = REFUSAL_FALLBACK_MODELS.has(request.model);
  const messages = request.messages.flatMap((message) => {
    const param = toMessageParam(message);
    // Anthropic rejects an empty turn, such as a refusal that returned nothing.
    return param.content.length === 0 ? [] : [param];
  });
  const withContext = request.context ? addContext(messages, request.context) : null;
  return {
    model: request.model,
    max_tokens: request.maxOutputTokens,
    system: request.system,
    messages: withContext?.messages ?? messages,
    // The cache is written only at a breakpoint: the automatic one, on the last block, unless the
    // context took its place before itself.
    ...(withContext?.marked ? {} : { cache_control: { type: "ephemeral" } }),
    ...(request.tools
      ? {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
          })),
        }
      : {}),
    ...(request.effort ? { output_config: { effort: request.effort } } : {}),
    ...(fallback ? { fallbacks: "default", betas: [REFUSAL_FALLBACK_BETA] } : {}),
  };
}

/**
 * A request's context joins the last user turn, after a breakpoint on that turn's last block, so the
 * conversation is cached without it. After a reply, the context comes as a turn of its own, and the
 * automatic breakpoint stays.
 */
function addContext(
  messages: MessageParam[],
  context: string,
): { messages: MessageParam[]; marked: boolean } {
  const block: ContentBlockParam = { type: "text", text: context };
  const last = messages.at(-1);
  const end = Array.isArray(last?.content) ? last.content.at(-1) : undefined;
  if (last?.role !== "user" || !Array.isArray(last.content) || !end) {
    return { messages: [...messages, { role: "user", content: [block] }], marked: false };
  }
  const content = [
    ...last.content.slice(0, -1),
    { ...end, cache_control: { type: "ephemeral" } } as ContentBlockParam,
    block,
  ];
  return { messages: [...messages.slice(0, -1), { role: "user", content }], marked: true };
}

function toMessageParam(message: ChatMessage): MessageParam {
  switch (message.role) {
    case "user":
      return {
        role: "user",
        content: message.parts.map((part) => ({ type: "text", text: part.text })),
      };
    case "tool":
      return {
        role: "user",
        content: message.results.map((result) => ({
          type: "tool_result",
          tool_use_id: result.callId,
          content: result.output,
          ...(result.isError ? { is_error: true } : {}),
        })),
      };
    case "assistant":
      return {
        role: "assistant",
        content:
          message.native?.provider === "anthropic"
            ? (message.native.content as ContentBlockParam[])
            : message.parts.flatMap(toForeignBlock),
      };
  }
}

/** Rebuilds a reply from another provider. Its reasoning doesn't transfer. */
function toForeignBlock(part: TextPart | ToolCallPart): ContentBlockParam[] {
  if (part.type === "tool_call") {
    return [{ type: "tool_use", id: part.id, name: part.name, input: part.input }];
  }
  // Anthropic rejects empty text blocks.
  return part.text ? [{ type: "text", text: part.text }] : [];
}

function toFinish(message: Anthropic.Beta.BetaMessage, requestedModel: string): LlmEvent {
  const reason = toStopReason(message.stop_reason);
  const kept = dropDeclinedPartial(message.content);
  // A tool call cut off by the token limit never runs, so the replayed turn can't hold it either.
  const content = reason === "length" ? kept.filter((block) => block.type !== "tool_use") : kept;
  const parts: AssistantMessage["parts"] = [];
  for (const block of content) {
    if (block.type === "text" && block.text) parts.push({ type: "text", text: block.text });
    if (block.type === "tool_use") {
      parts.push({ type: "tool_call", id: block.id, name: block.name, input: block.input });
    }
  }
  return {
    type: "finish",
    reason,
    message: {
      role: "assistant",
      parts,
      native: { provider: "anthropic", model: message.model, content },
    },
    usage: toUsage(message, requestedModel),
  };
}

/**
 * After a mid-output refusal fallback, the blocks before the last `fallback` block came from the
 * model that declined. Its text stays. Its thinking is dropped, and so are its tool calls, which
 * never ran. The `fallback` block keeps its position as the boundary.
 */
export function dropDeclinedPartial(content: ContentBlock[]): ContentBlock[] {
  const boundary = content.findLastIndex((block) => block.type === "fallback");
  if (boundary <= 0) return content;
  return content.filter(
    (block, index) => index >= boundary || block.type === "text" || block.type === "fallback",
  );
}

function toStopReason(reason: Anthropic.Beta.BetaStopReason | null): StopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "refusal":
      return "refusal";
    default:
      // pause_turn and compaction only follow server tools and compaction, which Kelpie doesn't send.
      throw new LlmError(`Unexpected stop reason: ${reason}`, "protocol", false);
  }
}

/**
 * Anthropic counts cache reads and writes on top of `input_tokens`. With a refusal fallback, the
 * top-level usage covers only the attempt that served the reply; `iterations` lists every attempt,
 * each billed at its own model's price.
 */
function toUsage(message: Anthropic.Beta.BetaMessage, requestedModel: string): Usage[] {
  const attempts = (message.usage.iterations ?? []).filter(
    (entry) => entry.type === "message" || entry.type === "fallback_message",
  );
  if (attempts.length > 0) {
    return attempts.map((entry) => ({
      model: entry.model ?? requestedModel,
      inputUncached: entry.input_tokens,
      cacheRead: entry.cache_read_input_tokens,
      cacheWrite: entry.cache_creation_input_tokens,
      output: entry.output_tokens,
    }));
  }
  const usage = message.usage;
  return [
    {
      model: message.model,
      inputUncached: usage.input_tokens,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
      output: usage.output_tokens,
    },
  ];
}

function toLlmError(error: unknown): unknown {
  if (error instanceof LlmError) return error;
  if (error instanceof Anthropic.APIUserAbortError) {
    return new LlmError(error.message, "aborted", false);
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new LlmError(error.message, "connection", true);
  }
  if (error instanceof Anthropic.APIError) {
    return errorFromStatus(error.status, error.message, error.type);
  }
  return error;
}
