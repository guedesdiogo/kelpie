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
