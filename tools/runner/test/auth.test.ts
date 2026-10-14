import { describe, expect, it } from "vitest";
import { isAuthorized } from "../src/auth.ts";

const CURRENT = "a".repeat(64);
const NEXT = "b".repeat(64);

describe("isAuthorized", () => {
  it("accepts the current secret as a bearer token", () => {
    expect(isAuthorized(`Bearer ${CURRENT}`, [CURRENT])).toBe(true);
  });

  it("accepts the next secret during a rotation", () => {
    expect(isAuthorized(`Bearer ${NEXT}`, [CURRENT, NEXT])).toBe(true);
  });

  it.each([
    ["no header", null],
    ["an empty header", ""],
    ["another scheme", `Basic ${CURRENT}`],
    ["an empty token", "Bearer "],
    ["a wrong secret", `Bearer ${"c".repeat(64)}`],
    ["a prefix of the secret", `Bearer ${CURRENT.slice(0, 32)}`],
    ["the secret with more after it", `Bearer ${CURRENT}x`],
  ])("refuses %s", (_, header) => {
    expect(isAuthorized(header, [CURRENT, NEXT])).toBe(false);
  });
});
