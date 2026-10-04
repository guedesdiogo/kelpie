import { env } from "cloudflare:workers";
import type { CanonicalEvent } from "@kelpie/channels";
import { describe, expect, it } from "vitest";
import { admitSender, DIRECTORY_NAME } from "../src/admission.ts";

function event(channelUserId: string, chatType: "direct" | "group" = "direct"): CanonicalEvent {
  return {
    agentId: "sales",
    channel: "telegram",
    threadId: "chat-1",
    chatType,
    sender: { channelUserId },
    providerMessageId: "m-1",
    providerTimestamp: 0,
    parts: [{ type: "text", text: "oi" }],
  };
}

describe("admitSender", () => {
  it("admits the owner in a direct conversation and drops everything else", async () => {
    const stub = env.DIRECTORY.getByName(DIRECTORY_NAME);
    await stub.registerOwner("u-owner");
    await stub.addIdentity({ channel: "telegram", channelUserId: "1001" });
    await stub.enableIdentity({ channel: "telegram", channelUserId: "1001" });

    expect(await admitSender(env, event("1001"))).toEqual({
      admitted: true,
      userId: "u-owner",
      role: "owner",
    });
    expect(await admitSender(env, event("9999"))).toEqual({
      admitted: false,
      reason: "unknown_identity",
    });
    // Phase 1 ignores group chats, even the owner's (ADR-0015).
    expect(await admitSender(env, event("1001", "group"))).toEqual({
      admitted: false,
      reason: "group_chat",
    });
  });
});
