import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationAgent } from "../src/conversation-agent.ts";
import { replacePortsForTesting } from "../src/ports.ts";
import {
  TOOL_BOUND_RESULT,
  TOOL_LIMIT_TEXT,
  TOOL_NOT_RUN_RESULT,
  type ToolContext,
  type ToolOutcome,
} from "../src/tools.ts";
import {
  FAKE_USAGE,
  type FakeWorld,
  fail,
  fakeWorld,
  hang,
  refuse,
  reply,
  round,
  routeReply,
} from "./fakes.ts";

// The turn's loop when the route runs it (#295): a route such as `claude-code` runs the tool loop
// itself, and the turn records its rounds, runs the calls it asks for and answers them, within
// ADR-0025's bounds. The conversation keeps the route's session while it matches history.

const agent = (name: string) => env.CONVERSATION_AGENT.getByName(name);
const destination = { channel: "telegram", threadId: "chat-1" } as const;
const SENT_AT = Date.UTC(2026, 9, 4, 2, 30);
const STAMP = "[Sun 4 Oct 2026, 02:30, UTC]";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function message(id: string, text: string, agentId = "assistant") {
  return {
    agentId,
    providerMessageId: id,
    userId: "u-owner",
    role: "owner" as const,
    chatType: "direct" as const,
    text,
    destination,
    sentAt: SENT_AT,
    timeZone: null,
  };
}

const user = (text: string) => ({
  role: "user",
  parts: [{ type: "text", text: `${STAMP} ${text}` }],
});
const said = (text: string) => ({ role: "assistant", parts: [{ type: "text", text }] });
const results = (...outcomes: { callId: string; output: string; isError?: boolean }[]) => ({
  role: "tool",
  results: outcomes,
});

/** One provider with the given tools; each run is logged, with what its context could do. */
function provide(
  world: FakeWorld,
  tools: Record<string, (input: { q?: string }, context: ToolContext) => Promise<ToolOutcome>>,
) {
  const runs: unknown[] = [];
  world.tools = [
    {
      async tools() {
        return Object.entries(tools).map(([name, run]) => ({
          spec: {
            name,
            description: `The ${name} tool.`,
            inputSchema: { type: "object" as const },
          },
          label: `Running ${name}`,
          async run(input: unknown, context: ToolContext) {
            runs.push(input);
            return run(input as { q?: string }, context);
          },
        }));
      },
    },
  ];
  return runs;
}

const lookup = async (input: { q?: string }) => ({ output: `found ${input.q ?? "nothing"}` });

/** A lookup the route's model asks for, with the id `toolu_<key>`. */
const lookupCall = (key: string | number) => ({
  id: `toolu_${key}`,
  name: "lookup",
  input: { q: `${key}` },
});
/** `count` rounds of one lookup each, with ids `toolu_0`… */
const rounds = (count: number) =>
  Array.from({ length: count }, (_, i) => round(lookupCall(i))).flat();
/** A round's reply alone: the route asks to run none of its calls. */
const asks = (...keys: string[]) => round(...keys.map(lookupCall)).slice(0, 1);
/** The route's request for one lookup. */
const request = (key: string) => ({
  type: "tool_request" as const,
  call: { type: "tool_call" as const, ...lookupCall(key) },
});
const found = (key: string) => ({ callId: `toolu_${key}`, output: `found ${key}` });
const notRun = (key: string) => ({
  callId: `toolu_${key}`,
  output: TOOL_NOT_RUN_RESULT,
  isError: true,
});
/** A round's reply as history holds it. */
const asked = (...keys: string[]) => ({
  role: "assistant",
  parts: keys.map((key) => ({ type: "tool_call", ...lookupCall(key) })),
});

/** History as the model sees it next, read on the object: RPC can't type its messages. */
const history = (stub: ReturnType<typeof agent>) =>
  runInDurableObject(stub, (instance: ConversationAgent) => instance.history());

function use(world: FakeWorld): FakeWorld {
  replacePortsForTesting(world.ports);
  return world;
}

