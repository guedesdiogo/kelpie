import { computeFlushAt } from "./debounce.ts";

export interface BufferSettings {
  /** Off: every message is answered on its own, without waiting for more. */
  conversational: boolean;
  /** How long the user must stay quiet before the buffered fragments are answered (ADR-0024). */
  quietMs: number;
  /** Hard cap, counted from the first buffered fragment. */
  maxWaitMs: number;
}

export interface BufferedFragment {
  text: string;
  /** Epoch ms. */
  receivedAt: number;
}

/**
 * When to flush the buffered fragments: a fixed quiet window after the latest one, so each new
 * fragment starts it again, and never past the cap (ADR-0024). No decision is asked for. After a
 * pause (issue #134) the cap counts from `capFrom`, the message that resumed the conversation.
 */
export function planFlush(
  fragments: readonly BufferedFragment[],
  settings: BufferSettings,
  capFrom?: number,
): number {
  const first = fragments[0];
  const last = fragments.at(-1);
  if (!first || !last) throw new Error("planFlush needs at least one fragment");
  if (!settings.conversational) return last.receivedAt;
  return computeFlushAt(
    { firstAt: Math.max(first.receivedAt, capFrom ?? first.receivedAt), lastAt: last.receivedAt },
    { quietMs: settings.quietMs, maxWaitMs: settings.maxWaitMs },
  );
}
