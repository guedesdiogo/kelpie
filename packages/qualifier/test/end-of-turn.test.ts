import { describe, expect, it, vi } from "vitest";
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

  it.each([
    ["fechado então", "an agreement closed with 'então'"],
    ["fechado então 🤝", "the same, with an emoji"],
    ["beleza então", "an acknowledgement closed with 'então'"],
    ["ok então", "a short acknowledgement closed with 'então'"],
    ["blz entao", "the same, written without the accent"],
  ])("leans finished for %s (%s)", (text) => {
    expect(heuristicFinished(ctx(text))).toBeGreaterThanOrEqual(0.8);
  });

  it.each([
    ["e então", "'então' after a connective"],
    ["eu queria saber então", "'então' after content that is still open"],
  ])("still leans unfinished for %s (%s)", (text) => {
    expect(heuristicFinished(ctx(text))).toBeLessThanOrEqual(0.3);
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

  it("falls back when building the questions throws", async () => {
    const broken = {
      ...endOfTurn,
      questions: () => {
        throw new Error("bad context");
      },
    };
    const qualifier = new FakeQualifier({});
    expect(await runDecision(qualifier, broken, ctx("tudo certo?"))).toEqual({
      finished: heuristicFinished(ctx("tudo certo?")),
      source: "heuristic",
    });
  });

  it("rejects an answer outside 0 to 1 and falls back", async () => {
    const qualifier = new FakeQualifier({ "turn.end::user_finished": { type: "noul", noul: 7 } });
    const onFallback = vi.fn();
    const result = await runDecision(qualifier, endOfTurn, ctx("oi"), { onFallback });
    expect(result.source).toBe("heuristic");
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it("reports nothing when the qualifier answers", async () => {
    const qualifier = new FakeQualifier({ "turn.end::user_finished": { type: "noul", noul: 0.4 } });
    const onFallback = vi.fn();
    await runDecision(qualifier, endOfTurn, ctx("oi"), { onFallback });
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
    await runDecision(slow, { ...endOfTurn, timeoutMs: 20 }, ctx("oi"), { onFallback });
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(String(onFallback.mock.calls[0]?.[1])).toContain("timed out");
    expect(signal?.aborted).toBe(true);
  });

  it("survives a throwing fallback hook", async () => {
    const qualifier = new FakeQualifier({});
    const onFallback = () => {
      throw new Error("logger down");
    };
    const result = await runDecision(qualifier, endOfTurn, ctx("oi"), { onFallback });
    expect(result.source).toBe("heuristic");
  });

  it("works with no qualifier configured", async () => {
    const result = await runDecision(null, endOfTurn, ctx("tudo certo?"));
    expect(result.source).toBe("heuristic");
  });
});
