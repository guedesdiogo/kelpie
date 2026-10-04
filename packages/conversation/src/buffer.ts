import {
  endOfTurn,
  type Qualifier,
  type QuietWindowPolicy,
  quietWindowMs,
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

/**
 * When to flush the buffered fragments. The quiet window comes from the end-of-turn decision: the
 * qualifier when one is configured, the keyless heuristic otherwise. The cap always holds.
 */
export async function planFlush(
  fragments: readonly BufferedFragment[],
  settings: BufferSettings,
  qualifier: Qualifier | null,
): Promise<number> {
  const first = fragments[0];
  const last = fragments.at(-1);
  if (!first || !last) throw new Error("planFlush needs at least one fragment");
  if (!settings.conversational) return last.receivedAt;
  const { finished } = await runDecision(qualifier, endOfTurn, {
    fragments: fragments.map((fragment) => fragment.text),
  });
  return computeFlushAt(
    { firstAt: first.receivedAt, lastAt: last.receivedAt },
    { quietMs: quietWindowMs(finished, settings.quietWindow), maxWaitMs: settings.maxWaitMs },
  );
}
