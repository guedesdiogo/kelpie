import { LlmError } from "./errors.ts";
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

/** A request without the model choice, which the router makes. */
export type RoutedRequest = Omit<LlmRequest, "model" | "effort">;

/**
 * Streams a tier's first candidate. When a provider fails with a retryable error before it has sent
 * anything, the next candidate takes over. Once an event has gone out, a failure ends the turn:
 * another model would start the reply again, and reasoning doesn't carry across providers.
 * Candidates whose provider isn't configured are skipped.
 */
export class ModelRouter {
  readonly #routes: RouteTable;
  readonly #providers: Partial<Record<ProviderId, LlmProvider>>;

  constructor(routes: RouteTable, providers: Partial<Record<ProviderId, LlmProvider>>) {
    this.#routes = routes;
    this.#providers = providers;
  }

  async *stream(
    tier: ModelTier,
    request: RoutedRequest,
    options: StreamOptions = {},
  ): AsyncIterable<LlmEvent> {
    let lastError: LlmError | undefined;
    for (const candidate of this.#routes[tier]) {
      const provider = this.#providers[candidate.provider];
      if (!provider) continue;
      const routed: LlmRequest = {
        ...request,
        model: candidate.model,
        ...(candidate.effort ? { effort: candidate.effort } : {}),
      };
      let started = false;
      try {
        for await (const event of provider.stream(routed, options)) {
          started = true;
          yield event;
        }
        return;
      } catch (error) {
        if (started || !(error instanceof LlmError) || !error.retryable) throw error;
        lastError = error;
      }
    }
    throw (
      lastError ??
      new LlmError(`No provider is configured for the ${tier} tier`, "unavailable", false)
    );
  }
}

const PROVIDERS: readonly string[] = ["anthropic", "openai"] satisfies ProviderId[];
const EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"] satisfies Effort[];

/** Checks a route table read from configuration. */
export function parseRouteTable(value: unknown): RouteTable {
  const table = value as Record<string, unknown> | null;
  const routes = {} as RouteTable;
  for (const tier of MODEL_TIERS) {
    const candidates = table?.[tier];
    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw new Error(`Route table: "${tier}" needs at least one candidate`);
    }
    routes[tier] = candidates.map((entry: Partial<Record<keyof RouteCandidate, unknown>>) => {
      const { provider, model, effort } = entry;
      if (typeof provider !== "string" || !PROVIDERS.includes(provider)) {
        throw new Error(`Route table: unknown provider ${JSON.stringify(provider)} in "${tier}"`);
      }
      if (typeof model !== "string" || model === "") {
        throw new Error(`Route table: a "${tier}" candidate has no model`);
      }
      if (effort !== undefined && (typeof effort !== "string" || !EFFORTS.includes(effort))) {
        throw new Error(`Route table: unknown effort ${JSON.stringify(effort)} in "${tier}"`);
      }
      return { ...entry, provider, model } as RouteCandidate;
    });
  }
  return routes;
}