/** One turn per text, each settled before the next. */
async function converse(
  stub: ReturnType<typeof agent>,
  texts: string[],
  first = 0,
  agentId = "assistant",
) {
  for (const [index, text] of texts.entries()) {
    await stub.ingest(message(`m${first + index}`, text, agentId));
    await stub.flush();
    await vi.waitFor(async () => {
      const turns = await stub.turns();
      expect(turns).toHaveLength(first + index + 1);
      expect(turns.at(-1)?.status).not.toBe("running");
    });
  }
}

afterEach(() => {
  replacePortsForTesting(undefined);
  vi.restoreAllMocks();
});

describe("a route that runs its own tool loop", () => {
  it("records each round as the turn's reply asking for tools, with its usage", async () => {
    const world = use(
      fakeWorld([
        routeReply("Lisbon.", round({ id: "toolu_1", name: "lookup", input: { q: "ana" } })),
      ]),
    );
    provide(world, { lookup });
    const stub = agent("route-round");
    await converse(stub, ["where does Ana live?"]);

    expect(world.sent).toEqual(["Lisbon."]);
    // One model call: the route ran the loop.
    expect(world.requests).toHaveLength(1);
    expect(await history(stub)).toEqual([
      user("where does Ana live?"),
      {
        role: "assistant",
        parts: [{ type: "tool_call", id: "toolu_1", name: "lookup", input: { q: "ana" } }],
      },
      results({ callId: "toolu_1", output: "found ana" }),
      said("Lisbon."),
    ]);
    // The round's usage, then the reply's.
    expect((await stub.turns())[0]?.usage).toEqual([...FAKE_USAGE, ...FAKE_USAGE]);
  });

  it("runs a requested call through the turn's tools, its confirmation included, and answers it", async () => {
    const world = use(
      fakeWorld([routeReply("Say yes first.", round({ id: "toolu_1", name: "rename" }))]),
    );
    provide(world, {
      rename: async (_input, context) => {
        const yes = await context.confirm({
          command: "rename",
          input: { name: "Rex" },
          summary: "rename the agent to Rex",
        });
        return { output: yes ? "Renamed." : "Waiting for the owner's yes." };
      },
    });
    const stub = agent("route-confirm");
    await converse(stub, ["call yourself Rex"]);

    expect(world.answers).toEqual([{ callId: "toolu_1", output: "Waiting for the owner's yes." }]);
    // Kelpie's own notice follows the reply, as on the API route.
    expect(world.sent).toEqual([
      "Say yes first.",
      expect.stringMatching(
        /^Confirm: rename the agent to Rex\nTo go ahead, reply with just the code [A-Z0-9]{6}\./,
      ),
    ]);
  });

  it("gives a sixth round's calls the bound result, and keeps no session for that turn", async () => {
    const world = use(
      fakeWorld([routeReply("Here is what I found.", rounds(6)), routeReply("Ok.")]),
    );
    const runs = provide(world, { lookup });
    const stub = agent("route-sixth-round");
    await converse(stub, ["dig deep"]);

    expect(world.sent).toEqual(["Here is what I found."]);
    expect(runs).toEqual(Array.from({ length: 5 }, (_, i) => ({ q: `${i}` })));
    expect(world.answers).toHaveLength(6);
    expect(world.answers.at(-1)).toEqual({
      callId: "toolu_5",
      output: TOOL_BOUND_RESULT,
      isError: true,
    });

    // A turn that reached its bound leaves the session to be seeded again.
    await converse(stub, ["thanks"], 1);
    expect(world.sessions[1]).toMatchObject({ resume: false });
    expect(world.sessions[1]?.id).not.toBe(world.sessions[0]?.id);
  });

  it("ends a seventh round with the fixed text, cancelling the call, its calls out of history", async () => {
    const world = use(fakeWorld([routeReply("Never sent.", rounds(7))]));
    provide(world, { lookup });
    const stub = agent("route-seventh-round");
    await converse(stub, ["dig forever"]);

    expect(world.sent).toEqual([TOOL_LIMIT_TEXT.en]);
    expect(world.cancelled).toBe(1);
    expect(world.answers).toHaveLength(6);
    const messages = await history(stub);
    expect(messages.slice(-2)).toEqual([
      results({ callId: "toolu_5", output: TOOL_BOUND_RESULT, isError: true }),
      said(TOOL_LIMIT_TEXT.en),
    ]);
    expect(JSON.stringify(messages)).not.toContain("toolu_6");
  });

  it("cuts a seventh round even when the route ran none of the sixth's calls through Kelpie", async () => {
    const world = use(
      fakeWorld([routeReply("Never sent.", [...rounds(5), ...asks("5"), ...round(lookupCall(6))])]),
    );
    const runs = provide(world, { lookup });
    const stub = agent("route-seventh-unasked");
    await converse(stub, ["dig forever"]);

    expect(world.sent).toEqual([TOOL_LIMIT_TEXT.en]);
    expect(world.cancelled).toBe(1);
    expect(runs).toHaveLength(5);
    expect(JSON.stringify(await history(stub))).not.toContain("toolu_6");
  });

  it.each([
    [
      "the round's next call",
      "route-interrupt-call",
      round(lookupCall("a"), lookupCall("b")),
      [asked("a", "b"), results(found("a"), notRun("b"))],
    ],
    [
      "the next round",
      "route-interrupt-round",
      [...round(lookupCall("a")), ...round(lookupCall("b"))],
      [asked("a"), results(found("a"))],
    ],
  ])(
    "starts nothing once a new message interrupted the turn: not %s",
    async (_label, name, sent, recorded) => {
      const world = use(fakeWorld([routeReply("Never sent.", sent), reply("Okay.")]));
      const runs = provide(world, { lookup });
      // The first call's answer is in flight when the owner writes again.
      world.holdAnswers.add(0);
      const stub = agent(name);
      await stub.ingest(message("m1", "look up a and b"));
      await stub.flush();
      await vi.waitFor(() => expect(world.answers).toHaveLength(1));
      await stub.ingest(message("m2", "never mind"));
      world.holdAnswers.clear();
      await stub.flush();
      await vi.waitFor(() => expect(world.sent).toEqual(["Okay."]));
      // Whatever the interrupted loop would still do has had time to happen.
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(runs).toEqual([{ q: "a" }]);
      expect(await history(stub)).toEqual([
        user("look up a and b"),
        ...recorded,
        user("never mind"),
        { ...said("Okay."), native: expect.anything() },
      ]);
    },
  );
});

