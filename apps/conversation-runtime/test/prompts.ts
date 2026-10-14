import type { Effort } from "@kelpie/llm";
import type { ModelTier } from "@kelpie/llm/router";
import { identitySection } from "../src/agent-host/identity.ts";

/**
 * A system prompt as a turn gets it: the agent's identity section (#283), with the trio the test
 * llm-gateway in `vitest.config.ts` describes, then `prompt`. The name is the id until the Registry
 * lists the agent.
 */
export function withIdentity(
  id: string,
  prompt: string,
  { name = id, tier = "cheap", effort }: { name?: string; tier?: ModelTier; effort?: Effort } = {},
): string {
  const model = {
    provider: "anthropic" as const,
    tier,
    ...(effort ? { effort } : {}),
    route: [{ provider: "anthropic" as const, model: `claude-test-${tier}` }],
  };
  return `${identitySection({ id, name, model })}\n\n${prompt}`;
}
