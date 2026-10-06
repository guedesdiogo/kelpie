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
