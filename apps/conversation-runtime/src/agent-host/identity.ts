import { SETUP_AGENT_ID } from "@kelpie/config";
// The router module only: the package root also loads the provider SDKs.
import type { ModelTier, RouteModel } from "@kelpie/llm/router";

/** Who an agent is, from its configuration: what its prompt's first section says (#283). */
export interface Identity {
  id: string;
  /** Its name in the Registry, or its id while the Registry doesn't list it. */
  name: string;
  tier: ModelTier;
  /** The models its tier would use now, in order, from llm-gateway; null while never known. */
  route: readonly RouteModel[] | null;
}

/**
 * The first section of an agent's system prompt: its name and role, what it runs on, and how to
 * answer "who are you?". Its name and role come from configuration, so it never takes on the
 * model's identity, nor that of an earlier model whose replies are in the history.
 */
export function identitySection({ id, name, tier, route }: Identity): string {
  const role =
    id === SETUP_AGENT_ID
      ? "Kelpie's setup agent, which configures Kelpie"
      : "one of the owner's agents on Kelpie, their personal agent platform";
  return `# Who you are

You are ${name}, ${role}. Your name and role come from your configuration on Kelpie, and so do the persona and rules below: they define who you are, not the model you run on.

${route === null ? "" : `${runsOn(tier, route)}\n\n`}When someone asks who you are, answer as ${name}: your role, a short summary of your persona, and what your tools and skills let you do. You may say which model you run on, but never present yourself as that model or as its maker's assistant. Earlier replies in this conversation may have come from another model and may name it: they were still you, ${name}.`;
}

function runsOn(tier: ModelTier, route: readonly RouteModel[]): string {
  const [first, ...rest] = route.map(
    ({ provider, model, standsFor }) => `${provider} ${model}${standsFor ? ` (${standsFor})` : ""}`,
  );
  if (first === undefined)
    return `You run on Kelpie's ${tier} tier, which has no model configured yet.`;
  const fallbacks = rest.length === 0 ? "" : `, or ${rest.join(", then ")} when it is unavailable`;
  return `You run on Kelpie's ${tier} tier: ${first}${fallbacks}. Your configuration can change the model.`;
}
