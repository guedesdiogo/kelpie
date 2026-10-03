import { describe, expect, it } from "vitest";
import {
  type EndOfTurnContext,
  endOfTurn,
  FakeQualifier,
  heuristicFinished,
  type Qualifier,
  quietWindowMs,
  runDecision,
} from "../src/index.ts";

const ctx = (...fragments: string[]): EndOfTurnContext => ({ fragments });

describe("heuristicFinished", () => {
  it.each([
    ["queria saber o status do meu pedido?", "a question"],
    ["Pode me mandar o boleto, por favor.", "a full sentence with final punctuation"],
    ["/status", "a command"],
  ])("leans finished for %s (%s)", (text) => {
    expect(heuristicFinished(ctx(text))).toBeGreaterThanOrEqual(0.8);
  });

  it.each([
    ["oi", "a greeting that usually comes before the request"],
    ["então", "a connective"],
    ["queria ver aquele pedido e", "a trailing connective"],
    ["olha isso,", "a trailing comma"],
    ["deixa eu ver...", "an ellipsis"],
  ])("leans unfinished for %s (%s)", (text) => {
    expect(heuristicFinished(ctx(text))).toBeLessThanOrEqual(0.3);
  });

  it("judges by the latest fragment", () => {
    expect(heuristicFinished(ctx("oi", "tudo bem?"))).toBeGreaterThanOrEqual(0.8);
  });
});

describe("quietWindowMs", () => {
  const policy = { finishedMs: 1_000, defaultMs: 2_500, unfinishedMs: 5_000 };

  it("waits less when the user looks done and more when they don't", () => {
    expect(quietWindowMs(0.9, policy)).toBe(1_000);
    expect(quietWindowMs(0.5, policy)).toBe(2_500);
    expect(quietWindowMs(0.1, policy)).toBe(5_000);
  });
});

describe("runDecision with the end-of-turn decision", () => {
  it("uses the qualifier's answer when it has one", async () => {
    const qualifier = new FakeQualifier({
      "turn.end::user_finished": { type: "noul", noul: 0.95 },
    });
    const result = await runDecision(qualifier, endOfTurn, ctx("oi"));
    expect(result).toEqual({ finished: 0.95, source: "fake" });
  });

  it("falls back to the heuristic when the qualifier fails", async () => {
    const failing: Qualifier = {
      id: "jev-workers-ai",
      calibrated: true,
      qualify: async () => {
        throw new Error("rate limited");
      },
    };
    const result = await runDecision(failing, endOfTurn, ctx("então"));
    expect(result.source).toBe("heuristic");
    expect(result.finished).toBeLessThanOrEqual(0.3);
  });

  it("falls back to the heuristic when the qualifier is too slow", async () => {
    const slow: Qualifier = {
      id: "jev-workers-ai",
      calibrated: true,
      qualify: () => new Promise<never>(() => {}),
    };
    const result = await runDecision(slow, { ...endOfTurn, timeoutMs: 20 }, ctx("tudo certo?"));
    expect(result).toEqual({
      finished: heuristicFinished(ctx("tudo certo?")),
      source: "heuristic",
    });
  });

  it("works with no qualifier configured", async () => {
    const result = await runDecision(null, endOfTurn, ctx("tudo certo?"));
    expect(result.source).toBe("heuristic");
  });
});
