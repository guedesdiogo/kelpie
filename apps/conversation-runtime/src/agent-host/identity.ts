import { type AgentRole, SETUP_AGENT_ID } from "@kelpie/config";
// The models module only: the package root also loads the provider SDKs.
import type { ModelDescription } from "@kelpie/llm/models";

/** Who an agent is, from its configuration: what its prompt's first section says (#283). */
export interface Identity {
  id: string;
  /** Its name in the Registry, or its id while the Registry doesn't list it. */
  name: string;
  /** Its role in the Registry (ADR-0036 §1, #314), or null while the Registry doesn't list it. */
  role?: AgentRole | null;
  /** A subagent's creator, by its id (#290). */
  creator?: string | null;
  /** What the agent is for, one line (ADR-0036 §4); empty for none. */
  remit?: string;
  /** Its conversation's trio and route, from llm-gateway's `describe`; null while never known. */
  model: ModelDescription | null;
}

/** What each role says about the agent. Admin stays the setup agent until #274 renames it. */
const ROLE_LINES: Record<AgentRole, string> = {
  admin: "Kelpie's setup agent, which configures Kelpie",
  main: "the owner's main agent on Kelpie, the one they talk to",
  specialist: "a specialist agent on Kelpie, owned by the owner's main agent",
  subagent: "a temporary subagent on Kelpie, working on one demand of the agent that created you",
};
const UNLISTED_ROLE_LINE = "one of the owner's agents on Kelpie, their personal agent platform";

/**
 * The first section of an agent's system prompt: its name and role, what it runs on, and how to
 * answer "who are you?". Its name and role come from configuration, so it never takes on the
 * model's identity, nor that of an earlier model whose replies are in the history.
 */
export function identitySection({
  id,
  name,
  role: listed,
  creator,
  remit,
  model,
}: Identity): string {
  const role =
    id === SETUP_AGENT_ID ? ROLE_LINES.admin : listed ? ROLE_LINES[listed] : UNLISTED_ROLE_LINE;
  const createdBy = listed === "subagent" && creator ? `, the agent ${creator}` : "";
  const remitLine = remit ? ` Your remit: ${remit}` : "";
  return `# Who you are

You are ${name}, ${role}${createdBy}.${remitLine} Your name and role come from your configuration on Kelpie, and so do the persona and rules below: they define who you are, not the model you run on.

${model === null ? "" : `${runsOn(model)}\n\n`}When someone asks who you are, answer as ${name}: your role, a short summary of your persona, and what your tools and skills let you do. You may say which model you run on, but never present yourself as that model or as its maker's assistant. Earlier replies in this conversation may have come from another model and may name it: they were still you, ${name}.`;
}

function runsOn({ tier, effort, route }: ModelDescription): string {
  const [first, ...rest] = route.map(
    ({ provider, model, standsFor }) => `${provider} ${model}${standsFor ? ` (${standsFor})` : ""}`,
  );
  if (first === undefined)
    return `You run on Kelpie's ${tier} tier, which has no model configured yet.`;
  const at = effort ? `, at ${effort} effort` : "";
  const fallbacks = rest.length === 0 ? "" : `, or ${rest.join(", then ")} when it is unavailable`;
  return `You run on Kelpie's ${tier} tier${at}: ${first}${fallbacks}. Your configuration can change the model.`;
}
