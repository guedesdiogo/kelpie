import { type Bands, HEURISTIC_BANDS } from "@kelpie/qualifier";

/** One labeled item and a qualifier's probability that the user has finished. */
export interface Scored {
  label: boolean;
  finished: number;
}

/** Nearest-rank percentile, with `p` from 0 to 100. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(Math.max(Math.ceil((p / 100) * sorted.length), 1), sorted.length);
  return sorted[rank - 1] as number;
}

export interface LatencySummary {
  n: number;
  p50: number;
  p95: number;
  max: number;
  /** Share of calls slower than the decision's timeout. */
  overBudget: number;
}

export function latency(ms: number[], budgetMs: number): LatencySummary {
  return {
    n: ms.length,
    p50: percentile(ms, 50),
    p95: percentile(ms, 95),
    max: ms.length ? Math.max(...ms) : Number.NaN,
    overBudget: ms.length ? ms.filter((value) => value > budgetMs).length / ms.length : Number.NaN,
  };
}

/** Accuracy at a 0.5 threshold, and the recall of each class. */
export function classification(items: Scored[]) {
  const correct = (item: Scored) => item.finished >= 0.5 === item.label;
  const recall = (label: boolean) => {
    const group = items.filter((item) => item.label === label);
    return group.length ? group.filter(correct).length / group.length : Number.NaN;
  };
  return {
    accuracy: items.length ? items.filter(correct).length / items.length : Number.NaN,
    finishedRecall: recall(true),
    unfinishedRecall: recall(false),
  };
}

/**
 * The quiet-window policy's three bands. A wrong fast close interrupts a user who is still
 * typing; a wrong slow wait makes a user who is done wait longer.
 */
export function bands(items: Scored[], high = 0.8, low = 0.3) {
  const fast = items.filter((item) => item.finished >= high);
  const slow = items.filter((item) => item.finished <= low);
  return {
    fast: { n: fast.length, wrong: fast.filter((item) => !item.label).length },
    slow: { n: slow.length, wrong: slow.filter((item) => item.label).length },
    middle: items.length - fast.length - slow.length,
  };
}

/** Mean squared error of the probabilities: 0 is perfect, 0.25 is a constant 0.5. */
export function brier(items: Scored[]): number {
  if (items.length === 0) return Number.NaN;
  return (
    items.reduce((sum, item) => sum + (item.finished - Number(item.label)) ** 2, 0) / items.length
  );
}

/** Expected calibration error over equal-width probability bins. */
export function ece(items: Scored[], bins = 10): number {
  if (items.length === 0) return Number.NaN;
  let total = 0;
  for (let bin = 0; bin < bins; bin++) {
    const group = items.filter((item) => {
      const index = Math.min(Math.floor(item.finished * bins), bins - 1);
      return index === bin;
    });
    if (group.length === 0) continue;
    const confidence = group.reduce((sum, item) => sum + item.finished, 0) / group.length;
    const observed = group.filter((item) => item.label).length / group.length;
    total += (group.length / items.length) * Math.abs(confidence - observed);
  }
  return total;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * The widest bands that make no wrong decision in any pass: fast closes start just above the
 * highest value an unfinished item got, slow waits end just below the lowest a finished item got.
 * On 101 items this overfits, so the bands are a starting point to recalibrate on real chats.
 */
export function zeroErrorBands(passes: Scored[][]): Bands {
  const all = passes.flat();
  const unfinished = all.filter((item) => !item.label).map((item) => item.finished);
  const finished = all.filter((item) => item.label).map((item) => item.finished);
  return {
    high: round2((unfinished.length ? Math.max(...unfinished) : 0) + 0.01),
    low: round2((finished.length ? Math.min(...finished) : 1) - 0.01),
  };
}

/** One item as the production hybrid sees it: the heuristic's value and the qualifier's. */
export interface HybridItem {
  label: boolean;
  heuristic: number;
  qualifier: number;
}

/**
 * Production's end of turn (ADR-0018): a confident heuristic decides first, at its own bands,
 * and the qualifier decides the rest at `bands`. Counts the confident decisions and the wrong ones.
 */
export function hybrid(items: HybridItem[], bands: Bands) {
  let decided = 0;
  let wrong = 0;
  for (const item of items) {
    const confident =
      item.heuristic >= HEURISTIC_BANDS.high || item.heuristic <= HEURISTIC_BANDS.low;
    const [value, high, low] = confident
      ? [item.heuristic, HEURISTIC_BANDS.high, HEURISTIC_BANDS.low]
      : [item.qualifier, bands.high, bands.low];
    if (value >= high) {
      decided += 1;
      if (!item.label) wrong += 1;
    } else if (value <= low) {
      decided += 1;
      if (item.label) wrong += 1;
    }
  }
  return { decided, wrong };
}

/** The range and median of the values each label got. */
export function distribution(items: Scored[]) {
  const summary = (label: boolean) => {
    const values = items.filter((item) => item.label === label).map((item) => item.finished);
    return {
      min: values.length ? Math.min(...values) : Number.NaN,
      median: percentile(values, 50),
      max: values.length ? Math.max(...values) : Number.NaN,
    };
  };
  return { finished: summary(true), unfinished: summary(false) };
}
