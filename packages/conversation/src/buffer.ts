import {
  endOfTurn,
  endOfTurnBands,
  type Qualifier,
  type QualifierId,
  type QuietWindowPolicy,
  quietWindowMs,
  type RunHooks,
  runDecision,
} from "@kelpie/qualifier";
import { computeFlushAt } from "./debounce.ts";

export interface BufferSettings {
  /** Off: every message is answered on its own, without waiting for more. */
  conversational: boolean;
  /** How long to wait for more fragments, by how likely the user is done (ADR-0009). */
  quietWindow: QuietWindowPolicy;
  /** Hard cap, counted from the first buffered fragment. */
  maxWaitMs: number;
}

export interface BufferedFragment {
  text: string;
  /** Epoch ms. */
  receivedAt: number;
}

export interface BufferHooks extends RunHooks {
  /** Who decided the end of turn, the probability, and how long the decision took. No text. */
  onDecided?(decision: { source: QualifierId | "heuristic"; finished: number; ms: number }): void;
}

/**
 * When to flush the buffered fragments. The quiet window comes from the end-of-turn decision, read
 * with the bands of whoever answered (ADR-0018). The cap always holds.
 */
export async function planFlush(
  fragments: readonly BufferedFragment[],
  settings: BufferSettings,
  qualifier: Qualifier | null,
  hooks: BufferHooks = {},
): Promise<number> {
  const first = fragments[0];
  const last = fragments.at(-1);
  if (!first || !last) throw new Error("planFlush needs at least one fragment");
  if (!settings.conversational) return last.receivedAt;
  const started = Date.now();
  const { finished, source } = await runDecision(
    qualifier,
    endOfTurn,
    { fragments: fragments.map((fragment) => fragment.text) },
    hooks,
  );
  try {
    hooks.onDecided?.({ source, finished, ms: Date.now() - started });
  } catch {
    // A failing logger must not change when the buffer flushes.
  }
  return computeFlushAt(
    { firstAt: first.receivedAt, lastAt: last.receivedAt },
    {
      quietMs: quietWindowMs(finished, settings.quietWindow, endOfTurnBands(source)),
      maxWaitMs: settings.maxWaitMs,
    },
  );
}