describe("a round of several calls", () => {
  it("writes the round's results once every call is answered", async () => {
    const world = use(fakeWorld([routeReply("Both.", round(lookupCall("a"), lookupCall("b")))]));
    provide(world, { lookup });
    // The second call's answer is in flight: the first was answered.
    world.holdAnswers.add(1);
    const stub = agent("route-round-results");
    await stub.ingest(message("m1", "a and b?"));
    await stub.flush();
    await vi.waitFor(() => expect(world.answers).toHaveLength(2));
    expect((await history(stub)).at(-1)).toEqual(asked("a", "b"));

    world.holdAnswers.clear();
    await vi.waitFor(async () => expect((await stub.turns())[0]?.status).toBe("delivered"));
    expect((await history(stub)).slice(1)).toEqual([
      asked("a", "b"),
      results(found("a"), found("b")),
      said("Both."),
    ]);
  });

  it("gives a call the route never asked Kelpie to run the not-run result", async () => {
    const world = use(
      fakeWorld([
        routeReply("Done.", [...asks("a", "b"), request("a"), ...round(lookupCall("c"))]),
      ]),
    );
    const runs = provide(world, { lookup });
    const stub = agent("route-round-unasked");
    await converse(stub, ["a, b and c?"]);

    expect(runs).toEqual([{ q: "a" }, { q: "c" }]);
    expect((await history(stub)).slice(1)).toEqual([
      asked("a", "b"),
      results(found("a"), notRun("b")),
      asked("c"),
      results(found("c")),
      said("Done."),
    ]);
  });

  it.each([
    [
      "a second request for the same call",
      "route-request-twice",
      [...asks("a", "b"), request("a"), request("a")],
    ],
    [
      "a request once its round closed",
      "route-request-late",
      [...round(lookupCall("a")), request("a")],
    ],
  ])("refuses %s, and says so", async (_label, name, sent) => {
    const world = use(fakeWorld([routeReply("Never sent.", sent)]));
    const runs = provide(world, { lookup });
    const stub = agent(name);
    await converse(stub, ["a?"]);

    expect(runs).toEqual([{ q: "a" }]);
    expect(await stub.turns()).toMatchObject([{ status: "failed" }]);
    expect(world.sent).toEqual([
      "I couldn't answer this message: the model answered in a way Kelpie can't read.",
    ]);
  });
});

