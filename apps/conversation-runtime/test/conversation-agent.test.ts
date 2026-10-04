import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationAgent } from "../src/conversation-agent.ts";
import { replacePortsForTesting } from "../src/ports.ts";
import {
  type FakeWorld,
  fail,
  fakeWorld,
  hang,
  refuse,
  reply,
  slowQualifier,
  truncate,
} from "./fakes.ts";

// The fake clock starts a minute ahead, so a flush schedule never comes due on its own: tests call
// flush() the way the schedule would, except the one that checks the schedule itself.
const agent = (name: string) => env.CONVERSATION_AGENT.getByName(name);
const destination = { channel: "telegram", threadId: "chat-1" } as const;

function message(id: string, text: string, userId = "u-owner") {
  return { providerMessageId: id, userId, text, destination };
}

const user = (text: string) => ({ role: "user", parts: [{ type: "text", text }] });
const neutral = (text: string) => ({ role: "assistant", parts: [{ type: "text", text }] });

function use(world: FakeWorld): FakeWorld {
  replacePortsForTesting(world.ports);
  return world;
}

async function statuses(stub: ReturnType<typeof agent>) {
  return (await stub.outbox()).map((row) => row.status);
}

afterEach(() => replacePortsForTesting(undefined));

describe("ConversationAgent buffering", () => {
  it("buffers messages and re-arms one flush on every new message", async () => {
    const world = use(fakeWorld([]));
    const stub = agent("rearm");
    const start = world.clock;

    // "…" looks unfinished, so the quiet window is the long one.
    expect(await stub.ingest(message("m1", "so I was thinking..."))).toEqual({
      status: "accepted",
      flushAt: start + 6_000,
    });
    // A question looks finished: the window shrinks, from the latest message.
    world.clock = start + 1_000;
    expect(await stub.ingest(message("m2", "can you check my order?"))).toEqual({
      status: "accepted",
      flushAt: start + 2_500,
    });
    const schedules = await runInDurableObject(stub, (instance: ConversationAgent) =>
      instance.getSchedules(),
    );
    expect(schedules).toHaveLength(1);
  });

  it("arms one schedule when messages arrive while the end-of-turn decision runs", async () => {
    const world = fakeWorld([]);
    use({ ...world, ports: { ...world.ports, qualifier: slowQualifier(50) } });
    const stub = agent("concurrent");

    await Promise.all([
      stub.ingest(message("m1", "so")),
      stub.ingest(message("m2", "is it done?")),
    ]);

    const schedules = await runInDurableObject(stub, (instance: ConversationAgent) =>
      instance.getSchedules(),
    );
    expect(schedules).toHaveLength(1);
  });

  it("ignores a flush from a schedule that a newer message replaced", async () => {
    use(fakeWorld([reply("Hi!")]));
    const stub = agent("stale-schedule");
    await stub.ingest(message("m1", "where is my order?"));

    await stub.flush({ epoch: 0 });
    expect(await stub.turns()).toEqual([]);
  });

  it("ignores a duplicate delivery", async () => {
    const world = use(fakeWorld([reply("Hi!")]));
    const stub = agent("dedupe");
    const start = world.clock;
    await stub.ingest(message("m1", "where is my order?"));

    expect(await stub.ingest(message("m1", "where is my order?"))).toEqual({
      status: "duplicate",
      flushAt: start + 1_500,
    });
    await stub.flush();
    await vi.waitFor(() => expect(world.sent).toEqual(["Hi!"]));
    expect(world.requests[0]?.messages).toEqual([user("where is my order?")]);
  });

  it("merges messages in arrival order, even within the same millisecond", async () => {
    const world = use(fakeWorld([reply("Ok.")]));
    const stub = agent("order");
    await stub.ingest(message("zz", "first"));
    await stub.ingest(message("aa", "second"));
    await stub.flush();

    await vi.waitFor(() => expect(world.requests).toHaveLength(1));
    expect(world.requests[0]?.messages).toEqual([user("first\nsecond")]);
  });

  it("keeps each author's messages apart", async () => {
    const world = use(fakeWorld([reply("Ok.")]));
    const stub = agent("authors");
    await stub.ingest(message("m1", "from one", "u-one"));
    await stub.ingest(message("m2", "from another", "u-two"));
    await stub.flush();

    await vi.waitFor(() => expect(world.requests).toHaveLength(1));
    expect(world.requests[0]?.messages).toEqual([user("from one"), user("from another")]);
  });

  it("refuses a message for another destination or one that is too long", async () => {
    use(fakeWorld([]));
    const stub = agent("refusals");
    await stub.ingest(message("m1", "hi?"));

    expect(
      await stub.ingest({
        ...message("m2", "hi?"),
        destination: { ...destination, threadId: "x" },
      }),
    ).toEqual({ status: "rejected", reason: "destination_mismatch" });
    expect(await stub.ingest(message("m3", "x".repeat(16_001)))).toEqual({
      status: "rejected",
      reason: "too_long",
    });
  });

  it("accepts only known settings with sane values", async () => {
    use(fakeWorld([]));
    const stub = agent("settings");

    expect(await stub.configure({ tier: "frontier", maxOutputTokens: 2_000 })).toMatchObject({
      ok: true,
      settings: { tier: "frontier", maxOutputTokens: 2_000 },
    });
    for (const bad of [{ tier: "gpt-9" }, { maxOutputTokens: -1 }, { surprise: true }, null]) {
      expect(await stub.configure(bad)).toEqual({ ok: false, reason: "invalid_settings" });
    }
  });

  it("flushes through the alarm when the schedule comes due", async () => {
    const world = use(fakeWorld([reply("On time.")]));
    world.clock = Date.now();
    const stub = agent("alarm");
    await stub.configure({ quietWindow: { finishedMs: 50, defaultMs: 50, unfinishedMs: 50 } });
    await stub.ingest(message("m1", "ping?"));

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    world.clock = Date.now();
    await runDurableObjectAlarm(stub);
    await vi.waitFor(() => expect(world.sent).toEqual(["On time."]));
  });
});

