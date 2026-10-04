import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { AgentSettings } from "@kelpie/config";
import { stampOf } from "@kelpie/conversation";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHost } from "../src/agent-host/agent-host.ts";
import type { ConversationAgent } from "../src/conversation-agent.ts";
import { replacePortsForTesting } from "../src/ports.ts";
import {
  type FakeWorld,
  fail,
  fakeWorld,
  hang,
  INJECTED_FAILURE,
  refuse,
  reply,
  slowQualifier,
  truncate,
} from "./fakes.ts";

// The fake clock starts a minute ahead, so a flush schedule never comes due on its own: tests call
// flush() the way the schedule would, except the one that checks the schedule itself.
const agent = (name: string) => env.CONVERSATION_AGENT.getByName(name);
const destination = { channel: "telegram", threadId: "chat-1" } as const;
const owner = { userId: "u-owner", role: "owner", via: "test" } as const;

/** 02:30 UTC on Sunday 4 October 2026, still Saturday evening in São Paulo. */
const SENT_AT = Date.UTC(2026, 9, 4, 2, 30);
/** What a message sent at SENT_AT by a user with no time zone is stamped with. */
const STAMP = "[Sun 4 Oct 2026, 02:30, UTC]";

/** Tests that change settings use an agent of their own, named after the conversation. */
function message(
  id: string,
  text: string,
  {
    userId = "u-owner",
    agentId = "assistant",
    sentAt = SENT_AT,
    timeZone = null as string | null,
  } = {},
) {
  return { agentId, providerMessageId: id, userId, text, destination, sentAt, timeZone };
}

async function configure(agentId: string, changes: Partial<AgentSettings>) {
  expect(await env.AGENT_HOST.getByName(agentId).configure(changes, owner)).toMatchObject({
    ok: true,
  });
}

/** A user message as history holds it: stamped, since tests send at SENT_AT with no zone. */
const user = (text: string) => ({
  role: "user",
  parts: [{ type: "text", text: `${STAMP} ${text}` }],
});
const neutral = (text: string) => ({ role: "assistant", parts: [{ type: "text", text }] });

function use(world: FakeWorld): FakeWorld {
  replacePortsForTesting(world.ports);
  return world;
}

async function statuses(stub: ReturnType<typeof agent>) {
  return (await stub.outbox()).map((row) => row.status);
}

