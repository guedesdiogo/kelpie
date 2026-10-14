import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { lowerEffort } from "./efforts.ts";
import { refuseEnvironmentHeaders } from "./env.ts";
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

export type AnthropicConfig = (
  | { apiKey: string; authToken?: never }
  /**
   * A Claude subscription token instead of an API key, sent as a bearer with the OAuth beta. Only
   * the smoke script sets it, to check whether Anthropic accepts one from Kelpie (#258): ADR-0008
   * reaches models with API keys.
   */
  | { authToken: string; apiKey?: never }
) & {
  /**
   * AI Gateway passthrough: `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic`.
   * Defaults to the Anthropic API.
   */
  baseURL?: string;
  /** Extra headers, such as `cf-aig-authorization` for an authenticated gateway. */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  /** Where resolved aliases are kept. Defaults to one cache per isolate. */
  aliasCache?: Map<string, ResolvedAlias>;
  /** The SDK's retries of a retryable failure: 1 unless set. */
  maxRetries?: number;
};

/** A model alias resolved to a model id, trusted until `expires` (epoch milliseconds). */
export interface ResolvedAlias {
  model: string;
  expires: number;
}

const ANTHROPIC_API = "https://api.anthropic.com";

// The API has no alias for a model family (`claude-haiku-latest` and `haiku` answer 404), so Kelpie
// resolves these itself: each stands for the newest release whose id has the prefix (issue #199).
const MODEL_ALIASES = new Map([
  ["haiku", { prefix: "claude-haiku-", description: "the newest Claude Haiku" }],
]);
const ALIAS_TTL_MS = 60 * 60 * 1000;
const ALIAS_CACHE = new Map<string, ResolvedAlias>();

/**
 * What an alias stands for, for a model's own prompt (#283), or undefined for a pinned id. Fixed
 * text, never the resolved id: the prompt must not change when the alias cache does.
 */
export function modelAliasDescription(model: string): string | undefined {
  return MODEL_ALIASES.get(model)?.description;
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
// What the API asks of a request that carries a subscription token as its bearer (#258).
const OAUTH_BETA = "oauth-2025-04-20";

/**
 * Anthropic Messages, streamed. Thinking is left at the model default (adaptive where available),
 * no sampling parameters or forced tool choice are sent, and the conversation is cached with
 * top-level `cache_control`. Tool input is not streamed eagerly: the runtime never acts on partial
 * input, and the API keeps validating it.
 */
export class AnthropicMessagesProvider implements LlmProvider {
  readonly id = "anthropic";
  readonly #client: Anthropic;
  readonly #aliases: Map<string, ResolvedAlias>;
  readonly #betas: readonly string[];

  constructor(config: AnthropicConfig) {
    refuseEnvironmentHeaders("ANTHROPIC_CUSTOM_HEADERS");
    this.#aliases = config.aliasCache ?? ALIAS_CACHE;
    const subscription = config.authToken !== undefined;
    this.#betas = subscription ? [OAUTH_BETA] : [];
    const headers = {
      ...(subscription ? { "anthropic-beta": OAUTH_BETA } : {}),
      ...config.headers,
    };
    this.#client = new Anthropic({
      // `null` keeps the SDK from reading the other credential from `process.env`, which holds a
      // Worker's vars and secrets, and sending it beside this one (issue #270).
      ...(subscription
        ? { apiKey: null, authToken: config.authToken }
        : { apiKey: config.apiKey, authToken: null }),
      // Explicit, so ANTHROPIC_BASE_URL can't send the credential elsewhere (issue #276).
      baseURL: config.baseURL || ANTHROPIC_API,
      ...(Object.keys(headers).length > 0 ? { defaultHeaders: headers } : {}),
      ...(config.fetch ? { fetch: config.fetch } : {}),
      // The router falls back to another provider, so one SDK retry is enough.
      maxRetries: config.maxRetries ?? 1,
      // Off, so ANTHROPIC_LOG can't log requests' headers and bodies, nor the SDK quote a stream it
      // can't parse. The gateway logs failures itself (issue #276).
      logLevel: "off",
    });
  }

  async *stream(request: LlmRequest, options: StreamOptions = {}): AsyncIterable<LlmEvent> {
    const model = await this.#resolve(request.model, options.signal);
    // Lowered again for the resolved model: an alias may stand for one that takes fewer (#286).
    const { effort: asked, ...rest } = request;
    const effort = lowerEffort(model, asked);
    let final: Anthropic.Beta.BetaMessage;
    try {
      const stream = this.#client.beta.messages.stream(
        toParams({ ...rest, model, ...(effort ? { effort } : {}) }, this.#betas),
        {
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield { type: "text", delta: event.delta.text };
        }
      }
      final = await stream.finalMessage();
    } catch (error) {
      throw toLlmError(error);
    }
    yield toFinish(final, model);
  }

  /**
   * An alias becomes the newest matching model in the Models API, by release date. A refused key
   * or an abort ends the turn, as on the call itself. Any other failure is retryable, so the router
   * tries the tier's next candidate: a gateway that doesn't serve the list answers 404.
   */
  async #resolve(model: string, signal: AbortSignal | undefined): Promise<string> {
    const prefix = MODEL_ALIASES.get(model)?.prefix;
    if (prefix === undefined) return model;
    const cached = this.#aliases.get(model);
    if (cached && cached.expires > Date.now()) return cached.model;
    let newest: { id: string; released: number } | undefined;
    try {
      for await (const info of this.#client.models.list(
        { limit: 1000 },
        signal ? { signal } : {},
      )) {
        if (!info.id.startsWith(prefix)) continue;
        // A date that doesn't parse ranks below any real one.
        const released = Date.parse(info.created_at) || Number.NEGATIVE_INFINITY;
        if (!newest || released > newest.released) newest = { id: info.id, released };
      }
    } catch (error) {
      const failure = toLlmError(error);
      if (failure instanceof LlmError && (failure.code === "aborted" || failure.code === "auth")) {
        throw failure;
      }
      const status = failure instanceof LlmError ? failure.status : undefined;
      throw new LlmError(
        `Couldn't resolve the model alias "${model}"`,
        "unavailable",
        true,
        status,
      );
    }
    if (!newest) throw new LlmError(`No model matches the alias "${model}"`, "unavailable", true);
    this.#aliases.set(model, { model: newest.id, expires: Date.now() + ALIAS_TTL_MS });
    return newest.id;
  }
}

