import type { CompiledContext } from "@kelpie/context-store/contract";

/** True when the vault has anything for the agent. */
export function hasVaultContext(vault: CompiledContext | null): vault is CompiledContext {
  return (
    vault !== null && (vault.persona !== null || vault.rules.length > 0 || vault.skills.length > 0)
  );
}

/**
 * The system prompt a turn runs with: the persona from the vault (ADR-0016) or, without one, the
 * agent's configured prompt; then the vault's rules and the skills it lists.
 */
export function composeSystemPrompt(configured: string, vault: CompiledContext | null): string {
  if (!hasVaultContext(vault)) return configured;
  const parts = [vault.persona?.trim() || configured];
  for (const rule of vault.rules) parts.push(`# Rules (${rule.path})\n\n${rule.content.trim()}`);
  if (vault.skills.length > 0) {
    const lines = vault.skills.map((skill) =>
      skill.description ? `- ${skill.name}: ${skill.description}` : `- ${skill.name}`,
    );
    parts.push(`# Skills in your vault\n\n${lines.join("\n")}`);
  }
  return parts.join("\n\n");
}
