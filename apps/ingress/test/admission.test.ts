import { env } from "cloudflare:workers";
import type { CanonicalEvent } from "@kelpie/channels";
import { describe, expect, it } from "vitest";
import { admitSender, DIRECTORY_NAME } from "../src/admission.ts";

function event(channelUserId: string, agentId: string): CanonicalEvent {
  return {
    agentId,
    channel: "telegram",
    threadId: "chat-1",
    chatType: "direct",
    sender: { channelUserId },
    providerMessageId: "m-1",
    providerTimestamp: 0,
    parts: [{ type: "text", text: "oi" }],
  };
}

describe("admitSender", () => {
  it("looks the sender up in the Directory by channel identity and agent", async () => {
    await env.DIRECTORY.getByName(DIRECTORY_NAME).putUser({
      userId: "u-ana",
      version: 1,
      deleted: false,
      role: "member",
      identities: [{ channel: "telegram", channelUserId: "1001" }],
      agentIds: ["sales"],
    });

    expect(await admitSender(env, event("1001", "sales"))).toEqual({
      admitted: true,
      userId: "u-ana",
      role: "member",
    });
    expect(await admitSender(env, event("1001", "finance"))).toEqual({
      admitted: false,
      reason: "no_grant",
    });
    expect(await admitSender(env, event("9999", "sales"))).toEqual({
      admitted: false,
      reason: "unknown_identity",
    });
  });
});
