import { describe, expect, it } from "vitest";
import type { LabelTarget } from "../eval/generate.ts";
import type { Question } from "../eval/questions.ts";
import {
  aggregate,
  answerRank,
  bySlice,
  estimateTokens,
  percentile,
  type QuestionResult,
  staleFirst,
} from "../eval/score.ts";
import type { SearchHit } from "../src/index.ts";

const labels = new Map<string, LabelTarget>([
  ["a", { path: "memory/notes/a.md", commit: "c2" }],
  ["a@1", { path: "memory/notes/a.md", commit: "c1" }],
  ["b", { path: "memory/notes/b.md", commit: "c1" }],
  ["old", { path: "memory/notes/old.md", commit: "c1" }],
]);
const hit = (path: string, commit: string): SearchHit => ({
  path,
  commit,
  title: path,
  abstract: null,
  current: true,
});
const question = (gold: string[], extra: Partial<Question> = {}): Question => ({
  id: "q",
  text: "?",
  category: "entity",
  gold,
  ...extra,
});

describe("answerRank", () => {
  const hits = [
    hit("memory/notes/old.md", "c1"),
    hit("memory/notes/a.md", "c1"),
    hit("memory/notes/b.md", "c1"),
    hit("memory/notes/a.md", "c2"),
  ];

  it("takes the first gold memory, matching the version too", () => {
    expect(answerRank(question(["a", "b"]), hits, labels)).toBe(3);
    expect(answerRank(question(["a@1"]), hits, labels)).toBe(2);
    expect(answerRank(question(["a"]), hits.slice(0, 3), labels)).toBeNull();
  });

  it("needs every gold memory for a multi-hop question", () => {
    expect(answerRank(question(["a", "b"], { category: "multi-hop" }), hits, labels)).toBe(4);
    expect(
      answerRank(question(["a", "b"], { category: "multi-hop" }), hits.slice(0, 3), labels),
    ).toBeNull();
  });

  it("refuses a label that doesn't exist", () => {
    expect(() => answerRank(question(["nope"]), hits, labels)).toThrow("unknown label nope");
  });
});

describe("staleFirst", () => {
  it("says whether the first result is an outdated memory", () => {
    const stale = question(["a"], { stale: ["old"] });
    expect(staleFirst(stale, [hit("memory/notes/old.md", "c1")], labels)).toBe(true);
    expect(staleFirst(stale, [hit("memory/notes/a.md", "c2")], labels)).toBe(false);
    expect(staleFirst(stale, [], labels)).toBe(false);
    expect(staleFirst(question(["a"]), [], labels)).toBeNull();
  });
});

describe("aggregate", () => {
  const result = (answer: number | null, extra: Partial<QuestionResult> = {}): QuestionResult => ({
    id: "q",
    category: "entity",
    answerRank: answer,
    staleFirst: null,
    tokens: 100,
    latencyMs: 1,
    ...extra,
  });

  it("reports hit@k, MRR, the stale rate, tokens and latency", () => {
    const metrics = aggregate([
      result(1, { tokens: 40, latencyMs: 2 }),
      result(3, { staleFirst: false }),
      result(null, { staleFirst: true, tokens: 400, latencyMs: 9 }),
      result(10),
    ]);
    expect(metrics).toEqual({
      n: 4,
      hit: { 1: 0.25, 3: 0.5, 5: 0.5, 10: 0.75 },
      mrr: 0.358,
      staleFirst: { n: 2, rate: 0.5 },
      tokens: { mean: 160, p95: 400 },
      latencyMs: { mean: 3.25, p50: 1, p95: 9 },
    });
  });

  it("estimates tokens at four characters each and takes nearest-rank percentiles", () => {
    expect(estimateTokens("abcde")).toBe(2);
    expect(percentile([5, 1, 3], 50)).toBe(3);
    expect(percentile([], 95)).toBe(0);
  });

  it("slices by category and by extra groups, and copes with no questions", () => {
    const slices = bySlice(
      [
        result(1, { id: "q1", category: "entity" }),
        result(null, { id: "q2", category: "multi-hop" }),
      ],
      { named: new Set(["q1"]) },
    );
    expect(Object.keys(slices)).toEqual(["overall", "entity", "multi-hop", "named"]);
    expect(slices.named?.hit[1]).toBe(1);
    expect(slices["multi-hop"]?.hit[10]).toBe(0);
    expect(aggregate([])).toMatchObject({
      n: 0,
      mrr: 0,
      hit: { 1: 0 },
      tokens: { mean: 0, p95: 0 },
    });
  });
});
