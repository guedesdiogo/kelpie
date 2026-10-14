import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import {
  AnthropicMessagesProvider,
  EMBEDDING_PROVIDERS,
  type Embedder,
  type EmbeddingProviderId,
  type EmbedOutcome,
  LlmError,
  type LlmProvider,
  MODEL_AREAS,
  MODEL_TIERS,
  type ModelArea,
  type ModelDescription,
  ModelRouter,
  type ModelSelection,
  type ModelSettings,
  type ModelTier,
  modelAliasDescription,
  OpenAIEmbedder,
  OpenAIResponsesProvider,
  PROVIDERS,
  type ProviderId,
  parseModelSettings,
  parseRouteTable,
  type RouteChoice,
  type RoutedRequest,
  type RouteModel,
  resolveModel,
  toNdjsonStream,
  WorkersAiEmbedder,
} from "@kelpie/llm";
import {
  ClefQualifier,
  type GatewayQualifyOutcome,
  JevHttpQualifier,
  QUALIFIER_BACKENDS,
  type Qualifier,
  type QualifierBackend,
  type Question,
} from "@kelpie/qualifier";
import type { DefaultsActor, InstanceDefaults } from "./model-defaults.ts";

export { ModelDefaults } from "./model-defaults.ts";

/** Set by the owner with `wrangler secret put`. A provider is used only when its key is set. */
interface Secrets {
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  /** Token of an authenticated AI Gateway. */
  AI_GATEWAY_TOKEN?: string;
  /** Jev through TypeSafe's API (ADR-0018). Without it, end of turn uses the heuristic. */
  TYPESAFE_API_KEY?: string;
}

/** How long to wait for the qualifier: just past the caller's 800 ms, whose abort doesn't cross RPC. */
const QUALIFY_TIMEOUT_MS = 1_000;
/** A caller may wait longer, as memory's rerank does, but never more than this. */
const MAX_QUALIFY_TIMEOUT_MS = 3_000;
/** One `embed` call takes at most this many texts, and this long. */
const MAX_EMBED_TEXTS = 256;
const EMBED_TIMEOUT_MS = 30_000;

/** Vars a deploy may set to any string, whatever the generated types say (`docs/admin-api.md`). */
type GatewayEnv = Omit<Env, "EMBEDDING_PROVIDER" | "OPENAI_BASE_URL"> &
  Secrets & { EMBEDDING_PROVIDER: string; OPENAI_BASE_URL: string };

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
  generate(call: ModelSelection, request: RoutedRequest): Generation {
    return generateWith(this.env, call, request);
  }

  /**
   * Typed decisions through the agent's qualifier: Clef on Workers AI, or Jev on TypeSafe's API.
   * A caller that names none gets Jev, as before Clef existed. Personal data in `state` is masked
   * before it leaves.
   */
  qualify(
    state: unknown,
    questions: Record<string, Question>,
    backend: QualifierBackend = "jev",
    options: { timeoutMs?: number } = {},
  ): Promise<GatewayQualifyOutcome> {
    return qualifyWith(this.env, state, questions, backend, options);
  }

  /**
   * Vectors for up to 256 texts, one each, in order, from the instance's embedding model:
   * `EMBEDDING_PROVIDER` chooses bge-m3 on Workers AI or OpenAI (issue #110).
   */
  embed(texts: string[]): Promise<EmbedOutcome> {
    return embedWith(this.env, texts);
  }

  /** The trio an area resolves to now, and its route, for an agent's own prompt. See `describeWith`. */
  describe(area: ModelArea, agent?: ModelSettings, tier?: ModelTier): Promise<ModelDescription> {
    return describeWith(this.env, area, agent, tier);
  }

  /**
   * Each tier's route, for builds of conversation-runtime before #286, which describe themselves
   * with it during a rollout or a rollback. See `routesWith`.
   */
  routes(): Record<ModelTier, RouteModel[]> {
    return routesWith(this.env);
  }

  /** The providers with a key, in the route table's order (#289). */
  providers(): ProviderId[] {
    return providersWith(this.env);
  }

  /** The instance's model settings, its pinned provider and the providers with a key (#289). */
  instanceModels(): Promise<InstanceModels> {
    return instanceModelsWith(this.env);
  }

  /** Replaces the instance's model settings (#289). See `configureDefaultsWith`. */
  configureDefaults(
    settings: ModelSettings,
    actor: DefaultsActor,
  ): Promise<ConfigureDefaultsResult> {
    return configureDefaultsWith(this.env, settings, actor);
  }

  /** For the deploy's probe (#234), through conversation-runtime. See `pingWith`. */
  ping(): Promise<{ ok: true }> {
    return pingWith(this.env);
  }
}

