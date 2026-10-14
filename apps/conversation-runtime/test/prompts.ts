import type { AgentRole } from "@kelpie/config";
import type { Effort } from "@kelpie/llm";
import type { ModelTier } from "@kelpie/llm/router";
import { identitySection } from "../src/agent-host/identity.ts";

/**
 * A system prompt as a turn gets it: the agent's identity section (#283), with the trio the test
 * llm-gateway in `vitest.config.ts` describes, then `prompt`. The name is the id, and the role
 * none, until the Registry lists the agent; one it lists as `add` creates it is a specialist.
 */
export function withIdentity(
  id: string,
  prompt: string,
  {
    name = id,
    role = null,
    tier = "cheap",
    effort,
  }: { name?: string; role?: AgentRole | null; tier?: ModelTier; effort?: Effort } = {},
): string {
  const model = {
    provider: "anthropic" as const,
    tier,
    ...(effort ? { effort } : {}),
    route: [{ provider: "anthropic" as const, model: `claude-test-${tier}` }],
  };
  return `${identitySection({ id, name, role, model })}\n\n${prompt}`;
}
