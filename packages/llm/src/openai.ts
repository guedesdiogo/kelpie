import OpenAI from "openai";
import type {
  Response as OpenAIResponse,
  ResponseInputItem,
} from "openai/resources/responses/responses";
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
} from "./types.ts";

export interface OpenAIConfig {
  apiKey: string;
  /**
   * AI Gateway passthrough: `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/openai`.
   * Defaults to the OpenAI API.
   */
  baseURL?: string;
  /** Extra headers, such as `cf-aig-authorization` for an authenticated gateway. */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

/**
 * OpenAI Responses, streamed and stateless: nothing is stored at OpenAI, so each turn resends the
 * previous output items, including the encrypted reasoning.
 */
export class OpenAIResponsesProvider implements LlmProvider {
  readonly id = "openai";
  readonly #client: OpenAI;

  constructor(config: OpenAIConfig) {
    this.#client = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      ...(config.headers ? { defaultHeaders: config.headers } : {}),
      ...(config.fetch ? { fetch: config.fetch } : {}),
      // The router falls back to another provider, so one SDK retry is enough.
      maxRetries: 1,
    });
  }

  async *stream(request: LlmRequest, options: StreamOptions = {}): AsyncIterable<LlmEvent> {
    let final: OpenAIResponse | undefined;
    try {
      // A raw stream rather than `responses.stream()`: that helper's final response adds
      // `parsed_arguments` and `parsed` fields, which would be replayed to OpenAI as input.
      const stream = await this.#client.responses.create(
        {
          model: request.model,
          instructions: request.system,
          input: request.messages.flatMap(toInputItems),
          max_output_tokens: request.maxOutputTokens,
          store: false,
          include: ["reasoning.encrypted_content"],
          ...(request.tools
            ? {
                tools: request.tools.map((tool) => ({
                  type: "function" as const,
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.inputSchema,
                  // Strict mode requires every property to be required, which MCP schemas rarely are.
                  strict: false,
                })),
              }
            : {}),
          ...(request.effort ? { reasoning: { effort: request.effort } } : {}),
          stream: true,
        },
        { ...(options.signal ? { signal: options.signal } : {}) },
      );
      for await (const event of stream) {
        if (event.type === "response.output_text.delta") {
          yield { type: "text", delta: event.delta };
        } else if (
          event.type === "response.completed" ||
          event.type === "response.incomplete" ||
          event.type === "response.failed"
        ) {
          final = event.response;
        }
      }
    } catch (error) {
      throw toLlmError(error);
    }
    // The raw stream ends quietly when aborted instead of throwing.
    if (options.signal?.aborted) throw new LlmError("The request was aborted", "aborted", false);
    if (!final) throw new LlmError("The stream ended without a final response", "connection", true);
    yield toFinish(final);
  }
}

function toInputItems(message: ChatMessage): ResponseInputItem[] {
  switch (message.role) {
    case "user":
      return [
        {
          type: "message",
          role: "user",
          content: message.parts.map((part) => ({ type: "input_text", text: part.text })),
        },
      ];
    case "tool":
      return message.results.map((result) => ({
        type: "function_call_output",
        call_id: result.callId,
        output: result.output,
      }));
    case "assistant":
      return message.native.provider === "openai"
        ? (message.native.content as ResponseInputItem[])
        : message.parts.flatMap(toForeignItem);
  }
}

/** Rebuilds a reply from another provider. Its reasoning doesn't transfer. */
function toForeignItem(part: TextPart | ToolCallPart): ResponseInputItem[] {
  if (part.type === "tool_call") {
    return [
      {
        type: "function_call",
        call_id: part.id,
        name: part.name,
        arguments: JSON.stringify(part.input),
      },
    ];
  }
  return part.text ? [{ role: "assistant", content: part.text }] : [];
}

function toFinish(response: OpenAIResponse): LlmEvent {
  const reason = toStopReason(response);
  const parts: AssistantMessage["parts"] = [];
  for (const item of response.output) {
    if (item.type === "message") {
      for (const content of item.content) {
        if (content.type === "output_text" && content.text) {
          parts.push({ type: "text", text: content.text });
        }
      }
    }
    if (item.type === "function_call" && reason !== "length") {
      parts.push({
        type: "tool_call",
        id: item.call_id,
        name: item.name,
        input: parseArguments(item.arguments),
      });
    }
  }
  return {
    type: "finish",
    reason,
    message: {
      role: "assistant",
      parts,
      native: { provider: "openai", model: response.model, content: response.output },
    },
    usage: [toUsage(response)],
  };
}

function toStopReason(response: OpenAIResponse): StopReason {
  switch (response.status) {
    case "completed": {
      const refused = response.output.some(
        (item) =>
          item.type === "message" && item.content.some((content) => content.type === "refusal"),
      );
      if (refused) return "refusal";
      return response.output.some((item) => item.type === "function_call") ? "tool_calls" : "stop";
    }
    case "incomplete":
      if (response.incomplete_details?.reason === "max_output_tokens") return "length";
      if (response.incomplete_details?.reason === "content_filter") return "refusal";
      break;
    case "failed": {
      const message = response.error?.message ?? "The response failed";
      if (response.error?.code === "rate_limit_exceeded") {
        throw new LlmError(message, "rate_limited", true);
      }
      if (response.error?.code === "server_error")
        throw new LlmError(message, "server_error", true);
      throw new LlmError(message, "bad_request", false);
    }
  }
  throw new LlmError(`Unexpected response status: ${response.status}`, "protocol", false);
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new LlmError("A function call has arguments that aren't JSON", "protocol", false);
  }
}

/** OpenAI counts cache reads and writes inside `input_tokens`. */
function toUsage(response: OpenAIResponse) {
  const usage = response.usage;
  if (!usage) throw new LlmError("The response has no usage", "protocol", false);
  const cacheRead = usage.input_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = usage.input_tokens_details?.cache_write_tokens ?? 0;
  return {
    model: response.model,
    inputUncached: usage.input_tokens - cacheRead - cacheWrite,
    cacheRead,
    cacheWrite,
    output: usage.output_tokens,
  };
}

function toLlmError(error: unknown): unknown {
  if (error instanceof LlmError) return error;
  if (error instanceof OpenAI.APIUserAbortError) {
    return new LlmError(error.message, "aborted", false);
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return new LlmError(error.message, "connection", true);
  }
  if (error instanceof OpenAI.APIError) return errorFromStatus(error.status, error.message);
  return error;
}