/**
 * One model call. When ModelDefaults can't answer, the call goes on with no instance settings, in
 * the route table's order, as before #286: a model call never fails for them.
 */
export function generateWith(
  env: GatewayEnv,
  call: ModelSelection,
  request: RoutedRequest,
): Generation {
  const router = modelRouter(env);
  const controller = new AbortController();
  async function* routed() {
    const choice = await choiceFor(call, () => defaultsOrNone(env, router));
    yield* router.stream(choice, request, { signal: controller.signal });
  }
  const events = toNdjsonStream(
    routed(),
    () => controller.abort(),
    (error) => logFailure("generate", error),
  );
  return new Generation(events, controller);
}

/** The instance's model settings as Admin's tools show them. */
export interface InstanceModels {
  settings: ModelSettings;
  pinned: ProviderId | null;
  providers: ProviderId[];
}

export type ConfigureDefaultsResult = { ok: true } | { ok: false; reason: "invalid_input" };

/** The providers whose key is set, in the route table's provider order. */
export function providersWith(env: GatewayEnv): ProviderId[] {
  const configured = providers(env);
  return (PROVIDERS as readonly ProviderId[]).filter((id) => configured[id] !== undefined);
}

export async function instanceModelsWith(env: GatewayEnv): Promise<InstanceModels> {
  const { instance, pinned } = await env.MODEL_DEFAULTS.getByName("instance").view();
  return { settings: instance, pinned, providers: providersWith(env) };
}

/**
 * Replaces the instance's model settings (ADR-0036 §2), audited with `actor`. The configuration
 * commands are its callers and authorize the actor (ADR-0013); this validates the settings again,
 * because it is an RPC boundary, and refuses a provider that has no key.
 */
export async function configureDefaultsWith(
  env: GatewayEnv,
  settings: ModelSettings,
  actor: DefaultsActor,
): Promise<ConfigureDefaultsResult> {
  const parsed = parseModelSettings(settings);
  if (!parsed || !keyedProviders(env, parsed)) return { ok: false, reason: "invalid_input" };
  const who = { userId: String(actor?.userId ?? ""), via: String(actor?.via ?? "") };
  await env.MODEL_DEFAULTS.getByName("instance").configure(parsed, who);
  return { ok: true };
}

/** Whether every provider `settings` names has a key. */
function keyedProviders(env: GatewayEnv, settings: ModelSettings): boolean {
  const keyed = providersWith(env);
  return [settings.provider, settings.conversation?.provider, settings.memory?.provider].every(
    (provider) => provider === undefined || keyed.includes(provider),
  );
}

/**
 * For each tier, its candidates whose provider has a key, in the order they are tried, an alias
 * with what it stands for. Like `ping`, it calls no provider: an alias isn't resolved.
 */
export function routesWith(env: GatewayEnv): Record<ModelTier, RouteModel[]> {
  const router = modelRouter(env);
  return Object.fromEntries(
    MODEL_TIERS.map((tier) => [tier, router.route(tier).map(describeModel)]),
  ) as Record<ModelTier, RouteModel[]>;
}

/**
 * The trio `area` resolves to, and the models it would try in order. It calls no provider. When
 * ModelDefaults can't answer, it throws, so the caller keeps the last description it had rather
 * than one that would change its prompt for a turn.
 */
export async function describeWith(
  env: GatewayEnv,
  area: ModelArea,
  agent?: ModelSettings,
  tier?: ModelTier,
): Promise<ModelDescription> {
  const router = modelRouter(env);
  const call = { area, ...(agent ? { agent } : {}), ...(tier ? { tier } : {}) };
  const choice = await choiceFor(call, () => defaultsOf(env, router));
  return {
    provider: choice.provider ?? null,
    tier: choice.tier,
    ...(choice.effort ? { effort: choice.effort } : {}),
    route: router.route(choice.tier, choice.provider).map(describeModel),
  };
}

