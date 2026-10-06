import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, isAgentId, parseSettings } from "../src/settings.ts";

describe("parseSettings", () => {
  it("keeps only the given, known settings", () => {
    expect(parseSettings({ tier: "frontier", maxOutputTokens: 2_000 })).toEqual({
      tier: "frontier",
      maxOutputTokens: 2_000,
    });
    expect(parseSettings({})).toEqual({});
  });

  it("waits a fixed time for more messages, 10 s by default, within a 60 s cap", () => {
    expect(DEFAULT_SETTINGS.quietMs).toBe(10_000);
    expect(DEFAULT_SETTINGS.maxWaitMs).toBe(60_000);
    expect(parseSettings({ quietMs: 4_000 })).toEqual({ quietMs: 4_000 });
  });

  it("lets the owner choose the qualifier for the agent's typed decisions, Clef by default", () => {
    expect(DEFAULT_SETTINGS.qualifier).toBe("clef");
    expect(parseSettings({ qualifier: "jev" })).toEqual({ qualifier: "jev" });
    expect(parseSettings({ qualifier: "clef" })).toEqual({ qualifier: "clef" });
  });

  it("gives a turn's tools 120 s by default, which the owner may only raise, up to 10 minutes", () => {
    expect(DEFAULT_SETTINGS.toolLoopMs).toBe(120_000);
    expect(parseSettings({ toolLoopMs: 300_000 })).toEqual({ toolLoopMs: 300_000 });
  });

  it.each([
    [{ tier: "gpt-9" }],
    [{ toolLoopMs: 119_999 }],
    [{ toolLoopMs: 600_001 }],
    [{ maxOutputTokens: 0 }],
    [{ maxOutputTokens: 1.5 }],
    [{ systemPrompt: "   " }],
    [{ quietMs: -1 }],
    [{ quietMs: 1.5 }],
    [{ quietMs: 120_001 }],
    // The end-of-turn windows are gone (ADR-0024).
    [{ quietWindow: { finishedMs: 1_000, defaultMs: 3_000, unfinishedMs: 6_000 } }],
    [{ qualifier: "openrouter" }],
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
