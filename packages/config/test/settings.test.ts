import { describe, expect, it } from "vitest";
import { isAgentId, parseSettings } from "../src/settings.ts";

describe("parseSettings", () => {
  it("keeps only the given, known settings", () => {
    expect(parseSettings({ tier: "frontier", maxOutputTokens: 2_000 })).toEqual({
      tier: "frontier",
      maxOutputTokens: 2_000,
    });
    expect(parseSettings({})).toEqual({});
  });

  it.each([
    [{ tier: "gpt-9" }],
    [{ maxOutputTokens: 0 }],
    [{ maxOutputTokens: 1.5 }],
    [{ systemPrompt: "   " }],
    [{ quietWindow: { finishedMs: 1 } }],
    [{ surprise: true }],
    [null],
    ["settings"],
  ])("refuses %j", (input) => {
    expect(parseSettings(input)).toBeNull();
  });
});

describe("isAgentId", () => {
  it("accepts lowercase slugs only", () => {
    expect(isAgentId("sales-bot")).toBe(true);
    for (const bad of ["Sales", "s", "1sales", "sales bot", "a".repeat(41), 42]) {
      expect(isAgentId(bad)).toBe(false);
    }
  });
});