function describeModel({ provider, model }: RouteModel): RouteModel {
  const standsFor = provider === "anthropic" ? modelAliasDescription(model) : undefined;
  return { provider, model, ...(standsFor ? { standsFor } : {}) };
}

/**
 * Resolves a call's trio (ADR-0036 §2). RPC callers aren't type-checked, so an area, tier or
 * setting Kelpie doesn't know is refused rather than guessed. A tier alone, as callers before #286
 * send it, keeps the route table's order and the candidates' efforts.
 */
async function choiceFor(
  call: ModelSelection,
  defaults: () => Promise<InstanceDefaults>,
): Promise<RouteChoice> {
  if (typeof call === "string") return { tier: call };
  const invalid = (what: string) => new LlmError(`Unknown ${what}`, "bad_request", false);
  if (!(MODEL_AREAS as readonly string[]).includes(call?.area)) throw invalid("model area");
  if (call.tier !== undefined && !MODEL_TIERS.includes(call.tier)) throw invalid("tier");
  const agent = call.agent === undefined ? undefined : parseModelSettings(call.agent);
  if (agent === null) throw invalid("model setting");
  const { instance, pinned } = await defaults();
  return resolveModel({
    area: call.area,
    ...(agent ? { agent } : {}),
    instance,
    pinned,
    ...(call.tier ? { tier: call.tier } : {}),
  });
}

/**
 * The instance's settings and pinned provider. With nothing pinned yet, ModelDefaults pins the
 * first provider with a key in the cheap tier's order, and that pin then leads every tier.
 */
function defaultsOf(env: GatewayEnv, router: ModelRouter): Promise<InstanceDefaults> {
  const withKey = router.route("cheap")[0]?.provider ?? null;
  return env.MODEL_DEFAULTS.getByName("instance").defaults(withKey);
}

/** `defaultsOf`, or none when ModelDefaults can't answer, logged by the error's name only. */
async function defaultsOrNone(env: GatewayEnv, router: ModelRouter): Promise<InstanceDefaults> {
  try {
    return await defaultsOf(env, router);
  } catch (error) {
    console.error(
      "llm-gateway: ModelDefaults failed; using the route table's order",
      errorName(error),
    );
    return { instance: {}, pinned: null };
  }
}

/**
 * Loads what the calls use: the route table, each provider's settings and the embedding provider,
 * and wakes ModelDefaults. A configuration that can't load throws, so the deploy's probe catches it
 * before the first turn. It calls no provider, makes no request and pins nothing, so a probe costs
 * nothing and sends nothing out.
 */
export async function pingWith(env: GatewayEnv): Promise<{ ok: true }> {
  modelRouter(env);
  if (!isEmbeddingProvider(env.EMBEDDING_PROVIDER)) {
    throw new Error(`Unknown EMBEDDING_PROVIDER: ${env.EMBEDDING_PROVIDER}`);
  }
  await env.MODEL_DEFAULTS.getByName("instance").ping();
  return { ok: true };
}

function modelRouter(env: GatewayEnv): ModelRouter {
  return new ModelRouter(parseRouteTable(env.MODEL_ROUTES), providers(env));
}

/**
 * Texts must be non-empty strings. A failure is logged by its kind only, never with a provider's
 * message, which can quote a key, and answered as `failed`.
 */
export async function embedWith(
  env: GatewayEnv,
  texts: string[],
  timeoutMs = EMBED_TIMEOUT_MS,
): Promise<EmbedOutcome> {
  if (!Array.isArray(texts) || texts.length === 0 || texts.length > MAX_EMBED_TEXTS) {
    return { ok: false, reason: "invalid" };
  }
  // An indexed loop, so a hole in the array counts as missing.
  for (let i = 0; i < texts.length; i += 1) {
    const text = texts[i];
    if (typeof text !== "string" || text.trim() === "") return { ok: false, reason: "invalid" };
  }
  const embedder = embedderFor(env);
  if (!embedder) return { ok: false, reason: "not_configured" };
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const vectors = await embedder.embed(texts, { signal });
    return { ok: true, model: embedder.model, vectors };
  } catch (error) {
    if (signal.aborted) console.error("llm-gateway: embed timed out");
    else {
      const kind = error instanceof LlmError ? error.code : errorName(error);
      console.error(`llm-gateway: embed failed: ${kind}`);
    }
    return { ok: false, reason: "failed" };
  }
}

