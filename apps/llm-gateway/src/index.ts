import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import {
  AnthropicMessagesProvider,
  LlmError,
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
    const events = toNdjsonStream(
      router.stream(tier, request, { signal: controller.signal }),
      () => controller.abort(),
      (error) => logFailure(error, this.env),
    );
    return new Generation(events, controller);
  }
}

function providers(env: GatewayEnv): Partial<Record<ProviderId, LlmProvider>> {
  return {
    ...(env.ANTHROPIC_API_KEY
      ? {
          anthropic: new AnthropicMessagesProvider(
            providerConfig(env.ANTHROPIC_API_KEY, env.ANTHROPIC_BASE_URL, env.AI_GATEWAY_TOKEN),
          ),
        }
      : {}),
    ...(env.OPENAI_API_KEY
      ? {
          openai: new OpenAIResponsesProvider(
            providerConfig(env.OPENAI_API_KEY, env.OPENAI_BASE_URL, env.AI_GATEWAY_TOKEN),
          ),
        }
      : {}),
  };
}

const AI_GATEWAY_HOST = "gateway.ai.cloudflare.com";

/** Keys only travel over https, and the gateway token only to the gateway. */
export function providerConfig(apiKey: string, baseURL: string, gatewayToken?: string) {
  const url = new URL(baseURL);
  if (url.protocol !== "https:") throw new Error(`Provider base URL must use https: ${baseURL}`);
  return {
    apiKey,
    baseURL,
    ...(gatewayToken && url.hostname === AI_GATEWAY_HOST
      ? { headers: { "cf-aig-authorization": `Bearer ${gatewayToken}` } }
      : {}),
  };
}

/** Logs a failed call with the configured secrets redacted. Aborts are expected and not logged. */
function logFailure(error: unknown, env: GatewayEnv): void {
  if (error instanceof LlmError && error.code === "aborted") return;
  let text = error instanceof LlmError ? `${error.code}: ${error.message}` : String(error);
  for (const secret of [env.ANTHROPIC_API_KEY, env.OPENAI_API_KEY, env.AI_GATEWAY_TOKEN]) {
    if (secret) text = text.replaceAll(secret, "[redacted]");
  }
  console.error(`llm-gateway: ${text}`);
}

export default {
  fetch: () => new Response("Not found", { status: 404 }),
} satisfies ExportedHandler<GatewayEnv>;
