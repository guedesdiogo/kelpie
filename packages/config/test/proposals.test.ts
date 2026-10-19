import { describe, expect, it } from "vitest";
import {
  isProposalId,
  mergeModel,
  parseProposalChanges,
  parseProposalReason,
  sameValue,
} from "../src/proposals.ts";

describe("a proposal's changes (#302)", () => {
  it("takes, for a specialist, its spawn, tools, remit, trio or chat", () => {
    expect(parseProposalChanges("specialist", { spawn: true, remit: "Sales quotes." })).toEqual({
      spawn: true,
      remit: "Sales quotes.",
    });
    expect(
      parseProposalChanges("specialist", { tools: ["memory_search", "memory_search"] }),
    ).toEqual({ tools: ["memory_search"] });
    expect(
      parseProposalChanges("specialist", { model: { conversation: { tier: "medium" } } }),
    ).toEqual({ model: { conversation: { tier: "medium" } } });
    expect(parseProposalChanges("specialist", { chat: true })).toEqual({ chat: true });
  });

  it("takes, for a subagent, its trio, tools, remit, soul and skills", () => {
    const skills = [{ name: "Quotes", instructions: "Price each line." }];
    expect(
      parseProposalChanges("subagent", {
        systemPrompt: "You price quotes.",
        skills,
        tools: ["complete_task"],
      }),
    ).toEqual({ systemPrompt: "You price quotes.", skills, tools: ["complete_task"] });
  });

  it("refuses what the target's role doesn't take, an empty change, and chat beside settings", () => {
    for (const [role, input] of [
      // A subagent never chats, and only Master turns spawn on.
      ["subagent", { chat: true }],
      ["subagent", { spawn: true }],
      // A specialist's soul, rules and skills live in the vault (ADR-0020 §5).
      ["specialist", { systemPrompt: "Be terse." }],
      ["specialist", { skills: [] }],
      // Master isn't a target, nor is anything but these fields.
      ["main", { remit: "Everything." }],
      ["specialist", { maxConcurrentTasks: 10 }],
      ["specialist", { mascot: null }],
      ["specialist", {}],
      ["specialist", null],
      ["specialist", ["remit"]],
      // One object per proposal: the Registry's chat, or the AgentHost's settings.
      ["specialist", { chat: true, remit: "Sales." }],
      ["specialist", { chat: "yes" }],
      ["specialist", { tools: ["Not A Tool"] }],
    ] as const) {
      expect(parseProposalChanges(role, input), JSON.stringify([role, input])).toBeNull();
    }
  });

  it("merges a proposed trio into the agent's own, area by area", () => {
    expect(
      mergeModel(
        { provider: "anthropic", conversation: { tier: "cheap", effort: "low" }, memory: {} },
        { conversation: { tier: "medium" } },
      ),
    ).toEqual({
      provider: "anthropic",
      conversation: { tier: "medium", effort: "low" },
      memory: {},
    });
    expect(mergeModel({}, { provider: "openai", memory: { tier: "cheap" } })).toEqual({
      provider: "openai",
      memory: { tier: "cheap" },
    });
  });

  it("takes the agent's reason as one to 500 characters that show", () => {
    expect(parseProposalReason("  It needs the medium tier for long quotes.  ")).toBe(
      "It needs the medium tier for long quotes.",
    );
    expect(parseProposalReason("Line one.\nLine two.")).toBe("Line one.\nLine two.");
    for (const reason of [undefined, 7, "", "   ", "a".repeat(501), "\u200b\u200b"]) {
      expect(parseProposalReason(reason), JSON.stringify(reason)).toBeNull();
    }
  });

  it("compares values as JSON with sorted keys, and knows a proposal's id", () => {
    expect(sameValue({ b: 1, a: [1, { d: 2, c: 3 }] }, { a: [1, { c: 3, d: 2 }], b: 1 })).toBe(
      true,
    );
    expect(sameValue(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameValue(null, undefined)).toBe(false);
    expect(isProposalId("0f8b7c1e-6a2d-4c3b-9e5f-1a2b3c4d5e6f")).toBe(true);
    expect(isProposalId("../tasks")).toBe(false);
  });
});
