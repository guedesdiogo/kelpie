import { describe, expect, it } from "vitest";
import { bands, brier, classification, ece, latency, percentile } from "../src/metrics.ts";

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
