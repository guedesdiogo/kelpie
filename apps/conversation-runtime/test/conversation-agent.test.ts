import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationAgent } from "../src/conversation-agent.ts";
import { replacePortsForTesting } from "../src/ports.ts";
import { type FakeWorld, fakeWorld, hang, refuse, reply } from "./fakes.ts";

// Times are offsets from "now" a minute ahead, so a flush schedule never fires on its own; tests
// call flush() the way the schedule would, except the one that checks the schedule itself.
const t0 = () => Date.now() + 60_000;
const agent = (name: string) => env.CONVERSATION_AGENT.getByName(name);
const destination = { channel: "telegram", threadId: "chat-1" } as const;

function message(id: string, text: string) {
  return { providerMessageId: id, userId: "u-owner", text, destination };
}

function use(world: FakeWorld): FakeWorld {
  replacePortsForTesting(world.ports);
  return world;
}

afterEach(() => replacePortsForTesting(undefined));

describe("ConversationAgent", () => {
  it("buffers messages and re-arms one flush on every new message", async () => {
    use(fakeWorld([]));
    const stub = agent("rearm");
    const start = t0();

    // "…" looks unfinished, so the quiet window is the long one.
    expect(await stub.ingest(message("m1", "so I was thinking..."), start)).toEqual({
      duplicate: false,
      flushAt: start + 6_000,
    });
    // A question looks finished: the window shrinks, from the latest message.
    expect(await stub.ingest(message("m2", "can you check my order?"), start + 1_000)).toEqual({
      duplicate: false,
      flushAt: start + 2_500,
    });
    const schedules = await runInDurableObject(stub, (instance: ConversationAgent) =>
      instance.getSchedules(),
    );
    expect(schedules).toHaveLength(1);
  });

  it("ignores a duplicate delivery", async () => {
    const world = use(fakeWorld([reply("Hi!")]));
    const stub = agent("dedupe");
    const start = t0();
    await stub.ingest(message("m1", "where is my order?"), start);

    expect(await stub.ingest(message("m1", "where is my order?"), start + 10)).toEqual({
      duplicate: true,
      flushAt: start + 1_500,
    });
    await stub.flush();
    await vi.waitFor(() => expect(world.sent).toEqual(["Hi!"]));
    expect(world.requests[0]?.messages).toEqual([
      { role: "user", parts: [{ type: "text", text: "where is my order?" }] },
    ]);
  });

  it("answers a turn with paced bubbles and records the reply", async () => {
    const world = use(fakeWorld([reply("One.\n\nTwo.")]));
    const stub = agent("turn");
    await stub.ingest(message("m1", "so I was thinking..."), t0());
    await stub.ingest(message("m2", "what do you suggest?"), t0());
    await stub.flush();

    await vi.waitFor(() => expect(world.sent).toEqual(["One.", "Two."]));
    // Telegram shows "typing" before each bubble.
    expect(world.typing).toBe(2);
    expect(world.requests[0]).toMatchObject({
      system: expect.any(String),
      messages: [
        {
          role: "user",
          parts: [{ type: "text", text: "so I was thinking...\nwhat do you suggest?" }],
        },
      ],
    });
    await vi.waitFor(async () =>
      expect(await stub.history()).toEqual([
        world.requests[0]?.messages[0],
        {
          role: "assistant",
          parts: [{ type: "text", text: "One.\n\nTwo." }],
          native: expect.objectContaining({ provider: "anthropic" }),
        },
      ]),
    );
    expect((await stub.outbox()).map((row) => row.status)).toEqual(["sent", "sent"]);
  });

  it("answers each message at once, in one message, when conversational mode is off", async () => {
    const world = use(fakeWorld([reply("One.\n\nTwo.")]));
    const stub = agent("plain");
    await stub.configure({ conversational: false });

    expect(await stub.ingest(message("m1", "so I was thinking..."), t0())).toMatchObject({
      flushAt: null,
    });
    await vi.waitFor(() => expect(world.sent).toEqual(["One.\n\nTwo."]));
    expect(world.typing).toBe(0);
  });

  it("cancels the model call when a new message arrives, and answers both together", async () => {
    const world = use(fakeWorld([hang(), reply("Got both.")]));
    const stub = agent("interrupt-model");
    await stub.ingest(message("m1", "first question?"), t0());
    await stub.flush();
    await vi.waitFor(() => expect(world.requests).toHaveLength(1));

    await stub.ingest(message("m2", "and a second one?"), t0());
    await vi.waitFor(() => expect(world.cancelled).toBe(1));
    await stub.flush();

    await vi.waitFor(() => expect(world.sent).toEqual(["Got both."]));
    expect(world.requests[1]?.messages).toEqual([
      { role: "user", parts: [{ type: "text", text: "first question?" }] },
      { role: "user", parts: [{ type: "text", text: "and a second one?" }] },
    ]);
  });

  it("stops after the first bubble when interrupted, and keeps only what was sent", async () => {
    const world = use(fakeWorld([reply("One.\n\nTwo.\n\nThree."), reply("Okay.")]));
    world.blockSleeps.add(1);
    const stub = agent("interrupt-delivery");
    await stub.ingest(message("m1", "tell me three things?"), t0());
    await stub.flush();
    await vi.waitFor(() => expect(world.sent).toEqual(["One."]));

    await stub.ingest(message("m2", "actually, stop"), t0());
    await vi.waitFor(async () =>
      expect((await stub.outbox()).map((row) => row.status)).toEqual([
        "sent",
        "cancelled",
        "cancelled",
      ]),
    );
    await stub.flush();

    await vi.waitFor(() => expect(world.sent).toEqual(["One.", "Okay."]));
    // The next turn sees exactly what the user saw, without the native output of the full reply.
    expect(world.requests[1]?.messages).toEqual([
      { role: "user", parts: [{ type: "text", text: "tell me three things?" }] },
      { role: "assistant", parts: [{ type: "text", text: "One." }] },
      { role: "user", parts: [{ type: "text", text: "actually, stop" }] },
    ]);
  });

  it("sends nothing when the model refuses", async () => {
    const world = use(fakeWorld([refuse()]));
    const stub = agent("refusal");
    await stub.ingest(message("m1", "something it won't do"), t0());
    await stub.flush();

    await vi.waitFor(() => expect(world.requests).toHaveLength(1));
    await vi.waitFor(async () => expect(await stub.history()).toHaveLength(1));
    expect(world.sent).toEqual([]);
  });

  it("resends only the pending bubbles after an eviction mid-delivery", async () => {
    const world = use(fakeWorld([reply("One.\n\nTwo.\n\nThree.")]));
    world.blockSends.add(1);
    const stub = agent("recovery");
    await stub.ingest(message("m1", "three things?"), t0());
    await stub.flush();
    await vi.waitFor(() => expect(world.sent).toEqual(["One."]));

    await evictDurableObject(stub);
    world.blockSends.clear();
    // A running fiber keeps a heartbeat alarm; when it fires on the new instance, recovery runs.
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await vi.waitFor(() => expect(world.sent).toEqual(["One.", "Two.", "Three."]));
    await vi.waitFor(async () =>
      expect((await stub.outbox()).map((row) => row.status)).toEqual(["sent", "sent", "sent"]),
    );
  });

  it("replays earlier replies without native output after the system prompt changes", async () => {
    const world = use(fakeWorld([reply("First."), reply("Second.")]));
    const stub = agent("prompt-change");
    await stub.ingest(message("m1", "one?"), t0());
    await stub.flush();
    await vi.waitFor(() => expect(world.sent).toEqual(["First."]));

    await stub.configure({ systemPrompt: "You are terse." });
    await stub.ingest(message("m2", "two?"), t0());
    await stub.flush();

    await vi.waitFor(() => expect(world.requests).toHaveLength(2));
    expect(world.requests[1]?.system).toBe("You are terse.");
    expect(world.requests[1]?.messages[1]).toEqual({
      role: "assistant",
      parts: [{ type: "text", text: "First." }],
    });
  });

  it("flushes through the alarm when the schedule comes due", async () => {
    const world = use(fakeWorld([reply("On time.")]));
    const stub = agent("alarm");
    await stub.configure({
      quietWindow: { finishedMs: 50, defaultMs: 50, unfinishedMs: 50 },
    });
    await stub.ingest(message("m1", "ping?"));

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await runDurableObjectAlarm(stub);
    await vi.waitFor(() => expect(world.sent).toEqual(["On time."]));
  });
});
