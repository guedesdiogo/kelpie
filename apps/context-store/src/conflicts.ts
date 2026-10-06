/** A file split around git's conflict blocks: the text outside them, and each block's sides. */
export interface ConflictedFile {
  /** One more than `blocks`: the lines before, between and after the blocks. */
  stable: string[][];
  blocks: { ours: string[]; base: string[]; theirs: string[] }[];
}

const OPEN = /^<{7}(?: |$)/;
const BASE = /^\|{7}(?: |$)/;
const SPLIT = /^={7}$/;
const CLOSE = /^>{7}(?: |$)/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * The file's conflict blocks, found line by line in one pass: `<<<<<<<`, an optional `|||||||`,
 * `=======`, then `>>>>>>>`, at line starts. Lines inside a fenced code block are text, and a block
 * left unfinished isn't one. Null when the file holds no complete block.
 */
export function conflictsOf(text: string): ConflictedFile | null {
  const lines = text.split(/\r?\n/);
  const stable: string[][] = [[]];
  const blocks: ConflictedFile["blocks"] = [];
  let fence: string | null = null;
  let open: { ours: string[]; base: string[]; theirs: string[]; at: number } | null = null;
  let side: "ours" | "base" | "theirs" = "ours";
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at] as string;
    if (open === null) {
      const marker = FENCE.exec(line)?.[1];
      if (fence !== null) {
        if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) {
          fence = null;
        }
      } else if (marker !== undefined) {
        fence = marker;
      } else if (OPEN.test(line)) {
        open = { ours: [], base: [], theirs: [], at };
        side = "ours";
        continue;
      }
      (stable.at(-1) as string[]).push(line);
      continue;
    }
    if (side === "ours" && BASE.test(line)) {
      side = "base";
    } else if (side !== "theirs" && SPLIT.test(line)) {
      side = "theirs";
    } else if (side === "theirs" && CLOSE.test(line)) {
      blocks.push({ ours: open.ours, base: open.base, theirs: open.theirs });
      stable.push([]);
      open = null;
    } else {
      open[side].push(line);
    }
  }
  if (open !== null) {
    // Unfinished: its lines are text after all.
    (stable.at(-1) as string[]).push(...lines.slice(open.at));
  }
  return blocks.length === 0 ? null : { stable, blocks };
}

/**
 * Whether `resolved` keeps every line outside the conflicts verbatim and in order, and takes each
 * conflict's lines only from its sides or its base. A resolution can choose and combine; it can't
 * add or drop anything else.
 */
export function keepsProvenance(conflicted: ConflictedFile, resolved: string): boolean {
  const lines = resolved.split(/\r?\n/);
  const { stable, blocks } = conflicted;
  const startsAt = (segment: readonly string[], at: number) =>
    at + segment.length <= lines.length && segment.every((line, i) => lines[at + i] === line);
  const first = stable[0] as string[];
  if (!startsAt(first, 0)) return false;
  let at = first.length;
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i] as ConflictedFile["blocks"][number];
    const allowed = new Set([...block.ours, ...block.base, ...block.theirs]);
    const next = stable[i + 1] as string[];
    const last = i === blocks.length - 1;
    let found = -1;
    for (let j = at; j <= lines.length; j += 1) {
      const fits = last ? j + next.length === lines.length && startsAt(next, j) : startsAt(next, j);
      if (fits) {
        found = j;
        break;
      }
      if (j === lines.length || !allowed.has(lines[j] as string)) break;
    }
    if (found === -1) return false;
    at = found + next.length;
  }
  return at === lines.length;
}

/** Whether a file still holds a merge conflict that someone committed unresolved. */
export function hasConflictMarkers(text: string): boolean {
  return conflictsOf(text) !== null;
}