describe("ConversationAgent turns", () => {
  it("answers with paced bubbles and records the reply", async () => {
    const world = use(fakeWorld([reply("One.\n\nTwo.")]));
    const stub = agent("turn");
    await stub.ingest(message("m1", "so I was thinking..."));
    await stub.ingest(message("m2", "what do you suggest?"));
    await stub.flush();

    await vi.waitFor(() => expect(world.sent).toEqual(["One.", "Two."]));
    // Telegram shows "typing" before each bubble.
    expect(world.typing).toBe(2);
    expect(world.requests[0]).toMatchObject({
      system: expect.any(String),
      messages: [user("so I was thinking...\nwhat do you suggest?")],
    });
    await vi.waitFor(async () =>
      expect(await stub.history()).toEqual([
        user("so I was thinking...\nwhat do you suggest?"),
        { ...neutral("One.\n\nTwo."), native: expect.objectContaining({ provider: "anthropic" }) },
      ]),
    );
    expect(await statuses(stub)).toEqual(["sent", "sent"]);
  });

  it("answers each message at once, in one message, when conversational mode is off", async () => {
    const world = use(fakeWorld([reply("One.\n\nTwo.")]));
    const stub = agent("plain");
    await stub.configure({ conversational: false });

    expect(await stub.ingest(message("m1", "so I was thinking..."))).toEqual({
      status: "accepted",
      flushAt: null,
    });
    await vi.waitFor(() => expect(world.sent).toEqual(["One.\n\nTwo."]));
    expect(world.typing).toBe(0);
  });

  it("sends nothing when the model refuses", async () => {
    const world = use(fakeWorld([refuse()]));
    const stub = agent("refusal");
    await stub.ingest(message("m1", "something it won't do"));
    await stub.flush();

    await vi.waitFor(async () => expect(await stub.turns()).toMatchObject([{ status: "refused" }]));
    expect(world.sent).toEqual([]);
    expect(await stub.history()).toEqual([user("something it won't do")]);
  });

  it.each([
    ["the model call fails", "model-fails", fail()],
    ["the stream ends without a reply", "model-truncates", truncate()],
  ])("fails the turn when %s, and answers the next message", async (_label, name, script) => {
    const world = use(fakeWorld([script, reply("Back.")]));
    const stub = agent(name);
    await stub.ingest(message("m1", "first?"));
    await stub.flush();
    await vi.waitFor(async () => expect(await stub.turns()).toMatchObject([{ status: "failed" }]));
    expect(world.sent).toEqual([]);

    await stub.ingest(message("m2", "second?"));
    await stub.flush();
    await vi.waitFor(() => expect(world.sent).toEqual(["Back."]));
    expect(world.requests[1]?.messages).toEqual([user("first?"), user("second?")]);
  });

  it("fails the turn when a send fails, keeping what was already sent", async () => {
    const world = use(fakeWorld([reply("One.\n\nTwo.\n\nThree.")]));
    world.failSends.add(1);
    const stub = agent("send-fails");
    await stub.ingest(message("m1", "three things?"));
    await stub.flush();

    await vi.waitFor(async () => expect(await stub.turns()).toMatchObject([{ status: "failed" }]));
    expect(world.sent).toEqual(["One."]);
    expect(await statuses(stub)).toEqual(["sent", "cancelled", "cancelled"]);
    expect(await stub.history()).toEqual([user("three things?"), neutral("One.")]);
  });

  it("keeps delivering when 'typing' fails", async () => {
    const world = use(fakeWorld([reply("One.\n\nTwo.")]));
    world.failTyping = true;
    const stub = agent("typing-fails");
    await stub.ingest(message("m1", "two things?"));
    await stub.flush();

    await vi.waitFor(() => expect(world.sent).toEqual(["One.", "Two."]));
  });

  it("replays earlier replies without native output after the system prompt changes", async () => {
    const world = use(fakeWorld([reply("First."), reply("Second.")]));
    const stub = agent("prompt-change");
    await stub.ingest(message("m1", "one?"));
    await stub.flush();
    await vi.waitFor(() => expect(world.sent).toEqual(["First."]));

    await stub.configure({ systemPrompt: "You are terse." });
    await stub.ingest(message("m2", "two?"));
    await stub.flush();

    await vi.waitFor(() => expect(world.requests).toHaveLength(2));
    expect(world.requests[1]?.system).toBe("You are terse.");
    expect(world.requests[1]?.messages[1]).toEqual(neutral("First."));
  });

  it("records a reply under the prompt version it was produced with", async () => {
    const world = use(fakeWorld([reply("Done."), reply("Next.")]));
    world.blockSleeps.add(0);
    const stub = agent("prompt-mid-turn");
    await stub.ingest(message("m1", "anything?"));
    await stub.flush();
    await vi.waitFor(() => expect(world.requests).toHaveLength(1));

    // The prompt changes while the first reply waits to be delivered; then it is delivered.
    await stub.configure({ systemPrompt: "You are terse." });
    world.blockSleeps.clear();
    await stub.ingest(message("m2", "and now?"));
    await stub.flush();

    await vi.waitFor(() => expect(world.requests).toHaveLength(2));
    expect(world.requests[0]?.system).not.toBe("You are terse.");
    expect(world.requests[1]?.system).toBe("You are terse.");
  });
});

