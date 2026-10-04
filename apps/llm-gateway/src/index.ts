import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import {
  AnthropicMessagesProvider,
  type LlmProvider,
  ModelRouter,
  type ModelTier,
  OpenAIResponsesProvider,
  type ProviderId,
  parseRouteTable,
  type RoutedRequest,
  toNdjsonStream,
} from "@kelpie/llm";

/** Set by the owner with `wrangler secret put`. A provider is used only when its key is set. */
interface Secrets {
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  /** Token of an authenticated AI Gateway. */
  AI_GATEWAY_TOKEN?: string;
}

type GatewayEnv = Env & Secrets;

/**
 * One model call. Read `events()` once, as newline-delimited JSON (decode it with
 * `fromNdjsonStream` from `@kelpie/llm`). Call `cancel()` to abort the provider request: cancelling
 * a stream received over RPC doesn't reach this side while the provider is quiet.
 */
export class Generation extends RpcTarget {
  readonly #events: ReadableStream<Uint8Array>;
  readonly #controller: AbortController;

  constructor(events: ReadableStream<Uint8Array>, controller: AbortController) {
    super();
    this.#events = events;
    this.#controller = controller;
  }

  events(): ReadableStream<Uint8Array> {
    return this.#events;
  }

  cancel(): void {
    this.#controller.abort();
  }
}

/** Model access for Kelpie's other Workers, through a service binding. */
export class LlmGateway extends WorkerEntrypoint<GatewayEnv> {
  generate(tier: ModelTier, request: RoutedRequest): Generation {
    const router = new ModelRouter(parseRouteTable(this.env.MODEL_ROUTES), providers(this.env));
    const controller = new AbortController();
    const events = toNdjsonStream(router.stream(tier, request, { signal: controller.signal }), () =>
      controller.abort(),
    );
    return new Generation(events, controller);
  }
}

function providers(env: GatewayEnv): Partial<Record<ProviderId, LlmProvider>> {
  const headers = env.AI_GATEWAY_TOKEN
    ? { headers: { "cf-aig-authorization": `Bearer ${env.AI_GATEWAY_TOKEN}` } }
    : {};
  return {
    ...(env.ANTHROPIC_API_KEY
      ? {
          anthropic: new AnthropicMessagesProvider({
            apiKey: env.ANTHROPIC_API_KEY,
            baseURL: env.ANTHROPIC_BASE_URL,
            ...headers,
          }),
        }
      : {}),
    ...(env.OPENAI_API_KEY
      ? {
          openai: new OpenAIResponsesProvider({
            apiKey: env.OPENAI_API_KEY,
            baseURL: env.OPENAI_BASE_URL,
            ...headers,
          }),
        }
      : {}),
  };
}

export default {
  fetch: () => new Response("Not found", { status: 404 }),
} satisfies ExportedHandler<GatewayEnv>;
