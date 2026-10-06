import { diff3Merge } from "node-diff3";

/** diff3 grows fast with a file's length; past this many lines, the owner's edit wins whole. */
const MAX_MERGE_LINES = 1_000;

/**
 * Kelpie's change merged into the owner's edit, line by line from the version both started from
 * (diff3). Kelpie's lines that don't overlap the owner's stay; where both only added lines at the
 * same place, both stay, the owner's first; where they changed the same lines, the owner's side
 * wins (ADR-0020). `overlapped` tells whether any of Kelpie's lines lost. Line endings follow the
 * owner's file. Null when a file is too long to merge.
 */
export function mergeOwnerWins(
  base: string,
  owner: string,
  kelpie: string,
): { content: string; overlapped: boolean } | null {
  const [o, b, k] = [owner, base, kelpie].map(linesOf) as [string[], string[], string[]];
  if (Math.max(o.length, b.length, k.length) > MAX_MERGE_LINES) return null;
  let overlapped = false;
  const lines = diff3Merge(o, b, k).flatMap((region) => {
    if (region.conflict) {
      if (region.conflict.o.length === 0) return [...region.conflict.a, ...region.conflict.b];
      overlapped = true;
      return region.conflict.a;
    }
    return region.ok ?? [];
  });
  const eol = owner.includes("\r\n") ? "\r\n" : "\n";
  const closed = owner === "" ? kelpie.endsWith("\n") : owner.endsWith("\n");
  const content = lines.join(eol) + (closed && lines.length > 0 ? eol : "");
  return { content, overlapped };
}

/** A file's lines, whatever its line endings, without the empty one a final newline leaves. */
function linesOf(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}
