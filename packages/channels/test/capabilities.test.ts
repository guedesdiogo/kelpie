import { describe, expect, it } from "vitest";
import { CAPABILITIES, typingRenewIntervalMs } from "../src/index.ts";

describe("channel capabilities", () => {
  it("records Telegram's limits from research note 06", () => {
    expect(CAPABILITIES.telegram).toMatchObject({
      maxMessageLength: 4096,
      typing: { supported: true, ttlMs: 5_000 },
      minGapMs: 1_000,
      formatting: "telegram-html",
    });
  });

  it("lets webchat send without a gap and keep typing until told otherwise", () => {
    expect(CAPABILITIES.webchat.minGapMs).toBe(0);
    expect(CAPABILITIES.webchat.typing).toEqual({ supported: true, ttlMs: null });
  });

  it("renews typing before the channel's indicator expires", () => {
    expect(typingRenewIntervalMs(CAPABILITIES.telegram)).toBe(4_000);
  });

  it("does not renew typing when the indicator never expires or is not supported", () => {
    expect(typingRenewIntervalMs(CAPABILITIES.webchat)).toBeNull();
    expect(
      typingRenewIntervalMs({
        ...CAPABILITIES.telegram,
        typing: { supported: false, ttlMs: null },
      }),
    ).toBeNull();
  });
});
