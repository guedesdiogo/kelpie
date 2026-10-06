// Memory's lifecycle (#111): what a daily look at the index finds, written as one report page.
// The retention score follows ai-memory's decay (crates/ai-memory-store/src/decay.rs at
// akitaonrails/ai-memory `b8e839f`, MIT, © 2026 Fabio Akita): it decides what to report, never how
// notes rank.
import type { MemoryIndex } from "./memory-index.ts";

/** Where the report lives: a `memory/_` folder, which memory never indexes (`placeOf`). */
export const LIFECYCLE_REPORT_PATH = "memory/_lint/report.md";

/** ai-memory's defaults: a 35-day half-life for age, recalls that wear off over about 25 days. */
const AGE_DECAY = 0.02;
const RECALL_WEIGHT = 0.6;
const RECALL_DECAY = 0.04;
/** Below this retention, a session or an event is cold. */
const COLD_BELOW = 0.2;
const DAY = 86_400_000;
/** The contradiction band reads this many notes at most: the latest semantic and procedural ones. */
const BAND_NOTES = 60;
/** And reports this many pairs at most. */
const BAND_PAIRS = 25;
/** Each list in the report shows this many entries at most. */
const REPORT_ENTRIES = 200;

/**
 * The cosine band in which two notes about one entity may contradict each other, per embedding
 * model: close, but not the same note. A model without a band has the check off.
 *
 * Measured on #108's vault (`eval:models`, #111): pairs that disagree (a question's answer against
 * the memories that would answer it wrongly, and each fact's consecutive versions, 16 pairs)
 * against other pairs of notes sharing an entity (54). Unlike ai-memory's [0.4, 0.75), these
 * updates sit high: [0.70, 0.95) caught 56% of them with bge-m3, flagging 6% of the other pairs,
 * and 63% with OpenAI's model, flagging 13%. Above 0.95 a pair is close to a duplicate.
 */
export const CONTRADICTION_BANDS: Readonly<Record<string, readonly [number, number]>> = {
  "@cf/baai/bge-m3": [0.7, 0.95],
  "text-embedding-3-small": [0.7, 0.95],
};

export interface NoteRef {
  path: string;
  title: string;
}

export interface LifecycleFindings {
  /** Sessions and events nobody recalls any more, with when they were written and how often read. */
  cold: (NoteRef & { writtenAt: number; recalled: number })[];
  /** The same content at several paths, or the same title on several notes. */
  duplicates: { kind: "content" | "title"; notes: NoteRef[] }[];
  /** Pairs of notes about one entity, close enough to be about the same thing, not the same. */
  contradictions: { notes: [NoteRef, NoteRef]; entity: string }[];
}

export interface LifecycleOptions {
  now: number;
  /** How often each path was packed for a turn, and when last (the Context Store's `recall_counts`). */
  uses: ReadonlyMap<string, { count: number; lastAt: number }>;
  /** The embedding model whose vectors the index holds. */
  model?: string;
  bands?: Readonly<Record<string, readonly [number, number]>>;
}

/** What a daily look at the index finds. It reads only; nothing changes. */
export function lifecycleFindings(
  index: MemoryIndex,
  options: LifecycleOptions,
): LifecycleFindings {
  const notes = index.lifecycleNotes();
  const byPath = (a: NoteRef, b: NoteRef) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

  const cold = notes
    .filter((note) => note.tier === "episodic" && !note.pinned && !note.evergreen)
    .flatMap((note) => {
      const use = options.uses.get(note.path);
      // An event ages from its own date, so one that is still ahead isn't cold.
      const from =
        note.kind === "event"
          ? (note.invalidAt ?? note.validFrom ?? note.recordedAt)
          : note.recordedAt;
      const age = Math.max(0, (options.now - from) / DAY);
      const sinceRead = use ? Math.max(0, (options.now - use.lastAt) / DAY) : 0;
      const retention =
        Math.exp(-AGE_DECAY * age) +
        (use ? RECALL_WEIGHT * Math.log(1 + use.count) * Math.exp(-RECALL_DECAY * sinceRead) : 0);
      return retention < COLD_BELOW
        ? [
            {
              path: note.path,
              title: note.title,
              writtenAt: note.recordedAt,
              recalled: use?.count ?? 0,
            },
          ]
        : [];
    })
    .sort(byPath);

  const groups = (key: (note: (typeof notes)[number]) => string) => {
    const by = new Map<string, NoteRef[]>();
    for (const note of notes) {
      const list = by.get(key(note)) ?? [];
      list.push({ path: note.path, title: note.title });
      by.set(key(note), list);
    }
    return [...by.values()].filter((list) => list.length > 1).map((list) => list.sort(byPath));
  };
  const sameContent = groups((note) => note.blobSha);
  const listed = new Set(sameContent.map((list) => list.map((note) => note.path).join("\n")));
  const sameTitle = groups((note) => note.titleKey).filter(
    (list) => !listed.has(list.map((note) => note.path).join("\n")),
  );
  const firstPath = (a: { notes: NoteRef[] }, b: { notes: NoteRef[] }) =>
    byPath(a.notes[0] as NoteRef, b.notes[0] as NoteRef);
  const duplicates = [
    ...sameContent.map((list) => ({ kind: "content" as const, notes: list })),
    ...sameTitle.map((list) => ({ kind: "title" as const, notes: list })),
  ].sort((a, b) => (a.kind === b.kind ? firstPath(a, b) : a.kind === "content" ? -1 : 1));

  return { cold, duplicates, contradictions: contradictions(index, notes, options) };
}