const isEmbeddingProvider = (value: string): value is EmbeddingProviderId =>
  (EMBEDDING_PROVIDERS as readonly string[]).includes(value);

/** The instance's embedder, or null when its provider is unknown or lacks its key. */
function embedderFor(env: GatewayEnv): Embedder | null {
  const provider = env.EMBEDDING_PROVIDER;
  if (!isEmbeddingProvider(provider)) {
    console.error(`llm-gateway: unknown EMBEDDING_PROVIDER: ${provider}`);
    return null;
  }
  switch (provider) {
    case "openai":
      if (!env.OPENAI_API_KEY) return null;
      return new OpenAIEmbedder(
        providerConfig(env.OPENAI_API_KEY, env.OPENAI_BASE_URL, env.AI_GATEWAY_TOKEN),
      );
    case "workers-ai":
      return new WorkersAiEmbedder({ run: aiRun(env) });
  }
}

/**
 * The AI binding as a plain signature: its types list known models with their own inputs, so
 * Clef's and bge-m3's names go through this. The options are still checked against AiOptions.
 */
function aiRun(env: GatewayEnv) {
  return env.AI.run.bind(env.AI) as unknown as <Input>(
    model: string,
    input: Input,
    options: AiOptions,
  ) => Promise<unknown>;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

/** Answers at once when Jev is asked without its key; a failure is logged here and answered as `failed`. */
export async function qualifyWith(
  env: GatewayEnv,
  state: unknown,
  questions: Record<string, Question>,
  backend: QualifierBackend = "jev",
  options: { timeoutMs?: number } = {},
): Promise<GatewayQualifyOutcome> {
  if (!QUALIFIER_BACKENDS.includes(backend)) {
    console.error("llm-gateway: unknown qualifier backend");
    return { ok: false, reason: "failed" };
  }
  try {
    const qualifier = qualifierFor(env, backend);
    if (!qualifier) return { ok: false, reason: "not_configured" };
    const asked = Math.trunc(options?.timeoutMs ?? QUALIFY_TIMEOUT_MS);
    const timeout = Number.isFinite(asked)
      ? Math.min(Math.max(asked, 100), MAX_QUALIFY_TIMEOUT_MS)
      : QUALIFY_TIMEOUT_MS;
    const signal = AbortSignal.timeout(timeout);
    return { ok: true, result: await qualifier.qualify(state, questions, { signal }) };
  } catch (error) {
    logFailure("qualify", error);
    return { ok: false, reason: "failed" };
  }
}

function qualifierFor(env: GatewayEnv, backend: QualifierBackend): Qualifier | null {
  if (backend === "clef") {
    const run = aiRun(env);
    return new ClefQualifier({
      model: env.CLEF_MODEL,
      run: (model, input, options) => run(model, input, options),
    });
  }
  if (!env.TYPESAFE_API_KEY) return null;
  return new JevHttpQualifier({
    apiKey: env.TYPESAFE_API_KEY,
    model: env.JEV_MODEL,
    fetch: (url, init) => fetch(url, init),
  });
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

/**
 * Logs a failed call by its kind, status and name, never by its message: providers build theirs from
 * the response, which can quote the prompt (issue #132). Aborts are expected and not logged.
 */
function logFailure(call: "generate" | "qualify", error: unknown): void {
  if (error instanceof LlmError) {
    if (error.code === "aborted") return;
    console.error(`llm-gateway: ${call} failed`, {
      code: error.code,
      retryable: error.retryable,
      ...(error.status === undefined ? {} : { status: error.status }),
    });
    return;
  }
  const status = (error as { status?: unknown } | null)?.status;
  console.error(`llm-gateway: ${call} failed`, {
    error: errorName(error),
    ...(typeof status === "number" ? { status } : {}),
  });
}

export default {
  fetch: () => new Response("Not found", { status: 404 }),
} satisfies ExportedHandler<GatewayEnv>;
