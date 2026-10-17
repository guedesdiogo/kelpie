// The owner's edits of one agent's own files (ADR-0058): which paths they reach, what each file
// must hold, and how a Save's commit is worded. The Vault object does the reading and the writing.
import { diffComm } from "node-diff3";
import { hasConflictMarkers } from "./conflicts.ts";
import type { AgentFileChange, AgentFileKind, SkillOrigin, StagedSkill } from "./contract.ts";
import { agentRulesPath, personaPath } from "./paths.ts";
import { isSpecSkillName } from "./skills.ts";

/** Hermes's limit for an agent's `MEMORY.md`, in characters as Python counts them. */
export const MEMORY_LIMIT = 2_200;
/** Hermes joins entries with exactly this. */
export const MEMORY_SEPARATOR = "\n§\n";
/** A staged skill waits this long for the owner's Save. */
export const STAGED_FOR_MS = 60 * 60_000;
/** One Save, at most: Soul, Rules and Memory, and this many skills besides. */
export const MAX_SAVE_CHANGES = 24;
/** A SKILL.md difference past this many lines on either side isn't drawn. */
const MAX_DIFF_LINES = 3_000;

export const memoryPath = (agentId: string) => `agents/${agentId}/memories/MEMORY.md`;
export const skillFolder = (agentId: string, name: string) => `agents/${agentId}/skills/${name}/`;

export function fileKindPath(agentId: string, kind: AgentFileKind): string {
  if (kind === "soul") return personaPath(agentId);
  if (kind === "rules") return agentRulesPath(agentId);
  return memoryPath(agentId);
}

/** Characters as Hermes counts them: code points, as Python's `len`. */
export const characters = (text: string) => [...text].length;

/**
 * Why a `MEMORY.md` isn't in Hermes's format, or null: entries joined by exactly `\n§\n`, each one
 * showing something and none holding a `§` line of its own, no blank line around a `§`, no
 * frontmatter, and within 2,200 characters. Hermes's drift guard refuses any other.
 */
export function memoryProblem(content: string): "memory_format" | "memory_too_long" | null {
  if (content === "") return null;
  if (characters(content) > MEMORY_LIMIT) return "memory_too_long";
  if (/^\u{FEFF}?---\r?\n/u.test(content) || content.includes("\r")) return "memory_format";
  for (const entry of content.split(MEMORY_SEPARATOR)) {
    if (entry.trim() === "" || entry.startsWith("\n") || entry.endsWith("\n")) {
      return "memory_format";
    }
    if (entry.split("\n").some((line) => line.trim() === "§")) return "memory_format";
  }
  return null;
}

/** What a file the editor writes can't hold, whatever it is: conflict markers, which hold it. */
export const heldOnSync = (content: string) => hasConflictMarkers(content);

/** The commit's headline: whose files, and which. */
export function saveHeadline(
  agentId: string,
  changed: { files: AgentFileKind[]; skills: number },
): string {
  const names = { soul: "soul", rules: "rules", memory: "memory" } as const;
  const parts: string[] = changed.files.map((kind) => names[kind]);
  if (changed.skills > 0) parts.push(changed.skills === 1 ? "a skill" : `${changed.skills} skills`);
  const list =
    parts.length <= 1
      ? (parts[0] ?? "files")
      : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return `Edit ${agentId}'s ${list} from the webchat`;
}

/** Where an installed skill came from, as one line of its commit's trailer. */
export function originLine(origin: SkillOrigin): string {
  switch (origin.kind) {
    case "github": {
      const path = origin.path === "" ? "" : `/${origin.path}`;
      return `github.com/${origin.owner}/${origin.repo}/tree/${origin.commit}${path}`;
    }
    case "archive":
      return `archive ${origin.filename.replace(/[\r\n]/g, " ")}`;
    case "text":
      return "pasted text";
    default:
      return "created in the webchat";
  }
}

/** The trailers of an installed skill: its name, source, commit and content's hash. */
export function skillTrailers(name: string, origin: SkillOrigin, hash: string): string[] {
  return [
    `Kelpie-Skill: ${name}`,
    `Kelpie-Skill-Source: ${originLine(origin)}`,
    ...(origin.kind === "github" ? [`Kelpie-Skill-Commit: ${origin.commit}`] : []),
    `Kelpie-Skill-Hash: ${hash}`,
  ];
}

/** A SKILL.md's lines as a difference, for the update's review; empty past its limit. */
export function lineDiff(
  before: string,
  after: string,
): NonNullable<StagedSkill["replaces"]>["diff"] {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return [];
  const out: NonNullable<StagedSkill["replaces"]>["diff"] = [];
  for (const part of diffComm(a, b)) {
    if (part.common) for (const text of part.common) out.push({ op: "=", text });
    else {
      for (const text of part.buffer1) out.push({ op: "-", text });
      for (const text of part.buffer2) out.push({ op: "+", text });
    }
  }
  return out;
}

/** An id for a staged skill, unguessable, as a capability the Save names. */
export function stageId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

const VERSION = /^[0-9a-f]{40}$/;
const STAGE = /^[0-9a-f]{32}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;

/**
 * A Save's changes as the page sent them, or null: each a known file once, with a version that is a
 * blob SHA or null. Only the rules and a skill can be removed.
 */
export function parseChanges(value: unknown): AgentFileChange[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SAVE_CHANGES) return null;
  const changes: AgentFileChange[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const { file, content, version, name, staged, hash, ...rest } = item as Record<string, unknown>;
    if (Object.keys(rest).length > 0) return null;
    if (version !== null && !(typeof version === "string" && VERSION.test(version))) return null;
    let key: string;
    if (file === "soul" || file === "rules" || file === "memory") {
      if (name !== undefined || staged !== undefined || hash !== undefined) return null;
      if (typeof content !== "string" && !(content === null && file === "rules")) return null;
      key = file;
      changes.push({ file, content, version });
    } else if (file === "skill") {
      if (!isSpecSkillName(name) || staged !== undefined || hash !== undefined) return null;
      if (typeof content !== "string" && content !== null) return null;
      key = `skill:${name}`;
      changes.push({ file, name, content, version });
    } else if (file === "install") {
      if (typeof staged !== "string" || !STAGE.test(staged)) return null;
      if (typeof hash !== "string" || !HASH.test(hash)) return null;
      if (content !== undefined || name !== undefined) return null;
      key = `install:${staged}`;
      changes.push({ file, staged, hash, version });
    } else {
      return null;
    }
    if (seen.has(key)) return null;
    seen.add(key);
  }
  return changes;
}
