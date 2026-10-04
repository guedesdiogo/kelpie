import { CAPABILITIES } from "@kelpie/channels";
import { describe, expect, it } from "vitest";
import { planDelivery } from "../src/delivery.ts";

const reply = "First paragraph.\n\nSecond paragraph, a little longer than the first one.";

describe("planDelivery", () => {
  it("paces one bubble per paragraph in conversational mode", () => {
    const planned = planDelivery(reply, true, CAPABILITIES.telegram);

    expect(planned.map((bubble) => bubble.text)).toEqual([
      "First paragraph.",
      "Second paragraph, a little longer than the first one.",
    ]);
    // Typing time grows with length and never drops below the channel's gap.
    expect(planned[0]?.delayMs).toBeGreaterThanOrEqual(CAPABILITIES.telegram.minGapMs);
    expect(planned[1]?.delayMs).toBeGreaterThan(planned[0]?.delayMs ?? 0);
  });

  it("sends as few messages as possible, the first at once, when the mode is off", () => {
    expect(planDelivery(reply, false, CAPABILITIES.telegram)).toEqual([
      { text: reply, delayMs: 0 },
    ]);

    const long = "word ".repeat(1_000).trim();
    const planned = planDelivery(long, false, CAPABILITIES.telegram);
    expect(planned.length).toBeGreaterThan(1);
    expect(planned.map((bubble) => bubble.delayMs)).toEqual([
      0,
      ...planned.slice(1).map(() => CAPABILITIES.telegram.minGapMs),
    ]);
  });
});
