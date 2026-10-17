// A skill as the owner installs or writes it (ADR-0058 §4, §5): the Agent Skills specification's
// `SKILL.md`, and the folder around it, checked before any of it reaches the vault.
import { gitBlobSha } from "@kelpie/vault";
import { parseDocument } from "yaml";
import { hasConflictMarkers } from "./conflicts.ts";
import { isCleanPath } from "./paths.ts";
import type { ZipEntry } from "./zip.ts";

/** At most this many files in a skill, each and all of them within these sizes, uncompressed. */
export const MAX_SKILL_FILES = 200;
export const MAX_SKILL_FILE_BYTES = 1_048_576;
export const MAX_SKILL_BYTES = 2_000_000;
export const MAX_DESCRIPTION_CHARS = 1_024;
/** Shown in the review when an archive holds several skills. */
const MAX_NAMES = 20;

/** The specification's name: lowercase letters, digits and single hyphens, neither first nor last. */
export const isSpecSkillName = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);

/**
 * A file of a skill, its path relative to the skill's folder: text, or a binary file's bytes in
 * base64, which the vault keeps as they are (ADR-0058 §5).
 */
export interface SkillFile {
  path: string;
  content: string;
  binary?: true;
}

/** A file the vault won't keep: a hidden one, such as `.DS_Store`. */
export interface LeftOut {
  path: string;
  why: "hidden";
}

export interface ParsedSkill {
  name: string;
  description: string;
  /** `SKILL.md` first, then the rest by path. */
  files: SkillFile[];
  leftOut: LeftOut[];
  bytes: number;
}

/** Why a skill can't be staged; the review says it in the owner's words. */
export type SkillProblem =
  | { reason: "no_skill" }
  | { reason: "many_skills"; names: string[] }
  | { reason: "unsafe_path" | "link" | "nested_skill" | "path_clash" | "not_text"; path: string }
  | { reason: "encrypted" | "too_many_files" }
  | { reason: "too_large"; path?: string }
  | { reason: "invalid_skill"; problem: SkillMdProblem };

/** What a `SKILL.md` gets wrong. */
export type SkillMdProblem =
  | "frontmatter"
  | "name"
  | "name_mismatch"
  | "description"
  | "description_too_long"
  /** A Markdown file pushed with conflict markers would be held on the next sync (#114). */
  | "conflict_markers";

const FRONTMATTER = /^\u{FEFF}?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;
const bytes = new TextEncoder();
// A BOM stays: it is part of the file, and of its hash.
const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * A `SKILL.md`'s name and description, as the specification asks: frontmatter whose `name` is its
 * folder's, when it has one, and a description of 1 to 1,024 characters.
 */
export function checkSkillMd(
  content: string,
  folder: string | null,
): { ok: true; name: string; description: string } | { ok: false; problem: SkillMdProblem } {
  const match = FRONTMATTER.exec(content);
  if (match?.[1] === undefined || match[1].length > 16_384)
    return { ok: false, problem: "frontmatter" };
  let fields: unknown;
  try {
    const doc = parseDocument(match[1], { uniqueKeys: true });
    if (doc.errors.length > 0) return { ok: false, problem: "frontmatter" };
    fields = doc.toJS({ maxAliasCount: 0 });
  } catch {
    return { ok: false, problem: "frontmatter" };
  }
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
    return { ok: false, problem: "frontmatter" };
  }
  const { name, description } = fields as Record<string, unknown>;
  if (!isSpecSkillName(name)) return { ok: false, problem: "name" };
  if (folder !== null && name !== folder) return { ok: false, problem: "name_mismatch" };
  if (typeof description !== "string" || description.trim() === "") {
    return { ok: false, problem: "description" };
  }
  if ([...description].length > MAX_DESCRIPTION_CHARS) {
    return { ok: false, problem: "description_too_long" };
  }
  return { ok: true, name, description: description.replace(/\s+/g, " ").trim() };
}

/** Markdown and scripts, which the agent and the scan read as text. */
const TEXT = /\.(?:md|txt|py|sh|bash|zsh|js|mjs|cjs|ts|rb|pl|php|ps1|bat|cmd|go|rs|lua)$/i;

/** `.DS_Store`, `.git/` or `__MACOSX/`; `.` and `..` are unsafe paths, refused whole. */
const hidden = (segment: string) =>
  (segment.startsWith(".") && segment !== "." && segment !== "..") || segment === "__MACOSX";

/**
 * The one skill under `base` in an archive: the folder whose `SKILL.md` is at `base`, or the only
 * `SKILL.md` below it. `fallbackName` names a skill whose `SKILL.md` sits at `base` itself, as a
 * repository's root does; an archive's root takes its `SKILL.md`'s name.
 */
