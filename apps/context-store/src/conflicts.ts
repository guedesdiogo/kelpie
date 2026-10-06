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

/** A file's lines, whatever its line endings. */
const linesOf = (text: string) => text.split(/\r?\n/);

/**
 * Which lines sit inside a fenced code block that closes. A fence left open protects nothing: its
 * lines are text, so a conflict after it is still found.
 */
function fenced(lines: readonly string[]): boolean[] {
  const inside = new Array<boolean>(lines.length).fill(false);
  let open: { marker: string; at: number } | null = null;
  for (let at = 0; at < lines.length; at += 1) {
    const marker = FENCE.exec(lines[at] as string)?.[1];
    if (marker === undefined) continue;
    if (open === null) {
      open = { marker, at };
    } else if (marker[0] === open.marker[0] && marker.length >= open.marker.length) {
      for (let line = open.at; line <= at; line += 1) inside[line] = true;
      open = null;
    }
  }
  return inside;
}

/**
 * The file's conflict blocks, found line by line in one pass: `<<<<<<<`, an optional `|||||||`,
 * `=======`, then `>>>>>>>`, at line starts. Lines inside a closed fenced code block are text, and
 * a block left unfinished isn't one. Null when the file holds no complete block.
 */
export function conflictsOf(text: string): ConflictedFile | null {
  const lines = linesOf(text);
  const inside = fenced(lines);
  const stable: string[][] = [[]];
  const blocks: ConflictedFile["blocks"] = [];
  let open: { ours: string[]; base: string[]; theirs: string[]; at: number } | null = null;
  let side: "ours" | "base" | "theirs" = "ours";
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at] as string;
    if (open === null) {
      if (!inside[at] && OPEN.test(line)) {
        open = { ours: [], base: [], theirs: [], at };
        side = "ours";
      } else {
        (stable.at(-1) as string[]).push(line);
      }
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
    // Unfinished: its lines are text after all. One at a time, however many there are.
    const tail = stable.at(-1) as string[];
    for (let at = open.at; at < lines.length; at += 1) tail.push(lines[at] as string);
  }
  return blocks.length === 0 ? null : { stable, blocks };
}

/** Whether a file still holds a merge conflict that someone committed unresolved. */
export function hasConflictMarkers(text: string): boolean {
  return conflictsOf(text) !== null;
}

/** Whether a file has a `<<<<<<<` or `>>>>>>>` line outside closed fenced code blocks. */
export function hasStrayMarkers(text: string): boolean {
  const lines = linesOf(text);
  const inside = fenced(lines);
  return lines.some((line, at) => !inside[at] && (OPEN.test(line) || CLOSE.test(line)));
}

/**
 * Whether `resolved` keeps every line outside the conflicts verbatim and in order, and takes each
 * conflict's lines only from its sides or its base. A resolution can choose and combine; it can't
 * add or drop anything else. Every way to split the answer is tried, not only the first.
 */
export function keepsProvenance(conflicted: ConflictedFile, resolved: string): boolean {
  const lines = linesOf(resolved);
  const { stable, blocks } = conflicted;
  const startsAt = (segment: readonly string[], at: number) =>
    at + segment.length <= lines.length && segment.every((line, i) => lines[at + i] === line);
  const first = stable[0] as string[];
  if (!startsAt(first, 0)) return false;
  // Where the answer can stand after the stable text before each block.
  let reachable = new Set<number>([first.length]);
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i] as ConflictedFile["blocks"][number];
    const allowed = new Set([...block.ours, ...block.base, ...block.theirs]);
    const next = stable[i + 1] as string[];
    // From a reachable position, the block's lines run while they are allowed, and the next
    // stable text can start anywhere in that run. `stop[j]` is where a run from `j` ends.
    const stop = new Array<number>(lines.length + 1);
    stop[lines.length] = lines.length;
    for (let at = lines.length - 1; at >= 0; at -= 1) {
      stop[at] = allowed.has(lines[at] as string) ? (stop[at + 1] as number) : at;
    }
    const runs = new Array<number>(lines.length + 2).fill(0);
    for (const start of reachable) {
      runs[start] = (runs[start] as number) + 1;
      const end = (stop[start] as number) + 1;
      runs[end] = (runs[end] as number) - 1;
    }
    const candidate = new Array<boolean>(lines.length + 1);
    let open = 0;
    for (let at = 0; at <= lines.length; at += 1) {
      open += runs[at] as number;
      candidate[at] = open > 0;
    }
    const after = new Set<number>();
    for (let at = 0; at <= lines.length; at += 1) {
      if (candidate[at] && startsAt(next, at)) after.add(at + next.length);
    }
    if (after.size === 0) return false;
    reachable = after;
  }
  return reachable.has(lines.length);
}
