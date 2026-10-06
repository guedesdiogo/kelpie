import { isVaultText } from "@kelpie/vault";

/** Agent ids are slugs (`@kelpie/config`'s `isAgentId`); they become folder names here. */
export function isAgentId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{1,39}$/.test(value);
}

/** A skill's folder name: a slug, as Agent Skills names are. */
export function isSkillName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
}

/** Names Windows reserves, which would break the owner's checkout there. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * A relative vault path with no `.`/`..` segments, and nothing that breaks a checkout or spoofs a
 * name: none of `\ : * ? " < > |`, no control or format characters (bidirectional overrides,
 * zero-width spaces), no segment ending in a dot or a space, and no reserved Windows names.
 */
function isCleanPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 300 &&
    !path.startsWith("/") &&
    !/[\\:*?"<>|\p{Cc}\p{Cf}]/u.test(path) &&
    path
      .split("/")
      .every(
        (segment) =>
          segment !== "" &&
          segment !== "." &&
          segment !== ".." &&
          !/[. ]$/.test(segment) &&
          !RESERVED.test(segment),
      )
  );
}

/** Folders any agent may write memory and knowledge into (ADR-0016, ADR-0020). */
const SHARED_ROOTS = ["memory/", "knowledge/", "areas/", "projects/", "conversations/"];

/**
 * Where an agent may write directly: memory and knowledge, and its own memory folder. Persona, rules
 * and skills change only through a proposal; root files and other agents' folders not at all.
 */
export function isWritable(agentId: string, path: string): boolean {
  if (!isCleanPath(path) || !isVaultText(path)) return false;
  return (
    SHARED_ROOTS.some((root) => path.startsWith(root)) ||
    path.startsWith(`agents/${agentId}/memory/`)
  );
}

export const personaPath = (agentId: string) => `agents/${agentId}/SOUL.md`;
export const agentRulesPath = (agentId: string) => `agents/${agentId}/AGENTS.md`;
export const skillPath = (agentId: string, name: string) =>
  `agents/${agentId}/skills/${name}/SKILL.md`;

/** Skills an agent sees: the shared ones (`skills/**`) and its own, found recursively. */
export function isSkillFile(agentId: string, path: string): boolean {
  return (
    path.endsWith("/SKILL.md") &&
    (path.startsWith("skills/") || path.startsWith(`agents/${agentId}/skills/`))
  );
}
