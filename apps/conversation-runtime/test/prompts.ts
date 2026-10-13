import type { ModelTier, RouteModel } from "@kelpie/llm/router";
import { identitySection } from "../src/agent-host/identity.ts";

/**
 * A system prompt as a turn gets it: the agent's identity section (#283), with the route the test
 * llm-gateway in `vitest.config.ts` describes, then `prompt`. The name is the id until the
 * Registry lists the agent.
 */
export function withIdentity(
  id: string,
  prompt: string,
  { name = id, tier = "cheap" }: { name?: string; tier?: ModelTier } = {},
): string {
  const route: RouteModel[] = [{ provider: "anthropic", model: `claude-test-${tier}` }];
  return `${identitySection({ id, name, tier, route })}\n\n${prompt}`;
}
