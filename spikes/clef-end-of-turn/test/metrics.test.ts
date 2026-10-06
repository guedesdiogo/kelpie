import { describe, expect, it } from "vitest";
import {
  bands,
  brier,
  classification,
  distribution,
  ece,
  hybrid,
  latency,
  percentile,
  zeroErrorBands,
} from "../src/metrics.ts";

describe("percentile", () => {
  it("takes the nearest rank", () => {
    const values = [500, 100, 300, 200, 400];
    expect(percentile(values, 50)).toBe(300);
    expect(percentile(values, 95)).toBe(500);
    expect(percentile(values, 0)).toBe(100);
  });
});

describe("latency", () => {
  it("counts the share of calls over the budget", () => {
    expect(latency([100, 900, 700, 1200], 800)).toEqual({
      n: 4,
      p50: 700,
      p95: 1200,
      max: 1200,
      overBudget: 0.5,
    });
  });
});

describe("classification", () => {
  it("scores at 0.5 and reports recall per class", () => {
    const result = classification([
      { label: true, finished: 0.9 },
      { label: true, finished: 0.4 },
      { label: false, finished: 0.1 },
      { label: false, finished: 0.5 },
    ]);
    expect(result).toEqual({ accuracy: 0.5, finishedRecall: 0.5, unfinishedRecall: 0.5 });
  });
});

describe("bands", () => {
  it("separates wrong fast closes from wrong slow waits", () => {
    expect(
      bands([
        { label: true, finished: 0.9 },
        { label: false, finished: 0.85 },
        { label: true, finished: 0.2 },
        { label: false, finished: 0.5 },
      ]),
    ).toEqual({ fast: { n: 2, wrong: 1 }, slow: { n: 1, wrong: 1 }, middle: 1 });
  });
});

describe("calibration", () => {
  it("gives 0 for perfect answers and 0.25 for a constant 0.5", () => {
    const perfect = [
      { label: true, finished: 1 },
      { label: false, finished: 0 },
    ];
    const constant = [
      { label: true, finished: 0.5 },
      { label: false, finished: 0.5 },
    ];
    expect(brier(perfect)).toBe(0);
    expect(brier(constant)).toBe(0.25);
    expect(ece(perfect)).toBe(0);
    expect(ece(constant)).toBe(0);
  });

  it("measures the gap between confidence and the observed rate", () => {
    const overconfident = [
      { label: true, finished: 0.95 },
      { label: false, finished: 0.95 },
    ];
    expect(ece(overconfident)).toBeCloseTo(0.45);
  });
});

describe("zeroErrorBands", () => {
  it("takes the widest bands with no wrong decision in any pass", () => {
    const pass1 = [
      { label: true, finished: 0.82 },
      { label: true, finished: 0.71 },
      { label: false, finished: 0.66 },
      { label: false, finished: 0.41 },
      { label: true, finished: 0.39 },
      { label: false, finished: 0.2 },
    ];
    // In the second pass an unfinished item rises to 0.69, so fast closes must start above it.
    const pass2 = pass1.map((item, index) => (index === 2 ? { ...item, finished: 0.69 } : item));
    expect(zeroErrorBands([pass1])).toEqual({ high: 0.67, low: 0.38 });
    expect(zeroErrorBands([pass1, pass2])).toEqual({ high: 0.7, low: 0.38 });
  });

  it("keeps the bands closed when every value is mixed", () => {
    expect(
      zeroErrorBands([
        [
          { label: false, finished: 1 },
          { label: true, finished: 0 },
        ],
      ]),
    ).toEqual({ high: 1.01, low: -0.01 });
  });
});

describe("hybrid", () => {
  it("lets a confident heuristic decide first and the qualifier decide the rest", () => {
    const items = [
      // A confident heuristic: the qualifier's answer is never asked for.
      { label: false, heuristic: 0.15, qualifier: 0.9 },
      // The heuristic is unsure, and the qualifier decides correctly.
      { label: true, heuristic: 0.5, qualifier: 0.75 },
      // Unsure, and the qualifier decides wrongly.
      { label: true, heuristic: 0.5, qualifier: 0.35 },
      // Unsure, and the qualifier is in its middle band.
      { label: false, heuristic: 0.5, qualifier: 0.55 },
    ];
    expect(hybrid(items, { high: 0.7, low: 0.4 })).toEqual({ decided: 3, wrong: 1 });
  });
});

describe("distribution", () => {
  it("reports the range and median of each label", () => {
    expect(
      distribution([
        { label: true, finished: 0.9 },
        { label: true, finished: 0.5 },
        { label: true, finished: 0.7 },
        { label: false, finished: 0.2 },
      ]),
    ).toEqual({
      finished: { min: 0.5, median: 0.7, max: 0.9 },
      unfinished: { min: 0.2, median: 0.2, max: 0.2 },
    });
  });
});
