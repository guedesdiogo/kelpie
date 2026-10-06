// Scoring for the memory evaluation. Pure functions, so they are unit-tested apart from the index.
import type { SearchHit } from "../src/index.ts";
import type { LabelTarget } from "./generate.ts";
import { CATEGORIES, type Category, type Question } from "./questions.ts";

export const KS = [1, 3, 5, 10] as const;

export interface QuestionResult {
  id: string;
  category: Category;
  /** The rank at which the question is answered, or null when it isn't within the results. */
  answerRank: number | null;
  /** True when the first result is a memory labelled as outdated for this question. */
  staleFirst: boolean | null;
  /** Estimated tokens of the context packed from the top results. */
  tokens: number;
  latencyMs: number;
}

const sameTarget = (hit: SearchHit, target: LabelTarget) =>
  hit.path === target.path && hit.commit === target.commit;

/**
 * The rank (1-based) at which the hits answer the question: the first gold memory for most
 * questions, the last gold memory for multi-hop ones, which need them all.
 */
export function answerRank(
  question: Question,
  hits: readonly SearchHit[],
  labels: ReadonlyMap<string, LabelTarget>,
): number | null {
  const ranks = question.gold.map((key) => {
    const target = labels.get(key);
    if (!target) throw new Error(`${question.id}: unknown label ${key}`);
    const index = hits.findIndex((hit) => sameTarget(hit, target));
    return index === -1 ? null : index + 1;
  });
  if (question.category === "multi-hop") {
    return ranks.includes(null) ? null : Math.max(...(ranks as number[]));
  }
  const found = ranks.filter((rank) => rank !== null);
  return found.length === 0 ? null : Math.min(...found);
}

/** Null when the question has no outdated memories labelled. */
export function staleFirst(
  question: Question,
  hits: readonly SearchHit[],
  labels: ReadonlyMap<string, LabelTarget>,
): boolean | null {
  if (!question.stale?.length) return null;
  const first = hits[0];
  if (!first) return false;
  return question.stale.some((key) => {
    const target = labels.get(key);
    if (!target) throw new Error(`${question.id}: unknown label ${key}`);
    return sameTarget(first, target);
  });
}

/** The heuristic ai-memory's harness uses: about four characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface Metrics {
  n: number;
  hit: Record<(typeof KS)[number], number>;
  mrr: number;
  staleFirst: { n: number; rate: number };
  tokens: { mean: number; p95: number };
  latencyMs: { p50: number; p95: number };
}

/** Nearest-rank percentile. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

export function aggregate(results: readonly QuestionResult[]): Metrics {
  const n = results.length;
  const hit = Object.fromEntries(
    KS.map((k) => [
      k,
      round(results.filter((r) => r.answerRank !== null && r.answerRank <= k).length / (n || 1)),
    ]),
  ) as Metrics["hit"];
  const stale = results.filter((r) => r.staleFirst !== null);
  return {
    n,
    hit,
    mrr: round(
      results.reduce((sum, r) => sum + (r.answerRank ? 1 / r.answerRank : 0), 0) / (n || 1),
    ),
    staleFirst: {
      n: stale.length,
      rate: round(stale.filter((r) => r.staleFirst).length / (stale.length || 1)),
    },
    tokens: {
      mean: Math.round(results.reduce((sum, r) => sum + r.tokens, 0) / (n || 1)),
      p95: percentile(
        results.map((r) => r.tokens),
        95,
      ),
    },
    latencyMs: {
      p50: round(
        percentile(
          results.map((r) => r.latencyMs),
          50,
        ),
      ),
      p95: round(
        percentile(
          results.map((r) => r.latencyMs),
          95,
        ),
      ),
    },
  };
}

/** Overall, then one row per category that has questions. */
export function bySlice(results: readonly QuestionResult[]): Record<string, Metrics> {
  const slices: Record<string, Metrics> = { overall: aggregate(results) };
  for (const category of CATEGORIES) {
    const slice = results.filter((r) => r.category === category);
    if (slice.length > 0) slices[category] = aggregate(slice);
  }
  return slices;
}