describe("a route's session", () => {
  it("starts with the first turn, and the next turn resumes it", async () => {
    const world = use(fakeWorld([routeReply("Hi."), routeReply("Again.")]));
    const stub = agent("route-resume");
    await converse(stub, ["hello", "hello again"]);

    const [first, second] = world.sessions;
    expect(first).toEqual({
      conversation: "route-resume",
      id: expect.stringMatching(UUID),
      resume: false,
    });
    expect(second).toEqual({ ...first, resume: true });
  });

  it("is seeded again after a turn another route answered", async () => {
    const world = use(fakeWorld([routeReply("Hi."), reply("From the API."), routeReply("Back.")]));
    const stub = agent("route-other-route");
    await converse(stub, ["hello", "and now?", "and now?"]);

    const [first, second, third] = world.sessions;
    // The second turn could have resumed it, but another route answered.
    expect(second).toEqual({ ...first, resume: true });
    expect(third).toMatchObject({ resume: false });
    expect(third?.id).not.toBe(first?.id);
  });

  it("is seeded again after a checkpoint, whose summary carries none", async () => {
    const turns = Array.from({ length: 5 }, (_, i) => routeReply(`r${i}`));
    const world = use(fakeWorld([...turns, reply("THE SUMMARY"), routeReply("r5")]));
    const stub = agent("route-checkpoint");
    await converse(stub, ["q0", "q1", "q2", "q3", "q4"]);
    expect(world.sessions.slice(1).every((session) => session?.resume)).toBe(true);

    await stub.compact();
    expect(world.selections.at(-1)).toMatchObject({ area: "memory" });
    expect(world.sessions.at(-1)).toBeUndefined();

    await converse(stub, ["q5"], 5);
    expect(world.sessions.at(-1)).toMatchObject({ resume: false });
    expect(world.sessions.at(-1)?.id).not.toBe(world.sessions[0]?.id);
  });

  it.each([
    [
      "the route's reply isn't clean",
      "route-unclean",
      [routeReply("Hi.", [], { clean: false })],
      false,
    ],
    ["its reply wasn't delivered", "route-undelivered", [routeReply("Hi.")], true],
    ["a later turn was refused", "route-refused", [routeReply("Hi."), refuse()], false],
    ["a later turn failed", "route-failed", [routeReply("Hi."), fail()], false],
    [
      "a later reply names its session by no UUID",
      "route-not-uuid",
      [routeReply("Hi."), routeReply("Odd.", [], { id: "not-a-uuid" })],
      false,
    ],
  ])("is seeded again when %s", async (_label, name, scripts, failSend) => {
    const world = use(fakeWorld([...scripts, routeReply("Again.")]));
    if (failSend) world.failSends.add(0);
    const stub = agent(name);
    await converse(stub, [...scripts.map((_, i) => `q${i}`), "again"]);

    expect(world.sessions.at(-1)).toMatchObject({ resume: false });
    expect(world.sessions.at(-1)?.id).not.toBe(world.sessions[0]?.id);
  });

  it("is seeded again after a turn that was interrupted", async () => {
    const world = use(fakeWorld([routeReply("Hi."), hang(), routeReply("Again.")]));
    const stub = agent("route-interrupted");
    await converse(stub, ["hello"]);
    await stub.ingest(message("m1", "and?"));
    await stub.flush();
    await vi.waitFor(() => expect(world.requests).toHaveLength(2));
    await converse(stub, ["hello again"], 2);

    expect(world.sessions[1]).toEqual({ ...world.sessions[0], resume: true });
    expect(world.sessions[2]).toMatchObject({ resume: false });
    expect(world.sessions[2]?.id).not.toBe(world.sessions[0]?.id);
  });

  it("is seeded again for a turn retried after an eviction", async () => {
    const world = use(fakeWorld([routeReply("Hi."), hang(), routeReply("Again.")]));
    const stub = agent("route-retried");
    await converse(stub, ["hello"]);
    await stub.ingest(message("m1", "and?"));
    await stub.flush();
    await vi.waitFor(() => expect(world.requests).toHaveLength(2));

    // The session may already hold the turn's message: the retry can't send it again.
    await evictDurableObject(stub);
    await runDurableObjectAlarm(stub);
    await vi.waitFor(() => expect(world.sent).toEqual(["Hi.", "Again."]));
    expect(world.sessions[1]).toEqual({ ...world.sessions[0], resume: true });
    expect(world.sessions[2]).toMatchObject({ resume: false });
    expect(world.sessions[2]?.id).not.toBe(world.sessions[0]?.id);
  });

  /** Writes a history row after the turns, as only an eviction mid-turn could leave one. */
  const lateRow = (message: object) => (stub: ReturnType<typeof agent>) =>
    runInDurableObject(stub, (_instance: ConversationAgent, state) => {
      state.storage.sql.exec(
        "INSERT INTO history (turn_id, role, system_version, message, created_at) VALUES (1, ?, 0, ?, 0)",
        (message as { role: string }).role,
        JSON.stringify(message),
      );
    });

  it.each([
    [
      "the agent's prompt version",
      "route-stale-version",
      // A change that leaves the prompt's text as it was.
      async () => {
        expect(
          await env.AGENT_HOST.getByName("route-stale-version").configure(
            { memoryCore: true },
            { userId: "u-owner", role: "owner", via: "test" },
          ),
        ).toMatchObject({ ok: true });
      },
    ],
    [
      "Kelpie's built-in prompt, as a deploy changes it",
      "route-stale-prompt",
      (stub: ReturnType<typeof agent>) =>
        runInDurableObject(stub, (_instance: ConversationAgent, state) => {
          state.storage.sql.exec(
            "UPDATE state SET value = json_set(value, '$.promptKey', 'an earlier deploy') WHERE key = 'routeSession'",
          );
        }),
    ],
    [
      "the agent's tools",
      "route-stale-tools",
      async (_stub: ReturnType<typeof agent>, world: FakeWorld) => {
        provide(world, { lookup, other: lookup });
      },
    ],
    ["a reply after its last row", "route-stale-reply", lateRow(said("Late."))],
    [
      "a tool's result after its last row",
      "route-stale-result",
      lateRow(results({ callId: "toolu_late", output: "late" })),
    ],
  ])("is seeded again once %s changed", async (_label, name, change) => {
    const world = use(fakeWorld([routeReply("Hi."), routeReply("Again.")]));
    provide(world, { lookup });
    const stub = agent(name);
    await converse(stub, ["hello"], 0, name);
    await change(stub, world);
    await converse(stub, ["hello again"], 1, name);

    expect(world.sessions[1]).toMatchObject({ resume: false });
    expect(world.sessions[1]?.id).not.toBe(world.sessions[0]?.id);
  });

  it.each([
    ["a member's", "member", "direct"],
    ["a group chat's", "owner", "group"],
  ] as const)("isn't sent for %s turn", async (_label, role, chatType) => {
    const world = use(fakeWorld([reply("Hi.")]));
    const stub = agent(`route-no-session-${role}-${chatType}`);
    await stub.ingest({ ...message("m0", "hello"), role, chatType });
    await stub.flush();
    await vi.waitFor(() => expect(world.sent).toEqual(["Hi."]));
    expect(world.sessions).toEqual([undefined]);
  });
});
