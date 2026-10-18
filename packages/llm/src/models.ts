// The model "trio" an agent's calls use (ADR-0036 §2): a provider, a tier and an effort, set for
// the instance and per agent, in two areas. A module of its own, without the provider SDKs, so the
// other Workers and packages can import it.
import { EFFORTS } from "./efforts.ts";
import { MODEL_TIERS, type ModelTier, PROVIDERS, type RouteModel } from "./router.ts";
import type { Effort, ProviderId } from "./types.ts";

export type { Effort, ProviderId };
export { EFFORTS };

export const MODEL_AREAS = ["conversation", "memory"] as const;
/** `conversation`: the agent's turns. `memory`: the history checkpoint, Dream and conflict resolve. */
export type ModelArea = (typeof MODEL_AREAS)[number];

export interface AreaChoice {
  provider?: ProviderId;
  tier?: ModelTier;
  effort?: Effort;
}

/**
 * One scope's choices: the instance's, or an agent's. Only the provider has a scope-wide level;
 * tier and effort are set per area, so a costlier conversation never makes memory costlier.
 */
export interface ModelSettings {
  provider?: ProviderId;
  conversation?: AreaChoice;
  memory?: AreaChoice;
}

/** What a call runs with. `provider` is null while no provider has a key; an unset effort is the model's own. */
export interface ResolvedModel {
  provider: ProviderId | null;
  tier: ModelTier;
  effort?: Effort;
}

/**
 * The model a call asks for: a tier, as callers before #286 send it, or an area with the agent's
 * model settings and, for a step with its own default, the tier to use until the area sets one
 * (ADR-0036 §2).
 */
export type ModelSelection =
  | ModelTier
  | { area: ModelArea; agent?: ModelSettings; tier?: ModelTier };

/** A resolved trio and the models it would use, in order: what an agent is told it runs on. */
export interface ModelDescription extends ResolvedModel {
  route: RouteModel[];
}

/**
 * Each field from the first scope that sets it: the agent's area, the agent, the instance's area,
 * the instance, then the built-in: the pinned provider, `tier` (the caller's, `cheap` unless it
 * names another) and the model's own effort.
 */
export function resolveModel(input: {
  area: ModelArea;
  agent?: ModelSettings;
  instance?: ModelSettings;
  pinned: ProviderId | null;
  tier?: ModelTier;
}): ResolvedModel {
  const { area, agent, instance } = input;
  const provider =
    agent?.[area]?.provider ??
    agent?.provider ??
    instance?.[area]?.provider ??
    instance?.provider ??
    input.pinned;
  const tier = agent?.[area]?.tier ?? instance?.[area]?.tier ?? input.tier ?? "cheap";
  const effort = agent?.[area]?.effort ?? instance?.[area]?.effort;
  return { provider, tier, ...(effort ? { effort } : {}) };
}

/**
 * Whether the settings give the `memory` area the `claude-code` route (#295). That route serves only
 * a conversation's turns, which carry the session it keeps, and memory's calls carry none, so the
 * commands that set models refuse it there.
 */
export function memoryOnSessionRoute(settings: ModelSettings): boolean {
  return settings.memory?.provider === "claude-code";
}

/** Accepts only known keys with known values; anything else invalidates the whole value. */
export function parseModelSettings(value: unknown): ModelSettings | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const parsed: ModelSettings = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "provider") {
      if (!PROVIDERS.includes(entry as string)) return null;
      parsed.provider = entry as ProviderId;
    } else if ((MODEL_AREAS as readonly string[]).includes(key)) {
      const choice = parseAreaChoice(entry);
      if (!choice) return null;
      parsed[key as ModelArea] = choice;
    } else {
      return null;
    }
  }
  return parsed;
}

function parseAreaChoice(value: unknown): AreaChoice | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const choice: AreaChoice = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "provider" && PROVIDERS.includes(entry as string)) {
      choice.provider = entry as ProviderId;
    } else if (key === "tier" && MODEL_TIERS.includes(entry as ModelTier)) {
      choice.tier = entry as ModelTier;
    } else if (key === "effort" && EFFORTS.includes(entry as string)) {
      choice.effort = entry as Effort;
    } else {
      return null;
    }
  }
  return choice;
}
