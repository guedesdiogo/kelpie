import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationAgent } from "../src/conversation-agent.ts";
import { PAUSED_TEXT } from "../src/conversation-agent.ts";
import { replacePortsForTesting } from "../src/ports.ts";
import { type FakeWorld, fakeWorld, hang, reply } from "./fakes.ts";

// Pausing a conversation (issue #134): nothing is answered until the owner's next message, which
// is answered together with what was buffered.

const agent = (name: string) => env.CONVERSATION_AGENT.getByName(name);
const destination = { channel: "telegram", threadId: "chat-1" } as const;
const target = { agentId: "assistant", destination };
const SENT_AT = Date.UTC(2026, 9, 4, 2, 30);

function message(id: string, text: string) {
  return {
    agentId: "assistant",
    providerMessageId: id,
    userId: "u-owner",
    text,
    destination,
    sentAt: SENT_AT,
    timeZone: null,
  };
}

const flushes = (name: string) =>
  runInDurableObject(agent(name), (instance: ConversationAgent) =>
    instance.getSchedules().filter((schedule) => schedule.callback === "flush"),
  );

function use(world: FakeWorld): FakeWorld {
  replacePortsForTesting(world.ports);
  return world;
}

afterEach(() => {
  replacePortsForTesting(undefined);
});

describe("pausing a conversation", () => {
  it("cancels the planned answer, confirms it, and answers nothing while paused", async () => {
    const world = use(fakeWorld([reply("Never.")]));
    const stub = agent("pause-buffer");
    await stub.ingest(message("m1", "so"));
    expect(await flushes("pause-buffer")).toHaveLength(1);

    expect(await stub.pause(target)).toEqual({ status: "paused" });
    expect(await flushes("pause-buffer")).toEqual([]);
    expect(world.sent).toEqual([PAUSED_TEXT]);

    await stub.flush();
    expect(await stub.turns()).toEqual([]);
  });

  it("interrupts the turn in flight and cancels its model call", async () => {
    const world = use(fakeWorld([hang()]));
    const stub = agent("pause-running");
    await stub.ingest(message("m1", "what's the status?"));
    await stub.flush();
    await vi.waitFor(async () => expect(await stub.turns()).toMatchObject([{ status: "running" }]));

    await stub.pause(target);
    expect(await stub.turns()).toMatchObject([{ status: "interrupted" }]);
    await vi.waitFor(() => expect(world.cancelled).toBe(1));
  });

  it("answers the next message together with the buffered ones, after the normal wait", async () => {
    const world = use(fakeWorld([reply("Both, then.")]));
    const stub = agent("pause-resume");
    const start = world.clock;
    await stub.ingest(message("m1", "so"));
    await stub.pause(target);

    // Long after the cap would have passed: the wait and the cap count from the resume.
    world.clock = start + 100_000;
    expect(await stub.ingest(message("m2", "and the rest"))).toEqual({
      status: "accepted",
      flushAt: start + 110_000,
    });
    await stub.flush();
    await vi.waitFor(() => expect(world.sent).toEqual([PAUSED_TEXT, "Both, then."]));
    const asked = JSON.stringify(world.requests[0]?.messages);
    expect(asked).toContain("so");
    expect(asked).toContain("and the rest");
    expect(world.requests[0]?.messages).toHaveLength(1);
  });

  it("holds the first message when the pause comes before any", async () => {
    const world = use(fakeWorld([]));
    const stub = agent("pause-first");
    expect(await stub.pause(target)).toEqual({ status: "paused" });
    expect(await stub.ingest(message("m1", "now"))).toEqual({
      status: "accepted",
      flushAt: world.clock + 10_000,
    });
  });

  it("refuses a pause for another conversation", async () => {
    use(fakeWorld([]));
    const stub = agent("pause-other");
    await stub.ingest(message("m1", "so"));
    expect(
      await stub.pause({
        agentId: "assistant",
        destination: { channel: "telegram", threadId: "x" },
      }),
    ).toEqual({ status: "rejected", reason: "destination_mismatch" });
    expect(await stub.pause({ agentId: "other", destination })).toEqual({
      status: "rejected",
      reason: "agent_mismatch",
    });
    expect(await flushes("pause-other")).toHaveLength(1);
  });
});
