import { EFFORTS, lowerEffort } from "./efforts.ts";
import { LlmError, type LlmErrorCode } from "./errors.ts";
import type {
  Effort,
  LlmEvent,
  LlmProvider,
  LlmRequest,
  ProviderId,
  StreamOptions,
} from "./types.ts";

export const MODEL_TIERS = ["cheap", "medium", "frontier"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export interface RouteCandidate {
  provider: ProviderId;
  model: string;
  effort?: Effort;
}

/** For each tier, the models to try in order. */
export type RouteTable = Record<ModelTier, RouteCandidate[]>;

/**
 * A model a tier would use, as llm-gateway's `route` describes it for an agent's own prompt (#283).
 * `standsFor` spells out an alias, such as `haiku`.
 */
export interface RouteModel {
  provider: ProviderId;
  model: string;
  standsFor?: string;
}

/** A request without the model choice, which the router makes. */
export type RoutedRequest = Omit<LlmRequest, "model" | "effort">;

/**
 * Which tier to use, and optionally the provider to try first and the effort to send (ADR-0036 §2):
 * a trio `resolveModel` resolved.
 */
export interface RouteChoice {
  tier: ModelTier;
  provider?: ProviderId | null;
  effort?: Effort;
}

/**
 * A route that failed before sending anything, and the one tried next (#293). The router sends it
 * before the next route's events, so the caller can tell the owner: no route fails silently
 * (ADR-0037 §4).
 */
export interface FallbackEvent {
  type: "fallback";
  failed: { provider: ProviderId; model: string; code: LlmErrorCode };
  next: { provider: ProviderId; model: string };
}

/** What the router streams: a provider's events, and the fallbacks between them. */
export type RouterEvent = LlmEvent | FallbackEvent;

export interface RouterOptions {
  /**
   * Whether a failed route hands the request to the next one (`MODEL_FALLBACK`). Off, the first
   * failure ends the request with its error. On by default.
   */
  fallback?: boolean;
}

/**
 * Streams the choice's first candidate: the chosen provider's, or the tier's first. When a provider
 * fails with a retryable error before it has sent anything, the next candidate takes over. Once an
 * event has gone out, a failure ends the turn: another model would start the reply again, and
 * reasoning doesn't carry across providers. Candidates whose provider isn't configured are skipped.
 * Each fallback is announced with a `fallback` event; with fallback off, the first failure ends it.
 */
export class ModelRouter {
  readonly #routes: RouteTable;
  readonly #providers: Partial<Record<ProviderId, LlmProvider>>;
  readonly #fallback: boolean;

  constructor(
    routes: RouteTable,
    providers: Partial<Record<ProviderId, LlmProvider>>,
    { fallback = true }: RouterOptions = {},
  ) {
    this.#routes = routes;
    this.#providers = providers;
    this.#fallback = fallback;
  }

  async *stream(
    choice: RouteChoice,
    request: RoutedRequest,
    options: StreamOptions = {},
  ): AsyncIterable<RouterEvent> {
    // RPC callers aren't type-checked, so the choice and the request fields are taken explicitly.
    const { tier } = choice;
    const candidates = this.route(tier, choice.provider);
    for (const [index, candidate] of candidates.entries()) {
      const provider = this.#providers[candidate.provider] as LlmProvider;
      const effort = lowerEffort(candidate.model, choice.effort ?? candidate.effort);
      const routed: LlmRequest = {
        model: candidate.model,
        system: request.system,
        messages: request.messages,
        ...(request.tools ? { tools: request.tools } : {}),
        maxOutputTokens: request.maxOutputTokens,
        ...(effort ? { effort } : {}),
        ...(typeof request.context === "string" ? { context: request.context } : {}),
      };
      let started = false;
      try {
        for await (const event of provider.stream(routed, options)) {
          started = true;
          yield event;
        }
        return;
      } catch (error) {
        if (!(error instanceof LlmError)) throw error;
        error.route ??= { provider: candidate.provider, model: candidate.model };
        const next = candidates[index + 1];
        if (started || !error.retryable || !this.#fallback || !next) throw error;
        yield {
          type: "fallback",
          failed: { provider: candidate.provider, model: candidate.model, code: error.code },
          next: { provider: next.provider, model: next.model },
        };
      }
    }
    // Every candidate that ran either answered or threw: only an empty route gets here.
    throw new LlmError(`No provider is configured for the ${tier} tier`, "unavailable", false);
  }

  /**
   * The tier's candidates `stream` would try, in order: those whose provider is configured, the
   * chosen provider's first.
   */
  route(tier: ModelTier, provider?: ProviderId | null): RouteCandidate[] {
    checkTier(tier);
    const configured = this.#routes[tier].filter(
      (candidate) => this.#providers[candidate.provider],
    );
    return [
      ...configured.filter((candidate) => candidate.provider === provider),
      ...configured.filter((candidate) => candidate.provider !== provider),
    ];
  }
}

function checkTier(tier: ModelTier): void {
  if (!MODEL_TIERS.includes(tier)) {
    throw new LlmError(`Unknown tier: ${String(tier)}`, "bad_request", false);
  }
}

export const PROVIDERS: readonly string[] = ["anthropic", "openai"] satisfies ProviderId[];

/** Checks a route table read from configuration. */
export function parseRouteTable(value: unknown): RouteTable {
  const routes = {} as RouteTable;
  for (const tier of MODEL_TIERS) {
    const candidates =
      typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)[tier]
        : undefined;
    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw new Error(`Route table: "${tier}" needs at least one candidate`);
    }
    routes[tier] = candidates.map((entry: unknown) => {
      if (typeof entry !== "object" || entry === null) {
        throw new Error(`Route table: a "${tier}" candidate isn't an object`);
      }
      const { provider, model, effort } = entry as Partial<Record<keyof RouteCandidate, unknown>>;
      if (typeof provider !== "string" || !PROVIDERS.includes(provider)) {
        throw new Error(`Route table: unknown provider ${JSON.stringify(provider)} in "${tier}"`);
      }
      if (typeof model !== "string" || model === "") {
        throw new Error(`Route table: a "${tier}" candidate has no model`);
      }
      if (effort !== undefined && (typeof effort !== "string" || !EFFORTS.includes(effort))) {
        throw new Error(`Route table: unknown effort ${JSON.stringify(effort)} in "${tier}"`);
      }
      return {
        provider: provider as RouteCandidate["provider"],
        model,
        ...(effort ? { effort: effort as Effort } : {}),
      };
    });
  }
  return routes;
}
