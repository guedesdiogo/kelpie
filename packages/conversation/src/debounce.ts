export interface DebouncePolicy {
  /** How long the user must stay quiet before the buffered fragments are flushed. */
  quietMs: number;
  /** Hard cap, counted from the first buffered fragment. */
  maxWaitMs: number;
}

export interface PendingFragments {
  /** When the first fragment of the pending batch arrived (epoch ms). */
  firstAt: number;
  /** When the latest fragment arrived (epoch ms). */
  lastAt: number;
}

/** The moment to flush the pending batch: after a quiet window, but never past the cap. */
export function computeFlushAt(
  { firstAt, lastAt }: PendingFragments,
  policy: DebouncePolicy,
): number {
  return Math.min(lastAt + policy.quietMs, firstAt + policy.maxWaitMs);
}
