import { describe, expect, it } from "vitest";
import { computeFlushAt } from "../src/index.ts";

const policy = { quietMs: 2_000, maxWaitMs: 8_000 };

describe("computeFlushAt", () => {
  it("waits the quiet window after the latest fragment", () => {
    expect(computeFlushAt({ firstAt: 0, lastAt: 0 }, policy)).toBe(2_000);
    expect(computeFlushAt({ firstAt: 0, lastAt: 1_500 }, policy)).toBe(3_500);
  });

  it("never waits past the hard cap counted from the first fragment", () => {
    expect(computeFlushAt({ firstAt: 0, lastAt: 7_000 }, policy)).toBe(8_000);
    expect(computeFlushAt({ firstAt: 0, lastAt: 20_000 }, policy)).toBe(8_000);
  });
});
