import { describe, expect, it } from "vitest";
import { lowerEffort } from "../src/efforts.ts";
import { memoryOnSessionRoute, parseModelSettings, resolveModel } from "../src/models.ts";

describe("resolveModel", () => {
  it("falls back to the pinned provider, the cheap tier and the model's own effort", () => {
    expect(resolveModel({ area: "conversation", pinned: "anthropic" })).toEqual({
      provider: "anthropic",
      tier: "cheap",
    });
    expect(resolveModel({ area: "memory", pinned: null })).toEqual({
      provider: null,
      tier: "cheap",
    });
  });

  it("takes each field from the first scope that sets it, in ADR-0036's order", () => {
    const instance = {
      provider: "anthropic" as const,
      conversation: { tier: "medium" as const, effort: "low" as const },
      memory: { provider: "openai" as const },
    };
    // The instance's area beats the instance, which beats the pin.
    expect(resolveModel({ area: "conversation", instance, pinned: "openai" })).toEqual({
      provider: "anthropic",
      tier: "medium",
      effort: "low",
    });
    expect(resolveModel({ area: "memory", instance, pinned: "anthropic" })).toEqual({
      provider: "openai",
      tier: "cheap",
    });
    // The agent beats the instance, and the agent's area beats the agent.
    const agent = {
      provider: "openai" as const,
      conversation: { tier: "frontier" as const, provider: "anthropic" as const },
    };
    expect(resolveModel({ area: "conversation", agent, instance, pinned: null })).toEqual({
      provider: "anthropic",
      tier: "frontier",
      effort: "low",
    });
  });

  it("carries an agent's provider into its memory, but never its conversation tier or effort", () => {
    const agent = {
      provider: "openai" as const,
      conversation: { tier: "frontier" as const, effort: "max" as const },
    };
    expect(resolveModel({ area: "memory", agent, pinned: "anthropic" })).toEqual({
      provider: "openai",
      tier: "cheap",
    });
  });

  it("uses the caller's tier as the built-in, until the area sets one", () => {
    expect(resolveModel({ area: "memory", pinned: "anthropic", tier: "medium" }).tier).toBe(
      "medium",
    );
    const instance = { memory: { tier: "cheap" as const } };
    expect(
      resolveModel({ area: "memory", instance, pinned: "anthropic", tier: "medium" }).tier,
    ).toBe("cheap");
  });
});

describe("parseModelSettings", () => {
  it("accepts a provider and the two areas", () => {
    const settings = {
      provider: "openai",
      conversation: { tier: "frontier", effort: "high" },
      memory: { provider: "anthropic", tier: "cheap" },
    };
    expect(parseModelSettings(settings)).toEqual(settings);
    expect(parseModelSettings({})).toEqual({});
  });

  it("accepts the claude-code route, which the commands keep out of memory (#295)", () => {
    const settings = { provider: "claude-code", conversation: { provider: "claude-code" } };
    expect(parseModelSettings(settings)).toEqual(settings);
    expect(memoryOnSessionRoute(settings as never)).toBe(false);
    expect(memoryOnSessionRoute({ memory: { provider: "claude-code" } })).toBe(true);
    expect(memoryOnSessionRoute({ memory: { provider: "anthropic" } })).toBe(false);
  });

  it.each([
    ["a non-object", "frontier"],
    ["an unknown key", { model: "gpt-6-astra" }],
    ["an unknown provider", { provider: "mistral" }],
    ["an unknown area", { tasks: { tier: "cheap" } }],
    ["an area that isn't an object", { memory: "cheap" }],
    ["an unknown area key", { memory: { model: "x" } }],
    ["an unknown tier", { conversation: { tier: "huge" } }],
    ["an unknown effort", { conversation: { effort: "none" } }],
  ])("refuses %s", (_label, value) => {
    expect(parseModelSettings(value)).toBeNull();
  });
});

describe("lowerEffort", () => {
  it("passes any effort to a model that takes all five, and nothing when none was asked", () => {
    expect(lowerEffort("claude-haiku-5-5", "max")).toBe("max");
    expect(lowerEffort("gpt-6-luna", "xhigh")).toBe("xhigh");
    expect(lowerEffort("claude-opus-4-6", undefined)).toBeUndefined();
  });

  it("lowers to the nearest effort the model supports, dated ids included", () => {
    expect(lowerEffort("claude-opus-4-6", "xhigh")).toBe("high");
    expect(lowerEffort("claude-sonnet-4-6", "max")).toBe("max");
    expect(lowerEffort("claude-opus-4-5-20251101", "max")).toBe("high");
  });

  it("drops the effort for a model that takes none", () => {
    expect(lowerEffort("claude-haiku-4-5", "low")).toBeUndefined();
    expect(lowerEffort("claude-haiku-4-5-20251001", "high")).toBeUndefined();
    expect(lowerEffort("claude-sonnet-4-5", "medium")).toBeUndefined();
  });
});
