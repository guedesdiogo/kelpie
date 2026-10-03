import { describe, expect, it } from "vitest";
import { type CanonicalEvent, dedupeKey } from "../src/index.ts";

const event = (overrides: Partial<CanonicalEvent> = {}): CanonicalEvent => ({
  agentId: "agent-1",
  channel: "telegram",
  threadId: "chat-100",
  sender: { channelUserId: "user-7" },
  providerMessageId: "42",
  providerTimestamp: 1_791_000_000_000,
  parts: [{ type: "text", text: "oi" }],
  ...overrides,
});

describe("dedupeKey", () => {
  it("is stable for the same provider message", () => {
    expect(dedupeKey(event())).toBe(dedupeKey(event()));
  });

  it("tells apart equal message ids in different threads", () => {
    // Telegram message ids are unique per chat, not globally.
    expect(dedupeKey(event({ threadId: "chat-100" }))).not.toBe(
      dedupeKey(event({ threadId: "chat-200" })),
    );
  });

  it("tells apart equal message ids on different channels", () => {
    expect(dedupeKey(event({ channel: "telegram" }))).not.toBe(
      dedupeKey(event({ channel: "webchat" })),
    );
  });
});
