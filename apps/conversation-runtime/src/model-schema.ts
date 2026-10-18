// The JSON schema of an agent's or the instance's model settings (ADR-0036 §2), for the tools that
// change them (#289). The values are checked again by `parseModelSettings` before anything runs.
import { EFFORTS } from "@kelpie/llm/models";
import { MODEL_TIERS, PROVIDERS } from "@kelpie/llm/router";

/** An area's choices. `providers` are those it may name. */
const area = (providers: readonly string[]) =>
  ({
    type: "object",
    properties: {
      provider: { type: "string", enum: [...providers], description: "Overrides the provider." },
      tier: { type: "string", enum: [...MODEL_TIERS], description: "A higher tier costs more." },
      effort: {
        type: "string",
        enum: [...EFFORTS],
        description: "How much the model thinks; more costs more. Unset is the model's own.",
      },
    },
    additionalProperties: false,
  }) as const;

export const MODEL_SETTINGS_SCHEMA = {
  type: "object",
  description:
    "The provider for every area, and each area's own provider, tier and effort: `conversation` for the turns, `memory` for history summaries and the vault's upkeep. What is left out follows the defaults. claude-code serves only conversations, and only while set_claude_code has it on.",
  properties: {
    provider: { type: "string", enum: [...PROVIDERS] },
    conversation: area(PROVIDERS),
    // Memory's calls carry no session, which the claude-code route needs (#295).
    memory: area(PROVIDERS.filter((provider) => provider !== "claude-code")),
  },
  additionalProperties: false,
} as const;
