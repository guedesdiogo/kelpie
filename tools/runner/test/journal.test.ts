import { describe, expect, it } from "vitest";
import { forLog, MAX_LOGGED_CHARS } from "../src/journal.ts";

describe("forLog", () => {
  it("keeps one line of plain text as it is", () => {
    expect(forLog("Claude Code exited with code 1: é ✓")).toBe(
      "Claude Code exited with code 1: é ✓",
    );
  });

  it("turns newlines, control characters and line separators into spaces", () => {
    expect(forLog("a\nb\r\tc\u0000d\u001b[31me\u007ff\u0085g h i")).toBe("a b  c d [31me f g h i");
  });

  it(`cuts a text at ${MAX_LOGGED_CHARS} characters`, () => {
    expect(forLog("x".repeat(MAX_LOGGED_CHARS))).toBe("x".repeat(MAX_LOGGED_CHARS));
    expect(forLog("x".repeat(MAX_LOGGED_CHARS + 1))).toBe(`${"x".repeat(MAX_LOGGED_CHARS)}…`);
    expect(MAX_LOGGED_CHARS).toBe(2_000);
  });
});