describe("ConversationAgent interruption", () => {
  it("cancels the model call when a new message arrives, and answers both together", async () => {
    const world = use(fakeWorld([hang(), reply("Got both.")]));
    const stub = agent("interrupt-model");
    await stub.ingest(message("m1", "first question?"));
    await stub.flush();
    await vi.waitFor(() => expect(world.requests).toHaveLength(1));

    await stub.ingest(message("m2", "and a second one?"));
    expect(world.cancelled).toBe(1);
    await stub.flush();

    await vi.waitFor(() => expect(world.sent).toEqual(["Got both."]));
    expect(world.requests[1]?.messages).toEqual([
      user("first question?"),
      user("and a second one?"),
    ]);
  });

  it("stops after the first bubble when interrupted, and keeps only what was sent", async () => {
    const world = use(fakeWorld([reply("One.\n\nTwo.\n\nThree."), reply("Okay.")]));
    world.blockSleeps.add(1);
    const stub = agent("interrupt-delivery");
    await stub.ingest(message("m1", "tell me three things?"));
    await stub.flush();
    await vi.waitFor(() => expect(world.sent).toEqual(["One."]));

    await stub.ingest(message("m2", "actually, stop"));
    expect(await statuses(stub)).toEqual(["sent", "cancelled", "cancelled"]);
    await stub.flush();

    await vi.waitFor(() => expect(world.sent).toEqual(["One.", "Okay."]));
    // The next turn sees exactly what the user saw, without the full reply's native output.
    expect(world.requests[1]?.messages).toEqual([
      user("tell me three things?"),
      neutral("One."),
      user("actually, stop"),
    ]);
  });

  it("counts a bubble caught mid-send as sent, and keeps history in order", async () => {
    const world = use(fakeWorld([reply("One.\n\nTwo.\n\nThree."), reply("Okay.")]));
    world.blockSends.add(1);
    const stub = agent("interrupt-send");
    await stub.ingest(message("m1", "three things?"));
    await stub.flush();
    await vi.waitFor(() => expect(world.sent).toEqual(["One."]));
    await vi.waitFor(async () =>
      expect(await statuses(stub)).toEqual(["sent", "sending", "pending"]),
    );

    await stub.ingest(message("m2", "wait"));
    await stub.flush();

    await vi.waitFor(() => expect(world.requests).toHaveLength(2));
    expect(world.requests[1]?.messages).toEqual([
      user("three things?"),
      neutral("One.\n\nTwo."),
      user("wait"),
    ]);
    // Let the old send finish: it must leave the settled turn untouched.
    world.blockSends.clear();
    await vi.waitFor(() => expect(world.sent).toContain("Two."));
    expect((await stub.turns()).map((turn) => turn.status)).toEqual(["interrupted", "delivered"]);
  });
});

