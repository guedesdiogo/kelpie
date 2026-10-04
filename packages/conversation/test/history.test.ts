import type { AssistantMessage } from "@kelpie/llm";
import { describe, expect, it } from "vitest";
import { deliveredReply } from "../src/history.ts";

const reply: AssistantMessage = {
  role: "assistant",
  parts: [{ type: "text", text: "One.\n\nTwo.\n\nThree." }],
  native: { provider: "anthropic", model: "claude-haiku-4-5", content: [{ type: "text" }] },
};
const bubbles = ["One.", "Two.", "Three."];

describe("deliveredReply", () => {
  it("keeps the whole reply, native output included, when every bubble went out", () => {
    expect(deliveredReply(reply, bubbles, 3)).toBe(reply);
  });

  it("keeps only what was sent, as neutral text, when delivery was cut short", () => {
    expect(deliveredReply(reply, bubbles, 2)).toEqual({
      role: "assistant",
      parts: [{ type: "text", text: "One.\n\nTwo." }],
    });
  });

  it("keeps nothing when no bubble went out", () => {
    expect(deliveredReply(reply, bubbles, 0)).toBeNull();
  });
});
