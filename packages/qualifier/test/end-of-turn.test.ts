import { describe, expect, it, vi } from "vitest";
import {
  type EndOfTurnContext,
  endOfTurn,
  endOfTurnBands,
  FakeQualifier,
  heuristicFinished,
  type Qualifier,
  quietWindowMs,
  runDecision,
} from "../src/index.ts";

const ctx = (...fragments: string[]): EndOfTurnContext => ({ fragments });
/** The heuristic can't tell (0.5), so the decision asks the qualifier. */
const NEUTRAL = "o problema é que quando eu abro o app";

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

  it.each([
    ["tudo bem? 😊", "a question followed by an emoji"],
    ["Pode mandar o boleto. 🙏", "a sentence followed by an emoji"],
    ["Quê?!", "an exclamation-question"],
    ["ok", "an acknowledgement"],
    ["blz", "a short acknowledgement"],
    ["pode ser", "an agreement"],
    ["obrigado!", "thanks"],
    ["👍", "an emoji-only reply"],
    ["Quero pagar.", "a short complete sentence"],
  ])("leans finished for %s (%s)", (text) => {
    expect(heuristicFinished(ctx(text))).toBeGreaterThanOrEqual(0.8);
  });

  it.each([
    ["I think so", "'so' ending a complete sentence"],
    ["estou chegando aí", "'aí' meaning 'there'"],
    ["não sei por que", "'que' ending a complete sentence"],
    ["/ 2 coisas", "a slash that is not a command"],
  ])("stays neutral for %s (%s)", (text) => {
    const finished = heuristicFinished(ctx(text));
    expect(finished).toBeGreaterThan(0.3);
    expect(finished).toBeLessThan(0.8);
  });

  it("treats a greeting with small talk as the start of a message", () => {
    expect(heuristicFinished(ctx("bom dia, tudo bem?"))).toBeLessThanOrEqual(0.3);
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

  it("uses the bands of whoever answered", () => {
    const jev = endOfTurnBands("jev-http");
    expect(quietWindowMs(0.72, policy, jev)).toBe(1_000);
    expect(quietWindowMs(0.72, policy)).toBe(2_500);
    expect(quietWindowMs(0.38, policy, jev)).toBe(5_000);
    expect(quietWindowMs(0.38, policy)).toBe(2_500);
  });
});

describe("endOfTurnBands", () => {
  it("gives Jev its measured PT-BR bands and everyone else the heuristic's", () => {
    expect(endOfTurnBands("jev-http")).toEqual({ high: 0.7, low: 0.4 });
    expect(endOfTurnBands("jev-workers-ai")).toEqual({ high: 0.7, low: 0.4 });
    expect(endOfTurnBands("heuristic")).toEqual({ high: 0.8, low: 0.3 });
    expect(endOfTurnBands("fake")).toEqual({ high: 0.8, low: 0.3 });
  });
});

describe("runDecision with the end-of-turn decision", () => {
  it("uses the qualifier's answer when it has one", async () => {
    const qualifier = new FakeQualifier({
      "turn.end::user_finished": { type: "noul", noul: 0.95 },
    });
    const result = await runDecision(qualifier, endOfTurn, ctx(NEUTRAL));
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
    const result = await runDecision(failing, endOfTurn, ctx(NEUTRAL));
    expect(result).toEqual({ finished: heuristicFinished(ctx(NEUTRAL)), source: "heuristic" });
  });

  it("falls back to the heuristic when the qualifier is too slow", async () => {
    const slow: Qualifier = {
      id: "jev-workers-ai",
      calibrated: true,
      qualify: () => new Promise<never>(() => {}),
    };
    const result = await runDecision(slow, { ...endOfTurn, timeoutMs: 20 }, ctx(NEUTRAL));
    expect(result).toEqual({
      finished: heuristicFinished(ctx(NEUTRAL)),
      source: "heuristic",
    });
  });

  it("falls back when building the questions throws", async () => {
    const broken = {
      ...endOfTurn,
      questions: () => {
        throw new Error("bad context");
      },
    };
    const qualifier = new FakeQualifier({});
    expect(await runDecision(qualifier, broken, ctx(NEUTRAL))).toEqual({
      finished: heuristicFinished(ctx(NEUTRAL)),
      source: "heuristic",
    });
  });

  it("rejects an answer outside 0 to 1 and falls back", async () => {
    const qualifier = new FakeQualifier({ "turn.end::user_finished": { type: "noul", noul: 7 } });
    const onFallback = vi.fn();
    const result = await runDecision(qualifier, endOfTurn, ctx(NEUTRAL), { onFallback });
    expect(result.source).toBe("heuristic");
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it("reports nothing when the qualifier answers", async () => {
    const qualifier = new FakeQualifier({ "turn.end::user_finished": { type: "noul", noul: 0.4 } });
    const onFallback = vi.fn();
    await runDecision(qualifier, endOfTurn, ctx(NEUTRAL), { onFallback });
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("reports a timeout and aborts the qualifier's call", async () => {
    let signal: { aborted: boolean } | undefined;
    const slow: Qualifier = {
      id: "jev-workers-ai",
      calibrated: true,
      qualify: (_state, _questions, options) => {
        signal = options?.signal;
        return new Promise<never>(() => {});
      },
    };
    const onFallback = vi.fn();
    await runDecision(slow, { ...endOfTurn, timeoutMs: 20 }, ctx(NEUTRAL), { onFallback });
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(String(onFallback.mock.calls[0]?.[1])).toContain("timed out");
    expect(signal?.aborted).toBe(true);
  });

  it("survives a throwing fallback hook", async () => {
    const qualifier = new FakeQualifier({});
    const onFallback = () => {
      throw new Error("logger down");
    };
    const result = await runDecision(qualifier, endOfTurn, ctx(NEUTRAL), { onFallback });
    expect(result.source).toBe("heuristic");
  });

  it("doesn't ask the qualifier when the heuristic is confident", async () => {
    const qualify = vi.fn(async () => ({
      answers: {},
      provider: "jev-http" as const,
      calibrated: true,
    }));
    const qualifier: Qualifier = { id: "jev-http", calibrated: true, qualify };
    expect(await runDecision(qualifier, endOfTurn, ctx("oi"))).toEqual({
      finished: heuristicFinished(ctx("oi")),
      source: "heuristic",
    });
    expect(await runDecision(qualifier, endOfTurn, ctx("tudo certo?"))).toEqual({
      finished: heuristicFinished(ctx("tudo certo?")),
      source: "heuristic",
    });
    expect(qualify).not.toHaveBeenCalled();
  });

  it("works with no qualifier configured", async () => {
    const result = await runDecision(null, endOfTurn, ctx(NEUTRAL));
    expect(result.source).toBe("heuristic");
  });
});