export async function skillFromEntries(
  entries: readonly ZipEntry[],
  base: string,
  fallbackName: string | null = null,
): Promise<{ ok: true; skill: ParsedSkill } | { ok: false; problem: SkillProblem }> {
  const under = entries
    .filter((entry) => !entry.directory && entry.path.startsWith(base))
    .map((entry) => ({ entry, path: entry.path.slice(base.length) }));
  const skillMds = under
    .map(({ path }) => path)
    .filter((path) => {
      const segments = path.split("/");
      return segments.at(-1) === "SKILL.md" && !segments.some(hidden);
    });
  let folder: string;
  if (skillMds.includes("SKILL.md")) folder = "";
  else if (skillMds.length === 1) folder = (skillMds[0] ?? "").slice(0, -"SKILL.md".length);
  else if (skillMds.length === 0) return { ok: false, problem: { reason: "no_skill" } };
  else {
    const names = skillMds.map((path) => path.split("/").at(-2) ?? path).sort();
    return { ok: false, problem: { reason: "many_skills", names: names.slice(0, MAX_NAMES) } };
  }
  const leftOut: LeftOut[] = [];
  const kept: { entry: ZipEntry; path: string }[] = [];
  // Two paths a Mac's or Windows' checkout would take as one, by case or by Unicode's forms.
  const seen = new Set<string>();
  let declared = 0;
  for (const { entry, path: full } of under) {
    if (!full.startsWith(folder)) continue;
    const path = full.slice(folder.length);
    if (path.split("/").some(hidden)) {
      leftOut.push({ path, why: "hidden" });
      continue;
    }
    // A name with a character that shows nothing, as a Hangul filler, could pass for another.
    if (!isCleanPath(path) || /\p{Default_Ignorable_Code_Point}/u.test(path)) {
      return { ok: false, problem: { reason: "unsafe_path", path } };
    }
    const key = path.normalize("NFKC").toLowerCase();
    if (seen.has(key)) return { ok: false, problem: { reason: "path_clash", path } };
    seen.add(key);
    // The vault would read a second one as a skill of its own, which the owner never reviewed.
    if (path !== "SKILL.md" && path.split("/").at(-1)?.toLowerCase() === "skill.md") {
      return { ok: false, problem: { reason: "nested_skill", path } };
    }
    if (entry.link) return { ok: false, problem: { reason: "link", path } };
    if (entry.encrypted) return { ok: false, problem: { reason: "encrypted" } };
    if (entry.size > MAX_SKILL_FILE_BYTES)
      return { ok: false, problem: { reason: "too_large", path } };
    declared += entry.size;
    kept.push({ entry, path });
  }
  if (kept.length > MAX_SKILL_FILES) return { ok: false, problem: { reason: "too_many_files" } };
  if (declared > MAX_SKILL_BYTES) return { ok: false, problem: { reason: "too_large" } };
  const files: SkillFile[] = [];
  for (const { entry, path } of kept) {
    const raw = await entry.read();
    const content = decoded(raw);
    // Markdown or a script that isn't text would slip past the scan, and the review.
    if (content === null && TEXT.test(path)) {
      return { ok: false, problem: { reason: "not_text", path } };
    }
    files.push(
      content === null ? { path, content: toBase64(raw), binary: true } : { path, content },
    );
  }
  const folderName = folder === "" ? fallbackName : (folder.split("/").at(-2) ?? null);
  return finish(files, leftOut, folderName);
}

/** A skill pasted as text: its `SKILL.md` alone, in the folder its name gives it. */
export function skillFromText(
  content: string,
): { ok: true; skill: ParsedSkill } | { ok: false; problem: SkillProblem } {
  if (bytes.encode(content).byteLength > MAX_SKILL_FILE_BYTES) {
    return { ok: false, problem: { reason: "too_large", path: "SKILL.md" } };
  }
  return finish([{ path: "SKILL.md", content }], [], null);
}

function finish(
  files: SkillFile[],
  leftOut: LeftOut[],
  folder: string | null,
): { ok: true; skill: ParsedSkill } | { ok: false; problem: SkillProblem } {
  const skillMd = files.find((file) => file.path === "SKILL.md" && !file.binary);
  if (!skillMd) return { ok: false, problem: { reason: "no_skill" } };
  const checked = checkSkillMd(skillMd.content, folder);
  if (!checked.ok)
    return { ok: false, problem: { reason: "invalid_skill", problem: checked.problem } };
  if (
    files.some(
      (file) => !file.binary && file.path.endsWith(".md") && hasConflictMarkers(file.content),
    )
  ) {
    return { ok: false, problem: { reason: "invalid_skill", problem: "conflict_markers" } };
  }
  const sorted = [
    skillMd,
    ...files.filter((file) => file !== skillMd).sort((a, b) => (a.path < b.path ? -1 : 1)),
  ];
  return {
    ok: true,
    skill: {
      name: checked.name,
      description: checked.description,
      files: sorted,
      leftOut: leftOut.sort((a, b) => (a.path < b.path ? -1 : 1)),
      bytes: sorted.reduce((sum, file) => sum + fileBytes(file).byteLength, 0),
    },
  };
}

/** A file's bytes: text as UTF-8, a binary file decoded from base64. */
export function fileBytes(file: Pick<SkillFile, "content" | "binary">): Uint8Array {
  return file.binary ? fromBase64(file.content) : bytes.encode(file.content);
}

export function toBase64(raw: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < raw.length; at += 0x8000) {
    binary += String.fromCharCode(...raw.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

/** Text the vault can keep as text: UTF-8, with no NUL. Anything else is binary. */
function decoded(raw: Uint8Array): string | null {
  try {
    const content = text.decode(raw);
    return content.includes("\0") ? null : content;
  } catch {
    return null;
  }
}

/**
 * The skill's content hash: SHA-256 over each file's path and git blob SHA, by path. It names what
 * was installed, whatever the archive's order or timestamps.
 */
export async function skillHash(files: readonly SkillFile[]): Promise<string> {
  const lines = await Promise.all(
    [...files]
      .sort((a, b) => (a.path < b.path ? -1 : 1))
      .map(async (file) => `${file.path}\n${await gitBlobSha(fileBytes(file))}\n`),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes.encode(lines.join("")));
  return `sha256:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Scripts are kept and not run: Kelpie runs no code by default (ADR-0058 §5). */
export function isScript(path: string): boolean {
  return (
    path.startsWith("scripts/") ||
    /\.(?:py|sh|bash|zsh|js|mjs|cjs|ts|rb|pl|php|ps1|bat|cmd|go|rs|lua)$/i.test(path)
  );
}
