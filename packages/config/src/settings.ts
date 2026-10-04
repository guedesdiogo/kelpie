import { MODEL_TIERS, type ModelTier } from "@kelpie/llm";
import type { QuietWindowPolicy } from "@kelpie/qualifier";

/** Kelpie runs one `Registry`, which lists the agents. */
export const REGISTRY_NAME = "registry";

/** One agent's settings, held by its `AgentHost` (ADR-0002) and read by its conversations. */
export interface AgentSettings {
  /** Merge fragments and split replies into paced bubbles; off answers each message at once. */
  conversational: boolean;
  tier: ModelTier;
  /** Changing it starts a new prompt version: earlier replies replay without native output. */
  systemPrompt: string;
  maxOutputTokens: number;
  quietWindow: QuietWindowPolicy;
  maxWaitMs: number;
}

export const DEFAULT_SETTINGS: AgentSettings = {
  conversational: true,
  tier: "cheap",
  systemPrompt: "You are a helpful assistant. Reply in the language the user writes in.",
  maxOutputTokens: 1_024,
  quietWindow: { finishedMs: 1_500, defaultMs: 3_000, unfinishedMs: 6_000 },
  maxWaitMs: 10_000,
};

/** Agent ids become object names and URL segments: lowercase letters, digits and hyphens. */
export function isAgentId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{1,39}$/.test(value);
}

/** Agent names appear in lists and in models' context: one line of printable text. */
export function isAgentName(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim() !== "" && value.length <= 80 && !/\p{C}/u.test(value)
  );
}

const isInteger = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

/** Accepts only known settings with sane values; anything else invalidates the whole change. */
export function parseSettings(input: unknown): Partial<AgentSettings> | null {
  if (typeof input !== "object" || input === null) return null;
  const parsed: Partial<AgentSettings> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    switch (key) {
      case "conversational":
        if (typeof value !== "boolean") return null;
        parsed.conversational = value;
        break;
      case "tier":
        if (!MODEL_TIERS.includes(value as ModelTier)) return null;
        parsed.tier = value as ModelTier;
        break;
      case "systemPrompt":
        if (typeof value !== "string" || value.trim() === "" || value.length > 20_000) return null;
        parsed.systemPrompt = value;
        break;
      case "maxOutputTokens":
        if (!isInteger(value, 1, 64_000)) return null;
        parsed.maxOutputTokens = value;
        break;
      case "maxWaitMs":
        if (!isInteger(value, 0, 120_000)) return null;
        parsed.maxWaitMs = value;
        break;
      case "quietWindow": {
        const window = value as Partial<QuietWindowPolicy> | null;
        if (
          !window ||
          !isInteger(window.finishedMs, 0, 60_000) ||
          !isInteger(window.defaultMs, 0, 60_000) ||
          !isInteger(window.unfinishedMs, 0, 60_000)
        ) {
          return null;
        }
        parsed.quietWindow = {
          finishedMs: window.finishedMs,
          defaultMs: window.defaultMs,
          unfinishedMs: window.unfinishedMs,
        };
        break;
      }
      default:
        return null;
    }
  }
  return parsed;
}
