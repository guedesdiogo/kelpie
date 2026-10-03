export interface PacingOptions {
  /** The channel's minimum gap between two messages to the same conversation. */
  minGapMs: number;
  baseMs?: number;
  perCharMs?: number;
  minMs?: number;
  maxMs?: number;
}

/**
 * How long to show "typing" before each bubble: longer for longer bubbles, clamped, and never
 * shorter than the channel's minimum gap. Defaults follow research note 06 §9.3.
 */
export function paceBubbles(bubbles: string[], options: PacingOptions): number[] {
  const { minGapMs, baseMs = 800, perCharMs = 25, minMs = 800, maxMs = 4_000 } = options;
  return bubbles.map((bubble) => {
    const typing = Math.min(maxMs, Math.max(minMs, baseMs + perCharMs * bubble.length));
    return Math.max(minGapMs, typing);
  });
}
