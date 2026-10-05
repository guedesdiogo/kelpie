import { FakeQualifier, type Qualifier } from "@kelpie/qualifier";
import { describe, expect, it, vi } from "vitest";
import { planFlush } from "../src/buffer.ts";

const settings = {
  conversational: true,
  quietWindow: { finishedMs: 1_000, defaultMs: 3_000, unfinishedMs: 6_000 },
  maxWaitMs: 10_000,
};
const at = (text: string, receivedAt: number) => ({ text, receivedAt });
/** The heuristic can't tell (0.5), so the qualifier is asked. */
const UNSURE = "I was looking at the order page";
const jevAnswering = (noul: number) => {
  const qualify = vi.fn(async () => ({
    answers: { "turn.end::user_finished": { type: "noul" as const, noul } },
    provider: "jev-http" as const,
    calibrated: true,
  }));
  return { id: "jev-http", calibrated: true, qualify } satisfies Qualifier;
};

describe("planFlush", () => {
  it("waits briefly after a message that looks finished", async () => {
    expect(await planFlush([at("Can you check my order?", 100)], settings, null)).toBe(1_100);
  });

  it("waits longer when the user seems to be mid-thought", async () => {
    expect(await planFlush([at("so I was thinking...", 100)], settings, null)).toBe(6_100);
  });

  it("never waits past the cap counted from the first fragment", async () => {
    const fragments = [at("so", 0), at("and then", 8_000), at("but", 9_500)];
    expect(await planFlush(fragments, settings, null)).toBe(10_000);
  });

  it("uses the qualifier's answer when one is configured", async () => {
    const qualifier = new FakeQualifier({
      "turn.end::user_finished": { type: "noul", noul: 0.95 },
    });
    expect(await planFlush([at(UNSURE, 100)], settings, qualifier)).toBe(1_100);
  });

  it("reads Jev's answer with Jev's bands", async () => {
    // 0.72 is the default wait at the heuristic's bands, but a fast close at Jev's (ADR-0018).
    expect(await planFlush([at(UNSURE, 100)], settings, jevAnswering(0.72))).toBe(1_100);
    expect(await planFlush([at(UNSURE, 100)], settings, jevAnswering(0.38))).toBe(6_100);
  });

  it("doesn't ask the qualifier when the heuristic is sure", async () => {
    const qualifier = jevAnswering(0.1);
    expect(await planFlush([at("Can you check my order?", 100)], settings, qualifier)).toBe(1_100);
    expect(qualifier.qualify).not.toHaveBeenCalled();
  });

  it("reports who decided, the probability and how long it took", async () => {
    const onDecided = vi.fn();
    await planFlush([at(UNSURE, 100)], settings, jevAnswering(0.72), { onDecided });
    expect(onDecided).toHaveBeenCalledWith({
      source: "jev-http",
      finished: 0.72,
      ms: expect.any(Number),
    });
  });

  it("flushes at once when conversational mode is off", async () => {
    expect(
      await planFlush(
        [at("so I was thinking...", 100)],
        { ...settings, conversational: false },
        null,
      ),
    ).toBe(100);
  });
});
