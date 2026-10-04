import { FakeQualifier } from "@kelpie/qualifier";
import { describe, expect, it } from "vitest";
import { planFlush } from "../src/buffer.ts";

const settings = {
  conversational: true,
  quietWindow: { finishedMs: 1_000, defaultMs: 3_000, unfinishedMs: 6_000 },
  maxWaitMs: 10_000,
};
const at = (text: string, receivedAt: number) => ({ text, receivedAt });

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
    expect(await planFlush([at("so I was thinking...", 100)], settings, qualifier)).toBe(1_100);
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