/**
 * The request's parameters. `betas` are the provider's own, such as the OAuth beta: the SDK sends a
 * request's betas as the `anthropic-beta` header, which replaces the client's default one.
 */
function toParams(request: LlmRequest, betas: readonly string[]): BetaMessageStreamParams {
  const fallback = REFUSAL_FALLBACK_MODELS.has(request.model);
  const allBetas = [...(fallback ? [REFUSAL_FALLBACK_BETA] : []), ...betas];
  const messages = request.messages.flatMap((message) => {
    const param = toMessageParam(message);
    // Anthropic rejects an empty turn, such as a refusal that returned nothing.
    return param.content.length === 0 ? [] : [param];
  });
  const withContext = request.context?.trim() ? addContext(messages, request.context) : null;
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
    ...(fallback ? { fallbacks: "default" } : {}),
    ...(allBetas.length > 0 ? { betas: allBetas } : {}),
  };
}

/**
 * A request's context follows the conversation: in the last user turn, or as a turn of its own
 * after a reply. A breakpoint on the last block before it that can carry one caches what came
 * before, and the next request, which sends the context again as part of that turn, reads it.
 */
function addContext(
  messages: MessageParam[],
  context: string,
): { messages: MessageParam[]; marked: boolean } {
  const block: ContentBlockParam = { type: "text", text: context };
  const last = messages.at(-1);
  if (last === undefined) return { messages: [{ role: "user", content: [block] }], marked: false };
  const content: ContentBlockParam[] =
    typeof last.content === "string"
      ? [{ type: "text", text: last.content }]
      : (last.content as ContentBlockParam[]);
  const at = content.findLastIndex(cacheable);
  const closed = content.map((item, i) =>
    i === at ? ({ ...item, cache_control: { type: "ephemeral" } } as ContentBlockParam) : item,
  );
  const earlier = messages.slice(0, -1);
  return {
    messages:
      last.role === "user"
        ? [...earlier, { role: "user", content: [...closed, block] }]
        : [...earlier, { role: last.role, content: closed }, { role: "user", content: [block] }],
    marked: at !== -1,
  };
}

/** Blocks that can carry a breakpoint: not reasoning, and not empty text. */
function cacheable(block: ContentBlockParam): boolean {
  return (
    (block.type === "text" && block.text !== "") ||
    block.type === "tool_use" ||
    block.type === "tool_result"
  );
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
