import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationAgent } from "../src/conversation-agent.ts";
import { replacePortsForTesting } from "../src/ports.ts";
import {
  TOOL_BOUND_RESULT,
  TOOL_LIMIT_TEXT,
  type ToolContext,
  type ToolOutcome,
} from "../src/tools.ts";
import {
  FAKE_USAGE,
  type FakeWorld,
  fakeWorld,
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

function message(id: string, text: string) {
  return {
    agentId: "assistant",
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

/** `count` rounds of one lookup each, with ids `toolu_0`… */
const rounds = (count: number) =>
  Array.from({ length: count }, (_, i) =>
    round({ id: `toolu_${i}`, name: "lookup", input: { q: `${i}` } }),
  ).flat();

/** History as the model sees it next, read on the object: RPC can't type its messages. */
const history = (stub: ReturnType<typeof agent>) =>
  runInDurableObject(stub, (instance: ConversationAgent) => instance.history());

function use(world: FakeWorld): FakeWorld {
  replacePortsForTesting(world.ports);
  return world;
}

/** One turn per text, each settled before the next. */
async function converse(stub: ReturnType<typeof agent>, texts: string[], first = 0) {
  for (const [index, text] of texts.entries()) {
    await stub.ingest(message(`m${first + index}`, text));
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
    ["the route's reply isn't clean", "route-unclean", [routeReply("Hi.", [], false)], false],
    ["its reply wasn't delivered", "route-undelivered", [routeReply("Hi.")], true],
    ["a later turn was refused", "route-refused", [routeReply("Hi."), refuse()], false],
  ])("is seeded again when %s", async (_label, name, scripts, failSend) => {
    const world = use(fakeWorld([...scripts, routeReply("Again.")]));
    if (failSend) world.failSends.add(0);
    const stub = agent(name);
    await converse(stub, [...scripts.map((_, i) => `q${i}`), "again"]);

    expect(world.sessions.at(-1)).toMatchObject({ resume: false });
    expect(world.sessions.at(-1)?.id).not.toBe(world.sessions[0]?.id);
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
