import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import {
  isRunnerToolLoopMs,
  type ModelKey,
  type ModelKeyCheck,
  type ModelKeySource,
  type ProviderCheckContract,
  parseRunnerToolResult,
  RUNNER_SESSION_ID,
  type RunnerChatContract,
} from "@kelpie/channels";
import {
  AnthropicMessagesProvider,
  type ClaudeCodeClient,
  ClaudeCodeProvider,
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
  memoryOnSessionRoute,
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
  type RouterOptions,
  type RouteSession,
  resolveModel,
  type StreamOptions,
  type ToolAnswers,
  type ToolResult,
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
import { checkModelKey } from "./provider-check.ts";
import { withStoredKeys } from "./stored-keys.ts";

export { ModelDefaults } from "./model-defaults.ts";

/**
 * Set by the owner with `wrangler secret put`. A provider is used only when its key is set. A key
 * the owner set through a form since (ADR-0068) takes its secret's place (`withStoredKeys`).
 */
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
/** The longest conversation name a caller may send (#295). */
const MAX_ID_CHARS = 256;

/**
 * Vars a deploy may set to any string, whatever the generated types say (`docs/admin-api.md`). The
 * runner's binding may be missing, as in a build from before it.
 */
type GatewayEnv = Omit<
  Env,
  "EMBEDDING_PROVIDER" | "OPENAI_BASE_URL" | "MODEL_FALLBACK" | "RUNNER_CHAT"
> &
  Secrets & {
    EMBEDDING_PROVIDER: string;
    OPENAI_BASE_URL: string;
    MODEL_FALLBACK: string;
    RUNNER_CHAT?: Env["RUNNER_CHAT"];
  };

/**
 * What `Generation.answer` did with a result: taken, or ignored because it is malformed
 * (`invalid_input`), because no call by its id waits for one, never asked for or answered already
 * (`unknown_call`), or because the call is over (`ended`).
 */
export type AnswerOutcome =
  | { ok: true }
  | { ok: false; reason: "invalid_input" | "unknown_call" | "ended" };

/**
 * One model call. Read `events()` once, as newline-delimited JSON (decode it with
 * `fromNdjsonStream` from `@kelpie/llm`). Call `cancel()` to abort the provider request: cancelling
 * a stream received over RPC doesn't reach this side while the provider is quiet. A route that runs
 * its own tool loop sends `tool_request` events, and `answer()` gives each call its result (#295).
 */
export class Generation extends RpcTarget {
  readonly #events: ReadableStream<Uint8Array>;
  readonly #controller: AbortController;
  readonly #answers: PendingAnswers;

  constructor(
    events: ReadableStream<Uint8Array>,
    controller: AbortController,
    answers: PendingAnswers,
  ) {
    super();
    this.#events = events;
    this.#controller = controller;
    this.#answers = answers;
  }

  events(): ReadableStream<Uint8Array> {
    return this.#events;
  }

  cancel(): void {
    this.#controller.abort();
  }

  /**
   * A caller that drops its stub without `cancel()`, as an evicted conversation does, still ends
   * the call: a route waiting for a tool's result would otherwise wait until its own deadline.
   */
  [Symbol.dispose](): void {
    this.cancel();
  }

  /**
   * The result of a call a `tool_request` event asked for. It is an RPC boundary, so it is checked,
   * with the runner's own checks: a result taken here is one the relay takes too. The turn cuts a
   * result at 10,000 characters, plus a note, before it gets here (ADR-0025); they stop at 20,000.
   */
  answer(result: ToolResult): AnswerOutcome {
    const checked = parseRunnerToolResult(result);
    return checked ? this.#answers.answer(checked) : { ok: false, reason: "invalid_input" };
  }
}

/**
 * The results a route that runs its own tool loop waits for (#295). A call id is asked for when its
 * `tool_request` event goes out, and answered once, before or after the route starts waiting. It
 * all ends with the call: a wait then rejects, and a later answer is ignored.
 */
class PendingAnswers implements ToolAnswers {
  readonly #asked = new Set<string>();
  readonly #held = new Map<string, ToolResult>();
  readonly #waiting = new Map<
    string,
    {
      resolve: (result: ToolResult) => void;
      reject: (error: LlmError) => void;
      signal: AbortSignal | undefined;
      onAbort: () => void;
    }
  >();
  #ended = false;

  /** Notes a call the caller is asked to answer. */
  ask(callId: string): void {
    if (!this.#ended) this.#asked.add(callId);
  }

  answer(result: ToolResult): AnswerOutcome {
    if (this.#ended) return { ok: false, reason: "ended" };
    if (!this.#asked.delete(result.callId)) return { ok: false, reason: "unknown_call" };
    if (this.#waiting.has(result.callId)) this.#settle(result.callId, result);
    else this.#held.set(result.callId, result);
    return { ok: true };
  }

  wait(callId: string, signal?: AbortSignal): Promise<ToolResult> {
    if (this.#ended || signal?.aborted) return Promise.reject(callEnded());
    // A second wait would replace the first, which would then never settle.
    if (this.#waiting.has(callId)) {
      return Promise.reject(
        new LlmError("The route already waits for this call's result", "protocol", false),
      );
    }
    const held = this.#held.get(callId);
    if (held) {
      this.#held.delete(callId);
      return Promise.resolve(held);
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => this.#settle(callId, callEnded());
      this.#waiting.set(callId, { resolve, reject, signal, onAbort });
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Ends every wait, and the answers still to come: the call finished, failed or was cancelled. */
  end(): void {
    this.#ended = true;
    this.#asked.clear();
    this.#held.clear();
    for (const callId of [...this.#waiting.keys()]) this.#settle(callId, callEnded());
  }

  #settle(callId: string, outcome: ToolResult | LlmError): void {
    const waiter = this.#waiting.get(callId);
    if (!waiter) return;
    this.#waiting.delete(callId);
    waiter.signal?.removeEventListener("abort", waiter.onAbort);
    if (outcome instanceof LlmError) waiter.reject(outcome);
    else waiter.resolve(outcome);
  }
}

const callEnded = () =>
  new LlmError("The call ended before the tool's result came", "aborted", false);

const isBoundedText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value !== "" && value.length <= max;

const isConversationCall = (call: ModelSelection): boolean =>
  typeof call === "object" && call !== null && call.area === "conversation";

/**
 * A session as RPC sent it, rebuilt from the fields Kelpie knows; null when malformed. Its id goes
 * in the runner's paths, and its tool bound to the runner, so both pass the runner's own checks
 * (#421).
 */
function parseSession(value: unknown): RouteSession | null {
  if (typeof value !== "object" || value === null) return null;
  const { conversation, id, resume, toolLoopMs } = value as Partial<
    Record<keyof RouteSession, unknown>
  >;
  if (!isBoundedText(conversation, MAX_ID_CHARS)) return null;
  if (typeof id !== "string" || !RUNNER_SESSION_ID.test(id)) return null;
  if (!isRunnerToolLoopMs(toolLoopMs) || typeof resume !== "boolean") return null;
  return { conversation, id, resume, toolLoopMs };
}

/** Model access for Kelpie's other Workers, through a service binding. */
export class LlmGateway extends WorkerEntrypoint<GatewayEnv> {
  /**
   * One model call, without a session: a route that keeps one, as `claude-code` does, never serves
   * it. Sessions go through `LlmChat`, which only conversation-runtime binds (#431), so a session
   * sent here is refused as a bad request (#432).
   */
  generate(call: ModelSelection, request: RoutedRequest, session?: RouteSession): Generation {
    return generateWith(this.env, call, request, session, { sessions: false });
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
  routes(): Promise<Record<ModelTier, RouteModel[]>> {
    return routesWith(this.env);
  }

  /** For the deploy's probe (#234), through conversation-runtime. See `pingWith`. */
  ping(): Promise<{ ok: true }> {
    return pingWith(this.env);
  }
}

/**
 * Checks a candidate model key for a one-time form (ADR-0068 §2), with a cheap authenticated read
 * on its service: bound only by the admin API, which serves the form, so this Worker makes the
 * call and channel-egress calls no provider. It keeps nothing. See `checkModelKey`.
 */
export class ProviderCheck extends WorkerEntrypoint<GatewayEnv> implements ProviderCheckContract {
  check(name: ModelKey, value: string): Promise<ModelKeyCheck | "invalid_input"> {
    return checkModelKey(this.env, name, value);
  }
}

/**
 * A conversation's model calls, with its session (#295, #431): bound by conversation-runtime alone,
 * so a Worker that reads outside content, as context-store does through `LlmGateway`, can't reach a
 * route that runs on the owner's subscription.
 */
export class LlmChat extends WorkerEntrypoint<GatewayEnv> {
  /**
   * One model call. `session` is the conversation's, for a route that keeps one: only a call with a
   * session reaches such a route, and only a `conversation` call may send one.
   */
  generate(call: ModelSelection, request: RoutedRequest, session?: RouteSession): Generation {
    return generateWith(this.env, call, request, session);
  }
}

/**
 * The instance's model settings, for the configuration commands only (#289): bound by admin-api
 * and conversation-runtime, which run them behind the owner's check and confirmation. A Worker
 * that reads outside content, as context-store does, binds `LlmGateway` alone, so it can't change
 * what every agent costs.
 */
export class LlmGatewayAdmin extends WorkerEntrypoint<GatewayEnv> {
  /** The providers that serve, in Kelpie's provider order. See `providersWith`. */
  providers(): Promise<ProviderId[]> {
    return providersWith(this.env);
  }

  /**
   * The instance's model settings, its pinned provider, the providers that serve, and whether the
   * `claude-code` route is on.
   */
  instanceModels(): Promise<InstanceModels> {
    return instanceModelsWith(this.env);
  }

  /** Replaces the instance's model settings. See `configureDefaultsWith`. */
  configureDefaults(
    settings: ModelSettings,
    actor: DefaultsActor,
  ): Promise<ConfigureDefaultsResult> {
    return configureDefaultsWith(this.env, settings, actor);
  }

  /** Turns the `claude-code` route on or off. See `setClaudeCodeWith`. */
  setClaudeCode(on: boolean, actor: DefaultsActor): Promise<ConfigureDefaultsResult> {
    return setClaudeCodeWith(this.env, on, actor);
  }
}

/**
 * One model call. When ModelDefaults can't answer, the call goes on with no instance settings, in
 * the route table's order, as before #286, and with the `claude-code` route off: a model call never
 * fails for them. A malformed session is refused as a bad request, as is any session when the
 * entrypoint takes none (`sessions: false`).
 */
export function generateWith(
  env: GatewayEnv,
  call: ModelSelection,
  request: RoutedRequest,
  session?: RouteSession,
  { sessions = true }: { sessions?: boolean } = {},
): Generation {
  const controller = new AbortController();
  const answers = new PendingAnswers();
  controller.signal.addEventListener("abort", () => answers.end(), { once: true });
  async function* routed() {
    try {
      if (session !== undefined && !sessions) {
        throw new LlmError("Only LlmChat takes a session", "bad_request", false);
      }
      const checked = session === undefined ? undefined : parseSession(session);
      if (checked === null) throw new LlmError("Malformed session", "bad_request", false);
      // Only a conversation keeps a session: checkpoints, Dream and resolve never reach its route.
      if (checked && !isConversationCall(call)) {
        throw new LlmError("A session goes only with a conversation's call", "bad_request", false);
      }
      const { env: withKeys } = await withStoredKeys(env);
      const keyed = modelRouter(withKeys);
      const { choice, claudeCode } = await choiceFor(call, () => defaultsOrNone(env, keyed));
      const router = claudeCode ? modelRouter(withKeys, true) : keyed;
      const options: StreamOptions = {
        signal: controller.signal,
        answers,
        ...(checked ? { session: checked } : {}),
      };
      for await (const event of router.stream(choice, request, options)) {
        // Asked for before the caller sees it, so its answer can't come first.
        if (event.type === "tool_request") answers.ask(event.call.id);
        yield event;
      }
    } finally {
      answers.end();
    }
  }
  const events = toNdjsonStream(
    routed(),
    () => controller.abort(),
    (error) => logFailure("generate", error),
  );
  return new Generation(events, controller, answers);
}

const AUDIT_FIELD_CHARS = 128;

/** The instance's model settings as Master's configuration tools show them. */
export interface InstanceModels {
  settings: ModelSettings;
  pinned: ProviderId | null;
  providers: ProviderId[];
  /** Whether the owner turned the `claude-code` route on (#295). */
  claudeCode: boolean;
  /** Where each slot's key comes from (ADR-0068 §4): a form, the deploy, or none. Never the key. */
  keys: Record<ModelKey, ModelKeySource>;
}

export type ConfigureDefaultsResult = { ok: true } | { ok: false; reason: "invalid_input" };

/**
 * The providers that serve, in Kelpie's provider order (`PROVIDERS`): those whose key is set, and
 * `claude-code` while the owner's switch is on and the runner's binding exists (#295).
 */
export async function providersWith(env: GatewayEnv): Promise<ProviderId[]> {
  const { claudeCode } = await env.MODEL_DEFAULTS.getByName("instance").view();
  return serving((await withStoredKeys(env)).env, claudeCode);
}

function serving(env: GatewayEnv, claudeCode: boolean): ProviderId[] {
  const configured = providers(env, claudeCode);
  return (PROVIDERS as readonly ProviderId[]).filter((id) => configured[id] !== undefined);
}

export async function instanceModelsWith(env: GatewayEnv): Promise<InstanceModels> {
  const { instance, pinned, claudeCode } = await env.MODEL_DEFAULTS.getByName("instance").view();
  const { env: withKeys, sources } = await withStoredKeys(env);
  return {
    settings: instance,
    pinned,
    providers: serving(withKeys, claudeCode),
    claudeCode,
    keys: sources,
  };
}

/**
 * Replaces the instance's model settings (ADR-0036 §2), audited with `actor`. The configuration
 * commands are its callers and authorize the actor (ADR-0013); this validates the settings again,
 * because it is an RPC boundary. It refuses a provider that doesn't serve, and `claude-code` for
 * the `memory` area, whose calls carry no session (#295).
 */
export async function configureDefaultsWith(
  env: GatewayEnv,
  settings: ModelSettings,
  actor: DefaultsActor,
): Promise<ConfigureDefaultsResult> {
  const parsed = parseModelSettings(settings);
  if (!parsed || memoryOnSessionRoute(parsed)) return { ok: false, reason: "invalid_input" };
  const served = await providersWith(env);
  const named = [parsed.provider, parsed.conversation?.provider, parsed.memory?.provider];
  if (!named.every((provider) => provider === undefined || served.includes(provider))) {
    return { ok: false, reason: "invalid_input" };
  }
  await env.MODEL_DEFAULTS.getByName("instance").configure(parsed, auditActor(actor));
  return { ok: true };
}

/**
 * Turns the `claude-code` route on or off for the instance (#295), audited with `actor`. Its
 * callers are the configuration commands, which authorize the actor and, through Master, ask for
 * the owner's confirmation first (ADR-0013): it spends the subscription's weekly limit.
 */
export async function setClaudeCodeWith(
  env: GatewayEnv,
  on: boolean,
  actor: DefaultsActor,
): Promise<ConfigureDefaultsResult> {
  if (typeof on !== "boolean") return { ok: false, reason: "invalid_input" };
  await env.MODEL_DEFAULTS.getByName("instance").setClaudeCode(on, auditActor(actor));
  return { ok: true };
}

/** Bounded: the audit keeps who asked, not whatever a caller sends as such. */
function auditActor(actor: DefaultsActor): DefaultsActor {
  return {
    userId: String(actor?.userId ?? "").slice(0, AUDIT_FIELD_CHARS),
    via: String(actor?.via ?? "").slice(0, AUDIT_FIELD_CHARS),
  };
}

/**
 * For each tier, its candidates whose provider has a key, in the order they are tried, an alias
 * with what it stands for. Like `ping`, it calls no provider: an alias isn't resolved. Its callers'
 * calls carry no session, so `claude-code` is never among them.
 */
export async function routesWith(env: GatewayEnv): Promise<Record<ModelTier, RouteModel[]>> {
  const router = modelRouter((await withStoredKeys(env)).env);
  return Object.fromEntries(
    MODEL_TIERS.map((tier) => [tier, router.route(tier).map(describeModel)]),
  ) as Record<ModelTier, RouteModel[]>;
}

/**
 * The trio `area` resolves to, and the models it would try in order. It calls no provider. When
 * ModelDefaults can't answer, it throws, so the caller keeps the last description it had rather
 * than one that would change its prompt for a turn. A `conversation` is described as the owner's
 * own conversations run, with their session, so the route names `claude-code` while it is on: the
 * agent's prompt then names the route it may run on (#295).
 */
export async function describeWith(
  env: GatewayEnv,
  area: ModelArea,
  agent?: ModelSettings,
  tier?: ModelTier,
): Promise<ModelDescription> {
  const { env: withKeys } = await withStoredKeys(env);
  const keyed = modelRouter(withKeys);
  const call = { area, ...(agent ? { agent } : {}), ...(tier ? { tier } : {}) };
  const { choice, claudeCode } = await choiceFor(call, () => defaultsOf(env, keyed));
  const router = claudeCode ? modelRouter(withKeys, true) : keyed;
  return {
    provider: choice.provider ?? null,
    tier: choice.tier,
    ...(choice.effort ? { effort: choice.effort } : {}),
    route: router
      .route(choice.tier, choice.provider, { session: area === "conversation" })
      .map(describeModel),
  };
}

function describeModel({ provider, model }: RouteModel): RouteModel {
  const standsFor = provider === "anthropic" ? modelAliasDescription(model) : undefined;
  return { provider, model, ...(standsFor ? { standsFor } : {}) };
}

/**
 * Resolves a call's trio (ADR-0036 §2), and whether the `claude-code` route is on for it. RPC
 * callers aren't type-checked, so an area, tier or setting Kelpie doesn't know is refused rather
 * than guessed. A tier alone, as callers before #286 send it, keeps the route table's order and the
 * candidates' efforts; such a call carries no session, so the switch isn't read for it.
 */
async function choiceFor(
  call: ModelSelection,
  defaults: () => Promise<InstanceDefaults>,
): Promise<{ choice: RouteChoice; claudeCode: boolean }> {
  if (typeof call === "string") return { choice: { tier: call }, claudeCode: false };
  const invalid = (what: string) => new LlmError(`Unknown ${what}`, "bad_request", false);
  if (!(MODEL_AREAS as readonly string[]).includes(call?.area)) throw invalid("model area");
  if (call.tier !== undefined && !MODEL_TIERS.includes(call.tier)) throw invalid("tier");
  const agent = call.agent === undefined ? undefined : parseModelSettings(call.agent);
  if (agent === null) throw invalid("model setting");
  const { instance, pinned, claudeCode } = await defaults();
  const choice = resolveModel({
    area: call.area,
    ...(agent ? { agent } : {}),
    instance,
    pinned,
    ...(call.tier ? { tier: call.tier } : {}),
  });
  return { choice, claudeCode };
}

/**
 * The instance's settings, pinned provider and switch. With nothing pinned yet, ModelDefaults pins
 * the first provider with a key in the cheap tier's order, and that pin then leads every tier.
 * `claude-code` is never pinned: `keyed` routes over the providers with a key alone (#295).
 */
function defaultsOf(env: GatewayEnv, keyed: ModelRouter): Promise<InstanceDefaults> {
  const withKey = keyed.route("cheap")[0]?.provider ?? null;
  return env.MODEL_DEFAULTS.getByName("instance").defaults(withKey);
}

/** `defaultsOf`, or none when ModelDefaults can't answer, logged by the error's name only. */
async function defaultsOrNone(env: GatewayEnv, keyed: ModelRouter): Promise<InstanceDefaults> {
  try {
    return await defaultsOf(env, keyed);
  } catch (error) {
    console.error(
      "llm-gateway: ModelDefaults failed; using the route table's order",
      errorName(error),
    );
    return { instance: {}, pinned: null, claudeCode: false };
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

/** The router over the providers that serve: `claude-code` among them only while `claudeCode`. */
function modelRouter(env: GatewayEnv, claudeCode = false): ModelRouter {
  return new ModelRouter(
    parseRouteTable(env.MODEL_ROUTES),
    providers(env, claudeCode),
    routerOptions(env),
  );
}

/** Only "off" stops at the first failed route: a typo keeps the default, falling back (#293). */
export function routerOptions(env: Pick<GatewayEnv, "MODEL_FALLBACK">): RouterOptions {
  return { fallback: env.MODEL_FALLBACK !== "off" };
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
  // Only OpenAI's embeddings need a key, so only they read the stored ones.
  const embedder = embedderFor(
    env.EMBEDDING_PROVIDER === "openai" ? (await withStoredKeys(env)).env : env,
  );
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
    // Only Jev needs a key, so only it reads the stored ones.
    const qualifier = qualifierFor(
      backend === "jev" ? (await withStoredKeys(env)).env : env,
      backend,
    );
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

/**
 * The providers that serve: each one whose key is set, and `claude-code` when `claudeCode`, the
 * owner's switch, is on and the runner's binding exists (#295). Extra cost is opt-in: the route
 * spends the subscription's weekly limit, which the owner's own coding shares (ADR-0037 §5).
 */
function providers(env: GatewayEnv, claudeCode = false): Partial<Record<ProviderId, LlmProvider>> {
  const runner = claudeCode ? runnerChat(env) : undefined;
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
    ...(runner ? { "claude-code": new ClaudeCodeProvider(runner) } : {}),
  };
}

/** channel-egress's `RunnerChat` entrypoint, which answers with values, as the route's client. */
function runnerChat(env: GatewayEnv): ClaudeCodeClient | undefined {
  // The binding's stub types each call as RPC; the entrypoint implements the contract, and the
  // contract is a client.
  const contract = env.RUNNER_CHAT as unknown as RunnerChatContract | undefined;
  return contract;
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