describe("ConversationAgent recovery", () => {
  // A running fiber keeps a heartbeat alarm; when it fires on the new instance, recovery runs.

  it("resends only the pending bubbles after an eviction mid-delivery", async () => {
    const world = use(fakeWorld([reply("One.\n\nTwo.\n\nThree.")]));
    world.hangSends.add(1);
    const stub = agent("recover-delivery");
    await stub.ingest(message("m1", "three things?"));
    await stub.flush();
    await vi.waitFor(() => expect(world.sent).toEqual(["One."]));

    await evictDurableObject(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await vi.waitFor(() => expect(world.sent).toEqual(["One.", "Two.", "Three."]));
    await vi.waitFor(async () => expect(await statuses(stub)).toEqual(["sent", "sent", "sent"]));
  });

  it("calls the model again once when the eviction came before the reply", async () => {
    const world = use(fakeWorld([hang(), reply("Again.")]));
    const stub = agent("recover-call");
    await stub.ingest(message("m1", "anyone?"));
    await stub.flush();
    await vi.waitFor(() => expect(world.requests).toHaveLength(1));

    await evictDurableObject(stub);
    await runDurableObjectAlarm(stub);

    await vi.waitFor(() => expect(world.sent).toEqual(["Again."]));
    expect(await stub.turns()).toMatchObject([{ status: "delivered", attempts: 2 }]);
  });

  it("gives up after a second eviction before the reply", async () => {
    const world = use(fakeWorld([hang(), hang()]));
    const stub = agent("recover-give-up");
    await stub.ingest(message("m1", "anyone?"));
    await stub.flush();
    await vi.waitFor(() => expect(world.requests).toHaveLength(1));
    await evictDurableObject(stub);
    await runDurableObjectAlarm(stub);
    await vi.waitFor(() => expect(world.requests).toHaveLength(2));

    await evictDurableObject(stub);
    await runDurableObjectAlarm(stub);

    await vi.waitFor(async () => expect(await stub.turns()).toMatchObject([{ status: "failed" }]));
    expect(world.sent).toEqual([]);
  });
});
