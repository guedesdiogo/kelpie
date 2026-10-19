// What a subagent may hold (ADR-0036 §5, #290), apart from the modules that enforce it, so each
// can import it without importing the others.

/**
 * The only tools a subagent ever gets: reading its creator's memory, and working on its own tasks.
 * Nothing that creates agents or tasks, writes memory or configures Kelpie, whatever it was granted.
 */
export const SUBAGENT_TOOLS: ReadonlySet<string> = new Set([
  "memory_search",
  "memory_read",
  "complete_task",
  "wait_on_task",
  "cancel_task",
  "comment_task",
]);

/** How each of a creator's subagent ids starts: Kelpie picks the rest, never the model. */
export function subagentPrefix(creator: string): string {
  return `${creator.slice(0, 29).replace(/-+$/, "")}-sub-`;
}

/** The longest a subagent's soul and skills are together: they go with every model call it makes. */
export const MAX_BRIEF_CHARS = 24_000;

/** The tiers and efforts a subagent's trio takes, cheapest first. */
export const TIERS = ["cheap", "medium", "frontier"] as const;
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** A subagent's tools, within what its creator may use: its ceiling (ADR-0036 §5). */
export function subagentToolsWithin(creatorTools: string[] | null): string[] {
  return [...SUBAGENT_TOOLS].filter((tool) => creatorTools === null || creatorTools.includes(tool));
}

/**
 * Why a subagent's tools, tier or effort would exceed its creator's (ADR-0036 §5), in words the
 * creator's model can act on; null when they don't. `create_subagent` and a proposal about a live
 * subagent (#302) both check it. A field left undefined isn't checked. The creator's tier and
 * effort are as its trio resolves now; a tier Kelpie doesn't rank leaves only the cheapest.
 */
export function beyondCreator(
  wanted: { tools?: unknown; tier?: unknown; effort?: unknown },
  creator: { tier: string; effort?: string | undefined; tools: string[] | null },
): string | null {
  const allowed = subagentToolsWithin(creator.tools);
  // Without complete_task, a subagent could never finish a task (#344).
  if (!allowed.includes("complete_task")) {
    return "You may not use complete_task, so a subagent of yours could never finish a task: ask the owner to allow it through Master.";
  }
  const { tools, tier, effort } = wanted;
  if (tools !== undefined) {
    if (!Array.isArray(tools) || tools.some((tool) => !allowed.includes(String(tool)))) {
      return `A subagent's tools can only be these: ${allowed.join(", ")}.`;
    }
    if (!tools.includes("complete_task")) {
      return "A subagent's tools must include complete_task, or it can't finish its task.";
    }
  }
  if (tier !== undefined && !TIERS.includes(tier as never)) return "Unknown tier.";
  if (effort !== undefined && !EFFORTS.includes(effort as never)) return "Unknown effort.";
  const ceiling = Math.max(TIERS.indexOf(creator.tier as never), 0);
  if (tier !== undefined && TIERS.indexOf(tier as never) > ceiling) {
    return `Its tier can't be above yours, ${TIERS[ceiling]}.`;
  }
  if (
    effort !== undefined &&
    (creator.effort === undefined ||
      EFFORTS.indexOf(effort as never) > EFFORTS.indexOf(creator.effort as never))
  ) {
    return creator.effort === undefined
      ? "You run with no effort set, so it can't set one."
      : `Its effort can't be above yours, ${creator.effort}.`;
  }
  return null;
}
