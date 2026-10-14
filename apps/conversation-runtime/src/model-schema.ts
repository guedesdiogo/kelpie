// The JSON schema of an agent's or the instance's model settings (ADR-0036 §2), for the tools that
// change them (#289). The values are checked again by `parseModelSettings` before anything runs.
import { MODEL_TIERS, PROVIDERS } from "@kelpie/llm/router";

const AREA = {
  type: "object",
  properties: {
    provider: { type: "string", enum: [...PROVIDERS], description: "Overrides the provider." },
    tier: { type: "string", enum: [...MODEL_TIERS], description: "A higher tier costs more." },
    effort: {
      type: "string",
      enum: ["low", "medium", "high", "xhigh", "max"],
      description: "How much the model thinks; more costs more. Unset is the model's own.",
    },
  },
  additionalProperties: false,
} as const;

export const MODEL_SETTINGS_SCHEMA = {
  type: "object",
  description:
    "The provider for every area, and each area's own provider, tier and effort: `conversation` for the turns, `memory` for history summaries and the vault's upkeep. What is left out follows the defaults.",
  properties: {
    provider: { type: "string", enum: [...PROVIDERS] },
    conversation: AREA,
    memory: AREA,
  },
  additionalProperties: false,
} as const;
