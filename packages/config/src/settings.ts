// The router module only: the package root also loads the provider SDKs.
import { MODEL_TIERS, type ModelTier } from "@kelpie/llm/router";
import { QUALIFIER_BACKENDS, type QualifierBackend } from "@kelpie/qualifier";

/** Kelpie runs one `Registry`, which lists the agents. */
export const REGISTRY_NAME = "registry";

/**
 * The built-in setup agent (Story 3.11): every instance has it, and only it gets the configuration
 * tools. No other agent may take its id.
 */
export const SETUP_AGENT_ID = "setup";

/** One agent's settings, held by its `AgentHost` (ADR-0002) and read by its conversations. */
export interface AgentSettings {
  /** Merge fragments and split replies into paced bubbles; off answers each message at once. */
  conversational: boolean;
  tier: ModelTier;
  /** Changing it starts a new prompt version: earlier replies replay without native output. */
  systemPrompt: string;
  maxOutputTokens: number;
  /** How long to wait after the user's latest message before answering (ADR-0024). */
  quietMs: number;
  /** The longest a message waits for an answer, counted from the first one buffered. */
  maxWaitMs: number;
  /** The qualifier the agent's typed decisions use, such as the memory rerank: Clef or Jev. */
  qualifier: QualifierBackend;
  /**
   * How long a turn may spend calling the model and running tools before it must answer (#141).
   * 120 s is the floor the owner set; it can only go up.
   */
  toolLoopMs: number;
}

export const DEFAULT_SETTINGS: AgentSettings = {
  conversational: true,
  tier: "cheap",
  systemPrompt: "You are a helpful assistant. Reply in the language the user writes in.",
  maxOutputTokens: 1_024,
  quietMs: 10_000,
  maxWaitMs: 60_000,
  qualifier: "clef",
  toolLoopMs: 120_000,
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
      case "qualifier":
        if (!QUALIFIER_BACKENDS.includes(value as QualifierBackend)) return null;
        parsed.qualifier = value as QualifierBackend;
        break;
      case "quietMs":
        if (!isInteger(value, 0, 120_000)) return null;
        parsed.quietMs = value;
        break;
      case "toolLoopMs":
        if (!isInteger(value, 120_000, 600_000)) return null;
        parsed.toolLoopMs = value;
        break;
      default:
        return null;
    }
  }
  return parsed;
}
