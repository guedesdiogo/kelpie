import { describe, expect, it } from "vitest";
import { planFlush } from "../src/buffer.ts";

const settings = { conversational: true, quietMs: 10_000, maxWaitMs: 60_000 };
const at = (text: string, receivedAt: number) => ({ text, receivedAt });

describe("planFlush", () => {
  it("waits the same time after any message, whatever it says", () => {
    expect(planFlush([at("Can you check my order?", 100)], settings)).toBe(10_100);
    expect(planFlush([at("so I was thinking...", 100)], settings)).toBe(10_100);
  });

  it("starts the wait again with each new fragment", () => {
    const fragments = [at("so", 0), at("I was looking at the order page", 7_000)];
    expect(planFlush(fragments, settings)).toBe(17_000);
  });

  it("never waits past the cap counted from the first fragment", () => {
    const fragments = [at("so", 0), at("and then", 45_000), at("but", 55_000)];
    expect(planFlush(fragments, settings)).toBe(60_000);
  });

  it("counts the cap from a resume, when the owner paused the conversation", () => {
    const fragments = [at("so", 0), at("and the rest", 100_000)];
    expect(planFlush(fragments, settings, 100_000)).toBe(110_000);
    expect(planFlush(fragments, settings)).toBe(60_000);
  });

  it("flushes at once when conversational mode is off", () => {
    expect(
      planFlush([at("so I was thinking...", 100)], { ...settings, conversational: false }),
    ).toBe(100);
  });
});
