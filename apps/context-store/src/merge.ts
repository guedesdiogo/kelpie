import { diff3Merge } from "node-diff3";

/**
 * Kelpie's change merged into the owner's edit, line by line from the version both started from
 * (diff3). Kelpie's lines that don't overlap the owner's stay; where they overlap, the owner's side
 * wins (ADR-0020). `overlapped` tells whether any of Kelpie's lines lost.
 */
export function mergeOwnerWins(
  base: string,
  owner: string,
  kelpie: string,
): { content: string; overlapped: boolean } {
  let overlapped = false;
  const lines = diff3Merge(owner.split("\n"), base.split("\n"), kelpie.split("\n")).flatMap(
    (region) => {
      if (region.conflict) {
        overlapped = true;
        return region.conflict.a;
      }
      return region.ok ?? [];
    },
  );
  return { content: lines.join("\n"), overlapped };
}

/**
 * Git's conflict markers as a whole block, at line starts and in order: `<<<<<<<`, `=======`, then
 * `>>>>>>>`. A line of equals signs alone is a Markdown heading's underline.
 */
const CONFLICT_BLOCK = /^<{7}(?: .*)?\r?\n[\s\S]*?^={7}\r?\n[\s\S]*?^>{7}(?: .*)?$/m;

/** Whether a file still holds a merge conflict that someone committed unresolved. */
export function hasConflictMarkers(text: string): boolean {
  return CONFLICT_BLOCK.test(text);
}