afterEach(() => {
  replacePortsForTesting(undefined);
  vi.restoreAllMocks();
});

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
    await stub.ingest(message("m1", "from one", { userId: "u-one" }));
    await stub.ingest(message("m2", "from another", { userId: "u-two" }));
    await stub.flush();

    await vi.waitFor(() => expect(world.requests).toHaveLength(1));
    expect(world.requests[0]?.messages).toEqual([user("from one"), user("from another")]);
  });

  it("refuses a message for another destination, another agent, or one that is too long", async () => {
    use(fakeWorld([]));
    const stub = agent("refusals");
    await stub.ingest(message("m1", "hi?"));

    expect(
      await stub.ingest({
        ...message("m2", "hi?"),
        destination: { ...destination, threadId: "x" },
      }),
    ).toEqual({ status: "rejected", reason: "destination_mismatch" });
    expect(await stub.ingest(message("m3", "hi?", { agentId: "someone-else" }))).toEqual({
      status: "rejected",
      reason: "agent_mismatch",
    });
    expect(await stub.ingest(message("m4", "x".repeat(16_001)))).toEqual({
      status: "rejected",
      reason: "too_long",
    });
  });

  it("flushes through the alarm when the schedule comes due", async () => {
    const world = use(fakeWorld([reply("On time.")]));
    world.clock = Date.now();
    const stub = agent("alarm");
    await configure("alarm", { quietWindow: { finishedMs: 50, defaultMs: 50, unfinishedMs: 50 } });
    await stub.ingest(message("m1", "ping?", { agentId: "alarm" }));

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    world.clock = Date.now();
    await runDurableObjectAlarm(stub);
    await vi.waitFor(() => expect(world.sent).toEqual(["On time."]));
  });

  it("answers a message that arrives while a flush reads the settings", async () => {
    const world = use(fakeWorld([reply("Both."), reply("The rest.")]));
    const stub = agent("flush-race");
    await stub.ingest(message("m1", "first part"));

    await Promise.all([stub.flush(), stub.ingest(message("m2", "second part"))]);
    const schedules = await runInDurableObject(stub, (instance: ConversationAgent) =>
      instance.getSchedules(),
    );
    expect(schedules.length).toBeLessThanOrEqual(1);
    await stub.flush();

    // Whichever way the two calls interleaved, history holds each message once, and the last turn,
    // which saw both, was delivered.
    await vi.waitFor(async () => expect((await stub.turns()).at(-1)?.status).toBe("delivered"));
    const history = JSON.stringify(await stub.history());
    expect(history.match(/first part/g)).toHaveLength(1);
    expect(history.match(/second part/g)).toHaveLength(1);
    const lastRequest = JSON.stringify(world.requests.at(-1)?.messages);
    expect(lastRequest).toContain("first part");
    expect(lastRequest).toContain("second part");
  });

  it("starts one turn when two flushes race, and doesn't interrupt it", async () => {
    const world = use(fakeWorld([reply("Once."), reply("Twice.")]));
    world.blockSends.add(0);
    const stub = agent("double-flush");
    await stub.ingest(message("m1", "anyone there?"));
    // The second flush gets the settings only after the first one started its turn.
    const config = AgentHost.prototype.config;
    let calls = 0;
    vi.spyOn(AgentHost.prototype, "config").mockImplementation(async function (this: AgentHost) {
      calls += 1;
      if (calls === 2) await new Promise((resolve) => setTimeout(resolve, 50));
      return config.call(this);
    } as unknown as typeof config);

    await Promise.all([stub.flush(), stub.flush()]);
    expect(await stub.turns()).toMatchObject([{ status: "running" }]);

    world.blockSends.delete(0);
    await vi.waitFor(async () =>
      expect(await stub.turns()).toMatchObject([{ status: "delivered" }]),
    );
    expect(world.sent).toEqual(["Once."]);
  });

  it("plans the flush again when the provider retries a message whose planning failed", async () => {
    const world = use(fakeWorld([reply("Got it.")]));
    const stub = agent("plan-fails");
    vi.spyOn(AgentHost.prototype, "config").mockImplementationOnce(() => {
      throw new Error(INJECTED_FAILURE);
    });

    await expect(stub.ingest(message("m1", "are you there?"))).rejects.toThrow();
    // The provider retries the same message: without planning again, nothing would answer it.
    const retried = await stub.ingest(message("m1", "are you there?"));
    expect(retried).toMatchObject({ status: "duplicate", flushAt: expect.any(Number) });

    await stub.flush();
    await vi.waitFor(() => expect(world.sent).toEqual(["Got it."]));
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
    await configure("plain", { conversational: false });

    expect(await stub.ingest(message("m1", "so I was thinking...", { agentId: "plain" }))).toEqual({
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
    await stub.ingest(message("m1", "one?", { agentId: "prompt-change" }));
    await stub.flush();
    await vi.waitFor(() => expect(world.sent).toEqual(["First."]));

    await configure("prompt-change", { systemPrompt: "You are terse." });
    await stub.ingest(message("m2", "two?", { agentId: "prompt-change" }));
    await stub.flush();

    await vi.waitFor(() => expect(world.requests).toHaveLength(2));
    expect(world.requests[1]?.system).toBe("You are terse.");
    expect(world.requests[1]?.messages[1]).toEqual(neutral("First."));
  });

  it("records a reply under the prompt version it was produced with", async () => {
    const world = use(fakeWorld([reply("Done."), reply("Next.")]));
    world.blockSleeps.add(0);
    const stub = agent("prompt-mid-turn");
    await stub.ingest(message("m1", "anything?", { agentId: "prompt-mid-turn" }));
    await stub.flush();
    await vi.waitFor(() => expect(world.requests).toHaveLength(1));

    // The prompt changes while the first reply waits to be delivered; then it is delivered.
    await configure("prompt-mid-turn", { systemPrompt: "You are terse." });
    world.blockSleeps.clear();
    await stub.ingest(message("m2", "and now?", { agentId: "prompt-mid-turn" }));
    await stub.flush();

    await vi.waitFor(() => expect(world.requests).toHaveLength(2));
    expect(world.requests[0]?.system).not.toBe("You are terse.");
    expect(world.requests[1]?.system).toBe("You are terse.");
  });

  it("starts a turn with the agent's settings as they are at the flush", async () => {
    const world = use(fakeWorld([reply("Short.")]));
    const stub = agent("flush-settings");
    await stub.ingest(message("m1", "how long?", { agentId: "flush-settings" }));

    await configure("flush-settings", { systemPrompt: "Be brief.", maxOutputTokens: 64 });
    await stub.flush();

    await vi.waitFor(() => expect(world.requests).toHaveLength(1));
    expect(world.requests[0]).toMatchObject({ system: "Be brief.", maxOutputTokens: 64 });
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

describe("ConversationAgent time stamps", () => {
  const textOf = (entry: unknown) =>
    (entry as { parts: { text: string }[] }).parts.map((part) => part.text).join("");

  it("stamps a message with its local send time, and never touches the system prompt", async () => {
    const world = use(fakeWorld([reply("Good evening."), reply("Still here.")]));
    const stub = agent("stamp-local");
    const zone = { timeZone: "America/Sao_Paulo" };
    await stub.ingest(message("m1", "still up?", zone));
    await stub.flush();
    await vi.waitFor(() => expect(world.sent).toEqual(["Good evening."]));

    await stub.ingest(message("m2", "and now?", { ...zone, sentAt: SENT_AT + 60_000 }));
    await stub.flush();
    await vi.waitFor(() => expect(world.requests).toHaveLength(2));

    expect(textOf(world.requests[1]?.messages[0])).toBe(
      "[Sat 3 Oct 2026, 23:30, America/Sao_Paulo, UTC-03:00] still up?",
    );
    expect(textOf(world.requests[1]?.messages[2])).toBe(
      "[Sat 3 Oct 2026, 23:31, America/Sao_Paulo, UTC-03:00] and now?",
    );
    expect(world.requests[1]?.system).toBe(world.requests[0]?.system);
  });

  it("keeps earlier stamps as written when the zone changes", async () => {
    const world = use(fakeWorld([reply("Ok."), reply("Ok again.")]));
    const stub = agent("stamp-zone-change");
    await stub.ingest(message("m1", "first", { timeZone: "America/Sao_Paulo" }));
    await stub.flush();
    await vi.waitFor(() => expect(world.sent).toEqual(["Ok."]));

    await stub.ingest(message("m2", "second", { timeZone: "Europe/Lisbon" }));
    await stub.flush();
    await vi.waitFor(() => expect(world.requests).toHaveLength(2));

    expect(textOf(world.requests[1]?.messages[0])).toBe(
      "[Sat 3 Oct 2026, 23:30, America/Sao_Paulo, UTC-03:00] first",
    );
    expect(textOf(world.requests[1]?.messages[2])).toBe(
      "[Sun 4 Oct 2026, 03:30, Europe/Lisbon, UTC+01:00] second",
    );
  });

  it("stamps a burst once per minute, and drops a stamp the user typed", async () => {
    const world = use(fakeWorld([reply("Noted.")]));
    const stub = agent("stamp-burst");
    await stub.ingest(message("m1", "[Mon 1 Jan 2024, 09:00, UTC] so"));
    await stub.ingest(message("m2", "about that"));
    await stub.ingest(message("m3", "one more thing", { sentAt: SENT_AT + 60_000 }));
    await stub.flush();

    await vi.waitFor(() => expect(world.requests).toHaveLength(1));
    expect(textOf(world.requests[0]?.messages[0])).toBe(
      `${STAMP} so\nabout that\n[Sun 4 Oct 2026, 02:31, UTC] one more thing`,
    );
  });

  it("uses the arrival time when the provider's send time is missing, too early or in the future", async () => {
    const world = use(fakeWorld([reply("Ok.")]));
    const stub = agent("stamp-implausible");
    await stub.ingest(message("m1", "now?", { sentAt: Number.NaN }));
    await stub.ingest(message("m2", "later?", { sentAt: world.clock + 365 * 24 * 60 * 60_000 }));
    // Seconds where milliseconds were meant: Telegram's `date` is in seconds.
    await stub.ingest(message("m3", "seconds?", { sentAt: Math.floor(SENT_AT / 1_000) }));
    await stub.flush();

    await vi.waitFor(() => expect(world.requests).toHaveLength(1));
    expect(textOf(world.requests[0]?.messages[0])).toBe(
      `${stampOf(world.clock, null)} now?\nlater?\nseconds?`,
    );
  });

  it("refuses a message that is only a typed stamp, before binding anything", async () => {
    use(fakeWorld([]));
    const stub = agent("stamp-only");
    expect(await stub.ingest(message("m1", "[Sat 3 Oct 2026, 23:30, UTC]"))).toEqual({
      status: "rejected",
      reason: "empty",
    });
    expect(
      await stub.ingest({
        ...message("m2", "hello?"),
        destination: { ...destination, threadId: "another-chat" },
      }),
    ).toMatchObject({ status: "accepted" });
  });
});

describe("ConversationAgent delivery through the channel", () => {
  it("lets only the reply's last bubble notify", async () => {
    const world = use(fakeWorld([reply("One.\n\nTwo.\n\nThree.")]));
    const stub = agent("silent-bubbles");
    await stub.ingest(message("m1", "three things?"));
    await stub.flush();

    await vi.waitFor(() => expect(world.sent).toEqual(["One.", "Two.", "Three."]));
    expect(world.sends.map((send) => send.silent)).toEqual([true, true, false]);
  });

  it("waits when the channel rate-limits a bubble, then sends it", async () => {
    const world = use(fakeWorld([reply("One.\n\nTwo.")]));
    world.rateLimitSends.add(0);
    const stub = agent("rate-limited");
    await stub.ingest(message("m1", "two things?"));
    await stub.flush();

    await vi.waitFor(async () =>
      expect(await stub.turns()).toMatchObject([{ status: "delivered" }]),
    );
    expect(world.sent).toEqual(["One.", "Two."]);
    // The wait the channel asked for comes right after the first bubble's pacing.
    expect(world.sleeps[1]).toBe(50);
    expect(world.sends.map((send) => send.silent)).toEqual([true, false]);
  });

  it("fails the turn when the channel keeps rate-limiting the same bubble", async () => {
    const world = use(fakeWorld([reply("One.")]));
    for (const call of [0, 1, 2]) world.rateLimitSends.add(call);
    const stub = agent("rate-limited-thrice");
    await stub.ingest(message("m1", "one thing?"));
    await stub.flush();

    await vi.waitFor(async () => expect(await stub.turns()).toMatchObject([{ status: "failed" }]));
    expect(world.sent).toEqual([]);
    expect(world.sendAttempts).toBe(3);
    expect(await statuses(stub)).toEqual(["cancelled"]);
  });

  it("fails the turn rather than stall when the channel asks for too long a wait", async () => {
    const world = use(fakeWorld([reply("One.")]));
    world.rateLimitSends.add(0);
    world.rateLimitWaitMs = 120_000;
    const stub = agent("rate-limited-long");
    await stub.ingest(message("m1", "one thing?"));
    await stub.flush();

    await vi.waitFor(async () => expect(await stub.turns()).toMatchObject([{ status: "failed" }]));
    expect(world.sendAttempts).toBe(1);
    expect(world.sleeps).not.toContain(120_000);
  });

  it("keeps typing up while the model answers, and stops it once the reply is in", async () => {
    const world = use(fakeWorld([reply("Done.")]));
    const stub = agent("typing-kept");
    await stub.ingest(message("m1", "anything?"));
    await stub.flush();

    await vi.waitFor(() => expect(world.sent).toEqual(["Done."]));
    expect(world.typingKept).toBe(1);
    expect(world.typingStopped).toBe(1);
  });

  it("stops typing when a new message interrupts the model", async () => {
    const world = use(fakeWorld([hang(), reply("Both.")]));
    const stub = agent("typing-interrupted");
    await stub.ingest(message("m1", "first?"));
    await stub.flush();
    await vi.waitFor(() => expect(world.typingKept).toBe(1));

    await stub.ingest(message("m2", "actually, wait"));
    await vi.waitFor(() => expect(world.typingStopped).toBe(1));
  });

  it("shows no typing when conversational mode is off", async () => {
    const world = use(fakeWorld([reply("Plain.")]));
    const stub = agent("typing-off");
    await configure("typing-off", { conversational: false });
    await stub.ingest(message("m1", "hello?", { agentId: "typing-off" }));

    await vi.waitFor(() => expect(world.sent).toEqual(["Plain."]));
    expect(world.typingKept).toBe(0);
  });
});

describe("ConversationAgent rate limits and interruption", () => {
  it("doesn't count a bubble waiting out a rate limit as seen when a message interrupts", async () => {
    const world = use(fakeWorld([reply("One.\n\nTwo."), reply("Fine.")]));
    world.rateLimitSends.add(0);
    // Sleep 0 is the first bubble's pacing; sleep 1 is the wait the rate limit asked for.
    world.blockSleeps.add(1);
    const stub = agent("rate-limit-interrupted");
    await stub.ingest(message("m1", "two things?"));
    await stub.flush();
    await vi.waitFor(() => expect(world.rateLimitSends.size).toBe(1));
    await vi.waitFor(async () => expect(await statuses(stub)).toEqual(["pending", "pending"]));

    await stub.ingest(message("m2", "never mind"));
    await stub.flush();

    await vi.waitFor(() => expect(world.sent).toEqual(["Fine."]));
    expect(
      (await stub.outbox()).filter((row) => row.turnId === 1).map((row) => row.status),
    ).toEqual(["cancelled", "cancelled"]);
    // History holds no reply for the first turn: nothing of it reached the user.
    expect(JSON.stringify(world.requests[1]?.messages)).not.toContain("One.");
  });
});
