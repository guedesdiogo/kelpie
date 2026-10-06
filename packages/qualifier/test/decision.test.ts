import { describe, expect, it, vi } from "vitest";
import { type Decision, FakeQualifier, type Qualifier, runDecision } from "../src/index.ts";

// runDecision with a decision of the tests' own: is a support message urgent? A leading "!" is
// the deterministic shortcut, and an unknown answer falls back to 0.5.
interface Ticket {
  text: string;
}

const urgent: Decision<Ticket, { urgent: number }> = {
  id: "ticket.urgent",
  version: "1",
  timeoutMs: 800,
  shortcut: ({ text }) => (text.startsWith("!") ? { urgent: 1 } : null),
  state: ({ text }) => ({ text }),
  questions: () => ({ urgent: { type: "noul", instructions: "Is this message urgent?" } }),
  policy: ({ answers }) => {
    const answer = answers.urgent;
    return answer?.type === "noul" && answer.noul >= 0 && answer.noul <= 1
      ? { urgent: answer.noul }
      : null;
  },
  fallback: () => ({ urgent: 0.5 }),
};

const ticket = (text: string): Ticket => ({ text });
const KEY = "ticket.urgent::urgent";
const FALLBACK = { urgent: 0.5, source: "heuristic" };
const slowQualifier = (seen?: (signal: { aborted: boolean } | undefined) => void): Qualifier => ({
  id: "fake",
  calibrated: true,
  qualify: (_state, _questions, options) => {
    seen?.(options?.signal);
    return new Promise<never>(() => {});
  },
});

describe("runDecision", () => {
  it("uses the qualifier's answer, under the decision's prefixed key", async () => {
    const qualifier = new FakeQualifier({ [KEY]: { type: "noul", noul: 0.95 } });
    expect(await runDecision(qualifier, urgent, ticket("the site is down"))).toEqual({
      urgent: 0.95,
      source: "fake",
    });
  });

  it("falls back when the qualifier fails", async () => {
    const qualify = vi.fn(async () => {
      throw new Error("rate limited");
    });
    const failing: Qualifier = { id: "jev-http", calibrated: true, qualify };
    expect(await runDecision(failing, urgent, ticket("the site is down"))).toEqual(FALLBACK);
    expect(qualify).toHaveBeenCalledTimes(1);
  });

  it("falls back when the qualifier is too slow, and aborts its call", async () => {
    let signal: { aborted: boolean } | undefined;
    const onFallback = vi.fn();
    const result = await runDecision(
      slowQualifier((seen) => {
        signal = seen;
      }),
      { ...urgent, timeoutMs: 20 },
      ticket("the site is down"),
      { onFallback },
    );
    expect(result).toEqual(FALLBACK);
    expect(String(onFallback.mock.calls[0]?.[1])).toContain("timed out");
    expect(signal?.aborted).toBe(true);
  });

  it("falls back when building the questions throws", async () => {
    const broken = {
      ...urgent,
      questions: () => {
        throw new Error("bad context");
      },
    };
    expect(await runDecision(new FakeQualifier({}), broken, ticket("x"))).toEqual(FALLBACK);
  });

  it("rejects an answer the policy declines, and reports it", async () => {
    const qualifier = new FakeQualifier({ [KEY]: { type: "noul", noul: 7 } });
    const onFallback = vi.fn();
    expect(await runDecision(qualifier, urgent, ticket("x"), { onFallback })).toEqual(FALLBACK);
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it("reports nothing when the qualifier answers", async () => {
    const qualifier = new FakeQualifier({ [KEY]: { type: "noul", noul: 0.4 } });
    const onFallback = vi.fn();
    await runDecision(qualifier, urgent, ticket("x"), { onFallback });
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("survives a throwing fallback hook", async () => {
    const onFallback = () => {
      throw new Error("logger down");
    };
    expect(await runDecision(new FakeQualifier({}), urgent, ticket("x"), { onFallback })).toEqual(
      FALLBACK,
    );
  });

  it("doesn't ask the qualifier when the shortcut decides", async () => {
    const qualify = vi.fn(async () => ({
      answers: {},
      provider: "fake" as const,
      calibrated: true,
    }));
    const qualifier: Qualifier = { id: "fake", calibrated: true, qualify };
    expect(await runDecision(qualifier, urgent, ticket("!down"))).toEqual({
      urgent: 1,
      source: "heuristic",
    });
    expect(qualify).not.toHaveBeenCalled();
  });

  it("works with no qualifier configured", async () => {
    expect(await runDecision(null, urgent, ticket("x"))).toEqual(FALLBACK);
  });
});
