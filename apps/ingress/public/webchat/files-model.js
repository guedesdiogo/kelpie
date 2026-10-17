// The agent's own files in its editor (#381), without the DOM: what each section holds, what the
// owner changed, and what one Save sends. The vault keeps Hermes's memory format and the Agent Skills
// specification (ADR-0058 §4); the page checks them first, so the owner hears it before Save.

/** Hermes's limit for MEMORY.md, in characters as Python counts them (code points). */
export const MEMORY_LIMIT = 2_200;
export const MEMORY_SEPARATOR = "\n§\n";
/** Past this share of the limit, the budget turns `--warm`. */
export const MEMORY_NEAR = 0.8;
export const MAX_DESCRIPTION = 1_024;

/** The file sections, in the editor's order. */
export const FILE_SECTIONS = ["soul", "rules", "memory", "skills"];

export const characters = (text) => [...text].length;

/** A MEMORY.md's entries: split on Hermes's separator; an empty file has none. */
export function entriesOf(content) {
  return content ? content.split(MEMORY_SEPARATOR) : [];
}

/**
 * The entries as Hermes keeps them: each trimmed, empty ones left out, joined by `\n§\n`. A blank
 * line around the separator would trip Hermes's drift guard, and a trimmed entry has none.
 */
export function memoryOf(entries) {
  return entries
    .map((entry) => entry.replace(/\r\n?/g, "\n").trim())
    .filter((entry) => entry !== "")
    .join(MEMORY_SEPARATOR);
}

/** An entry Hermes would split: one holding a `§` line of its own. */
export const entryBreaks = (entry) => entry.split(/\r?\n/).some((line) => line.trim() === "§");

/** How full the memory is: the characters used, and whether it is near or over the limit. */
export function memoryBudget(entries) {
  const used = characters(memoryOf(entries));
  return {
    used,
    limit: MEMORY_LIMIT,
    over: Math.max(0, used - MEMORY_LIMIT),
    level: used > MEMORY_LIMIT ? "over" : used >= MEMORY_LIMIT * MEMORY_NEAR ? "near" : "ok",
  };
}

const FRONTMATTER = /^\u{FEFF}?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;

/** The specification's name: lowercase letters, digits and single hyphens. */
export const isSkillName = (value) =>
  typeof value === "string" && value.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);

/**
 * A SKILL.md's name and description, read from the plain lines of its frontmatter, and what is
 * wrong with them, as the vault will check (ADR-0058 §4). The vault reads the YAML in full.
 */
export function skillFields(content) {
  const block = FRONTMATTER.exec(content)?.[1];
  if (block === undefined) return { name: null, description: null, problem: "frontmatter" };
  const field = (key) => {
    const line = new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(block)?.[1]?.trim() ?? null;
    if (line === null) return null;
    const quoted = /^(["'])(.*)\1$/.exec(line);
    return quoted ? quoted[2] : line;
  };
  const name = field("name");
  const description = field("description");
  const problem = !isSkillName(name)
    ? "name"
    : !description
      ? "description"
      : characters(description) > MAX_DESCRIPTION
        ? "description_too_long"
        : null;
  return { name, description, problem };
}

/** A new skill's SKILL.md, with the frontmatter the specification asks for. */
export function newSkill(name, description, title) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${title}\n\n`;
}

/** A name for a new skill that no other skill of the agent has: `nova-skill`, `nova-skill-2`… */
export function freeSkillName(base, taken) {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/**
 * The drafts as the page starts them: nothing changed. `skills` maps a skill's name to its
 * pending change, `{ content }` (null removes it) or `{ install }` (a staged skill).
 */
export function freshDrafts() {
  return { soul: undefined, rules: undefined, memory: undefined, skills: new Map() };
}

/** What a file section shows now: the owner's draft, or what is saved. */
export function shownSoul(files, drafts) {
  return drafts.soul ?? files.soul?.content ?? "";
}
export function shownRules(files, drafts) {
  return drafts.rules !== undefined ? drafts.rules : (files.rules?.content ?? null);
}
export function shownEntries(files, drafts) {
  return drafts.memory ?? entriesOf(files.memory?.content ?? "");
}

/** The file sections that changed, in the editor's order. */
export function changedFileSections(files, drafts) {
  if (!files) return [];
  const changed = [];
  if (drafts.soul !== undefined && drafts.soul !== (files.soul?.content ?? ""))
    changed.push("soul");
  if (drafts.rules !== undefined && drafts.rules !== (files.rules?.content ?? null)) {
    changed.push("rules");
  }
  if (drafts.memory !== undefined && memoryOf(drafts.memory) !== (files.memory?.content ?? "")) {
    changed.push("memory");
  }
  if (skillChanges(files, drafts).length > 0) changed.push("skills");
  return changed;
}

/** The skills' pending changes that differ from what is saved. */
function skillChanges(files, drafts) {
  const saved = new Map(files.skills.map((skill) => [skill.name, skill]));
  return [...drafts.skills].filter(([name, change]) => {
    if (change.install) return true;
    const current = saved.get(name);
    return change.content === null ? current !== undefined : change.content !== current?.content;
  });
}

/**
 * What one Save sends for the file sections in `sections`: each change with the version the
 * draft started from, `bases`' when a conflict moved it (ADR-0058 §3).
 */
export function fileChanges(files, drafts, sections, bases = {}) {
  const changes = [];
  const base = (key, saved) => (Object.hasOwn(bases, key) ? bases[key] : (saved?.version ?? null));
  if (sections.includes("soul")) {
    changes.push({ file: "soul", content: drafts.soul, version: base("soul", files.soul) });
  }
  if (sections.includes("rules")) {
    changes.push({ file: "rules", content: drafts.rules, version: base("rules", files.rules) });
  }
  if (sections.includes("memory")) {
    changes.push({
      file: "memory",
      content: memoryOf(drafts.memory),
      version: base("memory", files.memory),
    });
  }
  if (sections.includes("skills")) {
    const saved = new Map(files.skills.map((skill) => [skill.name, skill]));
    for (const [name, change] of skillChanges(files, drafts)) {
      const version = base(`skill:${name}`, saved.get(name));
      changes.push(
        change.install
          ? { file: "install", staged: change.install.id, hash: change.install.hash, version }
          : { file: "skill", name, content: change.content, version },
      );
    }
  }
  return changes;
}

/** The section a Save's change belongs to. */
export const sectionOf = (change) =>
  change.file === "skill" || change.file === "install" ? "skills" : change.file;

/** Bytes as the review says them: "14 KB". */
export function sizeLabel(bytes, locale) {
  const format = (value, unit) =>
    `${new Intl.NumberFormat(locale, { maximumFractionDigits: value < 10 ? 1 : 0 }).format(value)} ${unit}`;
  if (bytes < 1_000) return format(bytes, "B");
  if (bytes < 1_000_000) return format(bytes / 1_000, "KB");
  return format(bytes / 1_000_000, "MB");
}

/** Where a skill came from, in one line: "exemplo/skills · 3f2a91c", or its kind's name. */
export function originLine(origin, names) {
  if (!origin) return "";
  if (origin.kind === "github")
    return `${origin.owner}/${origin.repo} · ${origin.commit.slice(0, 7)}`;
  return names.origins[origin.kind] ?? "";
}

/** The owner and repository an address names, for the fetch's first phase; null if none. */
export function repositoryOf(address) {
  const match = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)/i.exec(
    address.trim(),
  );
  return match ? `${match[1]}/${match[2].replace(/\.git$/, "")}` : null;
}