function contradictions(
  index: MemoryIndex,
  notes: ReturnType<MemoryIndex["lifecycleNotes"]>,
  options: LifecycleOptions,
): LifecycleFindings["contradictions"] {
  const band =
    options.model === undefined ? undefined : (options.bands ?? CONTRADICTION_BANDS)[options.model];
  if (options.model === undefined || band === undefined) return [];
  const [low, high] = band;
  const candidates = notes
    .filter((note) => note.tier !== "episodic")
    .sort((a, b) => b.recordedAt - a.recordedAt || (a.path < b.path ? -1 : 1))
    .slice(0, BAND_NOTES)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const vectors = index.vectorsOf(
    options.model,
    candidates.map((note) => note.blobSha),
  );
  const entities = index.entitiesOf(candidates.map((note) => note.path));
  const found: LifecycleFindings["contradictions"] = [];
  for (let i = 0; i < candidates.length && found.length < BAND_PAIRS; i += 1) {
    const a = candidates[i] as (typeof candidates)[number];
    const va = vectors.get(a.blobSha);
    const ea = entities.get(a.path);
    if (va === undefined || ea === undefined) continue;
    for (let j = i + 1; j < candidates.length && found.length < BAND_PAIRS; j += 1) {
      const b = candidates[j] as (typeof candidates)[number];
      const vb = vectors.get(b.blobSha);
      const shared = [...ea].find(([key]) => entities.get(b.path)?.has(key));
      if (vb === undefined || shared === undefined || a.blobSha === b.blobSha) continue;
      const similarity = cosine(va, vb);
      if (similarity >= low && similarity < high) {
        found.push({
          notes: [
            { path: a.path, title: a.title },
            { path: b.path, title: b.title },
          ],
          entity: shared[1],
        });
      }
    }
  }
  return found;
}

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return Number.NaN;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  return aa > 0 && bb > 0 ? dot / Math.sqrt(aa * bb) : Number.NaN;
}

/** A wikilink to a note, from the vault's root, with a title that can't break it. */
function link(note: NoteRef): string {
  const title = note.title
    .replace(/[[\]|\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `[[${note.path.replace(/\.md$/, "")}|${title || note.path}]]`;
}

function capped(lines: string[]): string[] {
  return lines.length <= REPORT_ENTRIES
    ? lines
    : [...lines.slice(0, REPORT_ENTRIES), `- …and ${lines.length - REPORT_ENTRIES} more.`];
}

const day = (at: number) => new Date(at).toISOString().slice(0, 10);

/**
 * The findings as one Markdown page, or null when there is nothing to report. The same findings
 * give the same page, so a day without news changes nothing in the vault.
 */
export function lifecycleReport(findings: LifecycleFindings): string | null {
  const sections: string[] = [];
  if (findings.cold.length > 0) {
    sections.push(
      [
        "## Cold notes",
        "",
        "Sessions and events nobody has recalled in a while. They stay where they are; Dream, or you, may fold them away.",
        "",
        ...capped(
          findings.cold.map(
            (note) =>
              `- ${link(note)}: written ${day(note.writtenAt)}, recalled ${note.recalled === 1 ? "once" : `${note.recalled} times`}`,
          ),
        ),
      ].join("\n"),
    );
  }
  if (findings.duplicates.length > 0) {
    sections.push(
      [
        "## Duplicates",
        "",
        ...capped(
          findings.duplicates.map(
            (group) =>
              `- ${group.kind === "content" ? "The same content" : "The same title"}: ${group.notes.map(link).join(", ")}`,
          ),
        ),
      ].join("\n"),
    );
  }
  if (findings.contradictions.length > 0) {
    sections.push(
      [
        "## Possible contradictions",
        "",
        "Notes about the same entity that say similar but not the same things. Dream looks at them.",
        "",
        ...capped(
          findings.contradictions.map(
            (pair) =>
              `- ${link(pair.notes[0])} and ${link(pair.notes[1])}, both about ${pair.entity}`,
          ),
        ),
      ].join("\n"),
    );
  }
  if (sections.length === 0) return null;
  return `# Memory report\n\nKelpie writes this page every day from memory's index; nothing listed here was changed. It goes away when every list is empty.\n\n${sections.join("\n\n")}\n`;
}
