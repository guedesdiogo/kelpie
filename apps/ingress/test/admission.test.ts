import { env } from "cloudflare:workers";
import { DIRECTORY_NAME } from "@kelpie/access";
import type { CanonicalEvent } from "@kelpie/channels";
import { describe, expect, it } from "vitest";
import { admitSender } from "../src/admission.ts";

function event(channelUserId: string, chatType: string = "direct"): CanonicalEvent {
  return {
    agentId: "sales",
    channel: "telegram",
    threadId: "chat-1",
    chatType: chatType as CanonicalEvent["chatType"],
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
    await stub.addIdentity("u-owner", { channel: "telegram", channelUserId: "1001" });
    await stub.enableIdentity({ channel: "telegram", channelUserId: "1001" });
    await stub.addIdentity("u-owner", { channel: "telegram", channelUserId: "1002" });

    expect(await admitSender(env, event("1001"))).toEqual({
      admitted: true,
      userId: "u-owner",
      role: "owner",
    });
    expect(await admitSender(env, event("9999"))).toEqual({
      admitted: false,
      reason: "unknown_identity",
    });
    // A pending identity hasn't been paired yet.
    expect(await admitSender(env, event("1002"))).toEqual({
      admitted: false,
      reason: "unknown_identity",
    });
    // Only direct conversations until multi-user lands (ADR-0015), whatever else a channel reports.
    for (const chatType of ["group", "supergroup"]) {
      expect(await admitSender(env, event("1001", chatType))).toEqual({
        admitted: false,
        reason: "group_chat",
      });
    }
  });
});
