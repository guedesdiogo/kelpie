import { describe, expect, it } from "vitest";
import { bounded, exitCode, reportsFailure } from "../src/outcome.ts";
import { RollbackRefused } from "../src/rollback.ts";

describe("bounded", () => {
  it("takes the fallback, or a number within the bounds", () => {
    expect(bounded(undefined, 10, "watch-minutes", 30)).toBe(10);
    expect(bounded("0", 10, "watch-minutes", 30)).toBe(0);
    expect(bounded("30", 10, "watch-minutes", 30)).toBe(30);
  });

  it.each(["31", "-1", "ten", ""])("refuses %j", (value) => {
    expect(() => bounded(value === "" ? "NaN" : value, 10, "watch-minutes", 30)).toThrow(
      "--watch-minutes takes a number from 0 to 30.",
    );
  });
});

describe("exitCode", () => {
  it("passes only a clean guard, a kept release and a healthy rollback", () => {
    expect(exitCode.guard(0)).toBe(0);
    expect(exitCode.guard(2)).toBe(1);
    expect(exitCode.deploy({ outcome: "deployed" })).toBe(0);
    expect(exitCode.deploy({ outcome: "rolled-back" })).toBe(1);
    expect(exitCode.deploy({ outcome: "failed" })).toBe(1);
    expect(exitCode.rollback({ verdict: { status: "healthy" } })).toBe(0);
    expect(exitCode.rollback({ verdict: { status: "unhealthy", reason: "r" } })).toBe(1);
    expect(exitCode.rollback({ verdict: { status: "inconclusive", reason: "r" } })).toBe(1);
  });
});

describe("reportsFailure", () => {
  it("reports any failure but a rollback refused before anything moved", () => {
    expect(reportsFailure(new Error("token missing"))).toBe(true);
    expect(reportsFailure(new RollbackRefused("refused"))).toBe(false);
    expect(reportsFailure(new RollbackRefused("undo failed", true))).toBe(true);
  });
});
