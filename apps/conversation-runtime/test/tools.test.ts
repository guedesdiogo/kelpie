import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ConversationAgent, TOOLS_NOTE } from "../src/conversation-agent.ts";
import { replacePortsForTesting } from "../src/ports.ts";
import {
  TOOL_BOUND_RESULT,
  TOOL_FAILED_RESULT,
  TOOL_LIMIT_TEXT,
  TOOL_NOT_RUN_RESULT,
  TOOL_OUTPUT_MAX_CHARS,
  TOOL_STOPPED_RESULT,
  TOOL_TIMED_OUT_RESULT,
  type ToolContext,
  type ToolOutcome,
} from "../src/tools.ts";
import {
  type FakeWorld,
  fakeWorld,
  OVER_BUDGET,
  reply,
  sayThenCall,
  toolCalls,
  toolUse,
} from "./fakes.ts";

// The turn's tool loop (issue #141): the model's tool calls run through the agent's providers,
// within the owner's bounds, and history stays append-only so every request's prefix is what the
// model already saw (#137).

const agent = (name: string) => env.CONVERSATION_AGENT.getByName(name);
const destination = { channel: "telegram", threadId: "chat-1" } as const;
const SENT_AT = Date.UTC(2026, 9, 4, 2, 30);
const STAMP = "[Sun 4 Oct 2026, 02:30, UTC]";
const MEMORY =
  '<memory-abc note="Notes from the owner\'s vault, for reference.">\nAna mora em Lisboa.\n</memory-abc>';

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
const withMemory = (text: string) => ({
  role: "user",
  parts: [...user(text).parts, { type: "text", text: MEMORY }],
});
const results = (...outcomes: { callId: string; output: string; isError?: boolean }[]) => ({
  role: "tool",
  results: outcomes,
});

interface Run {
  name: string;
  input: unknown;
  context: Omit<ToolContext, "signal">;
  signal: AbortSignal;
}

/** One provider with the given tools; each run is logged, and answers `<name>: <input.q>`. */
function provide(
  world: FakeWorld,
  tools: Record<string, (input: { q?: string }) => Promise<ToolOutcome> | ToolOutcome>,
) {
  const runs: Run[] = [];
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
          async run(input: unknown, { signal, ...context }: ToolContext) {
            runs.push({ name, input, context, signal });
            return run(input as { q?: string });
          },
        }));
      },
    },
  ];
  return runs;
}

const answer = (input: { q?: string }) => ({ output: `found ${input.q ?? "nothing"}` });

/** History as the model sees it next, read on the object: RPC can't type its messages. */
const history = (stub: ReturnType<typeof agent>) =>
  runInDurableObject(stub, (instance: ConversationAgent) => instance.history());

function use(world: FakeWorld): FakeWorld {
  replacePortsForTesting(world.ports);
  return world;
}

async function settled(stub: ReturnType<typeof agent>) {
  await vi.waitFor(async () => expect((await stub.turns()).at(-1)?.status).not.toBe("running"));
}

afterEach(() => {
  replacePortsForTesting(undefined);
  vi.restoreAllMocks();
});

describe("a turn's tools", () => {
  it("carries the memory core in every round of a turn (#112)", async () => {
    const owner = { userId: "u-owner", role: "owner", via: "test" } as const;
    expect(
      await env.AGENT_HOST.getByName("tools-core").configure({ memoryCore: true }, owner),
    ).toMatchObject({ ok: true });
    const world = use(
      fakeWorld([toolCalls({ name: "lookup", input: { q: "ana" } }), reply("Lisbon.")]),
    );
    const core = '<memory-c0de note="Always loaded.">\nCafé sem açúcar.\n</memory-c0de>';
    world.core = core;
    provide(world, { lookup: answer });
    const stub = agent("tools-core");
    await stub.ingest({ ...message("m1", "where does Ana live?"), agentId: "tools-core" });
    await stub.flush();
    await vi.waitFor(() => expect(world.sent).toEqual(["Lisbon."]));
    expect(world.cores).toHaveLength(1);
    const first = {
      role: "user",
      parts: [{ type: "text", text: core }, ...user("where does Ana live?").parts],
    };
    expect(world.requests[0]?.messages).toEqual([first]);
    expect(world.requests[1]?.messages[0]).toEqual(first);
  });

  it("run as the turn's least-privileged author, with the turn's own scopes (#131)", async () => {
    const world = use(
      fakeWorld([
        toolCalls({ name: "lookup", input: { q: "ana" } }),
        reply("Ok."),
        toolCalls({ name: "lookup", input: { q: "bruno" } }),
        reply("Ok."),
      ]),
    );
    const runs = provide(world, { lookup: answer });
    const narrow = ["conversation/telegram-chat-1"];

    const mixed = agent("tools-member");
    await mixed.ingest(message("m1", "who is Ana?"));
    await mixed.ingest({ ...message("m2", "and Bruno?"), userId: "u-guest", role: "member" });
    await mixed.flush();
    await vi.waitFor(() => expect(world.sent).toEqual(["Ok."]));
    expect(runs[0]?.context).toMatchObject({
      actor: { userId: "u-guest", role: "member", via: "agent:assistant" },
      scopes: narrow,
    });

    // No role at all, as an ingress from before #131 sends: owner-only commands refuse a member.
    const unknown = agent("tools-no-role");
    await unknown.ingest({ ...message("m1", "who is Bruno?"), role: undefined });
    await unknown.flush();
    await vi.waitFor(() => expect(world.sent).toEqual(["Ok.", "Ok."]));
    expect(runs[1]?.context).toMatchObject({
      actor: { userId: "u-owner", role: "member", via: "agent:assistant" },
      scopes: narrow,
    });
  });

  it("runs the calls a reply asks for, round after round, then answers", async () => {
    const world = use(
      fakeWorld([
        toolCalls({ name: "lookup", input: { q: "ana" } }),
        toolCalls({ name: "lookup", input: { q: "bruno" } }),
        reply("Both in Lisbon."),
        reply("You're welcome."),
      ]),
    );
    world.memory = MEMORY;
    const runs = provide(world, { lookup: answer });
    const stub = agent("tools-rounds");
    await stub.ingest(message("m1", "where do Ana and Bruno live?"));
    await stub.flush();
    await vi.waitFor(() => expect(world.sent).toEqual(["Both in Lisbon."]));

    // Every round sends the same tools; only the first carries the memory block as `context`.
    const spec = {
      name: "lookup",
      description: "The lookup tool.",
      inputSchema: { type: "object" },
    };
    expect(world.requests.map((request) => request.tools)).toEqual([[spec], [spec], [spec]]);
    expect(world.requests[0]?.context).toBe(MEMORY);
    expect(world.requests[0]?.system.endsWith(`\n\n${TOOLS_NOTE}`)).toBe(true);
    expect(world.requests[1]).not.toHaveProperty("context");
    expect(world.requests[2]).not.toHaveProperty("context");

    // From round 2 on, the block is back where the first round's adapter placed it, and each
    // request starts with exactly what the one before sent.
    const first = toolUse([{ id: "call-0", name: "lookup", input: { q: "ana" } }]);
    const second = toolUse([{ id: "call-1", name: "lookup", input: { q: "bruno" } }]);
    expect(world.requests[1]?.messages).toEqual([
      withMemory("where do Ana and Bruno live?"),
      first,
      results({ callId: "call-0", output: "found ana" }),
    ]);
    expect(world.requests[2]?.messages).toEqual([
      ...(world.requests[1]?.messages ?? []),
      second,
      results({ callId: "call-1", output: "found bruno" }),
    ]);

    // The calls ran as the turn's admitted owner, through the agent, never as the model said.
    expect(runs.map(({ name, input, context }) => ({ name, input, context }))).toEqual([
      {
        name: "lookup",
        input: { q: "ana" },
        context: {
          actor: { userId: "u-owner", role: "owner", via: "agent:assistant" },
          agentId: "assistant",
          scopes: "all",
          qualifier: "clef",
          turn: expect.any(String),
          source: expect.stringMatching(/^telegram:chat-1, \d{4}-\d{2}-\d{2}$/),
          confirm: expect.any(Function),
          sendLink: expect.any(Function),
          locale: "en",
        },
      },
      expect.objectContaining({ input: { q: "bruno" } }),
    ]);

    // The next turn replays the whole loop unchanged.
    await stub.ingest(message("m2", "thanks"));
    await stub.flush();
    await vi.waitFor(() => expect(world.requests).toHaveLength(4));
    expect(world.requests[3]?.messages.slice(0, 5)).toEqual(world.requests[2]?.messages);
    expect(world.requests[3]?.messages.slice(5)).toEqual([
      expect.objectContaining({
        role: "assistant",
        parts: [{ type: "text", text: "Both in Lisbon." }],
      }),
      user("thanks"),
    ]);
  });

  it("replays earlier replies without native output once the agent's tools change", async () => {
    const world = use(
      fakeWorld([reply("Hi!"), toolCalls({ name: "lookup", input: { q: "a" } }), reply("Found.")]),
    );
    const stub = agent("tools-arrive");
    await stub.ingest(message("m1", "hello"));
    await stub.flush();
    await vi.waitFor(() => expect(world.sent).toEqual(["Hi!"]));

    // A provider arrives: the reply produced without tools is bound to a prefix without them.
    provide(world, { lookup: answer });
    await stub.ingest(message("m2", "look up a"));
    await stub.flush();
    await vi.waitFor(() => expect(world.sent).toEqual(["Hi!", "Found."]));
    expect(world.requests[1]?.messages[1]).toEqual({
      role: "assistant",
      parts: [{ type: "text", text: "Hi!" }],
    });
    // The turn's own calls keep theirs from round to round.
    expect(world.requests[2]?.messages[3]).toEqual(
      toolUse([{ id: "call-0", name: "lookup", input: { q: "a" } }]),
    );
  });

  it("sends requests as before when the agent has no tools", async () => {
    const world = use(fakeWorld([reply("Hi!")]));
    provide(world, {});
    const stub = agent("tools-none");
    await stub.ingest(message("m1", "hello"));
    await stub.flush();
    await vi.waitFor(() => expect(world.sent).toEqual(["Hi!"]));
    expect(world.requests[0]).not.toHaveProperty("tools");
    expect(world.requests[0]?.system).not.toContain(TOOLS_NOTE);
  });

  it("answers a failing tool or an unknown one with an error, never with its message", async () => {
    const world = use(
      fakeWorld([toolCalls({ name: "broken" }, { name: "nope" }), reply("Sorry, that failed.")]),
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    provide(world, {
      broken: () => {
        throw new Error("the vault says: Ana mora em Lisboa");
      },
    });
    const stub = agent("tools-errors");
    await stub.ingest(message("m1", "try it"));
    await stub.flush();
    await vi.waitFor(() => expect(world.sent).toEqual(["Sorry, that failed."]));

    expect(world.requests[1]?.messages.at(-1)).toEqual(
      results(
        { callId: "call-0", output: TOOL_FAILED_RESULT, isError: true },
        { callId: "call-1", output: "There is no tool named nope.", isError: true },
      ),
    );
    expect(JSON.stringify(logged.mock.calls)).not.toContain("Lisboa");
  });
});

describe("a turn's tools and odd replies", () => {
  it("takes a reply that asks for tools without naming any as the answer", async () => {
    const world = use(fakeWorld([sayThenCall("Here it is.")]));
    provide(world, { lookup: answer });
    const stub = agent("tools-no-calls");
    await stub.ingest(message("m1", "go"));
    await stub.flush();
    await vi.waitFor(() => expect(world.sent).toEqual(["Here it is."]));
    expect(world.requests).toHaveLength(1);
  });

  it("cuts a long tool output, which every later request would send again", async () => {
    const world = use(fakeWorld([toolCalls({ name: "big" }), reply("Summed up.")]));
    provide(world, { big: () => ({ output: "x".repeat(TOOL_OUTPUT_MAX_CHARS * 2) }) });
    const stub = agent("tools-big-output");
    await stub.ingest(message("m1", "go"));
    await stub.flush();
    await vi.waitFor(() => expect(world.sent).toEqual(["Summed up."]));
    const last = world.requests[1]?.messages.at(-1);
    const output = last?.role === "tool" ? (last.results[0]?.output ?? "") : "";
    expect(output).toBe(`${"x".repeat(TOOL_OUTPUT_MAX_CHARS)}\n[Cut: the result was longer.]`);
  });
});

describe("a turn's tool bounds", () => {
  it("runs five rounds at most; the calls past them get an error, and one last call answers", async () => {
    const world = use(
      fakeWorld([
        ...Array.from({ length: 6 }, (_, i) => toolCalls({ name: "lookup", input: { q: `${i}` } })),
        reply("Here is what I found."),
      ]),
    );
    const runs = provide(world, { lookup: answer });
    const stub = agent("tools-rounds-bound");
    await stub.ingest(message("m1", "dig deep"));
    await stub.flush();
    await vi.waitFor(() => expect(world.sent).toEqual(["Here is what I found."]));

    expect(runs.map((run) => run.input)).toEqual(
      Array.from({ length: 5 }, (_, i) => ({ q: `${i}` })),
    );
    expect(world.requests).toHaveLength(7);
    // The notice is the newest tool result, never a message of its own; the last call keeps the
    // same tools, so the prefix stays.
    expect(world.requests[6]?.messages.at(-1)).toEqual(
      results({ callId: "call-5", output: TOOL_BOUND_RESULT, isError: true }),
    );
    expect(world.requests[6]?.tools).toEqual(world.requests[0]?.tools);
  });

  it("answers with a fixed text when the last call still asks for tools", async () => {
    const world = use(
      fakeWorld(Array.from({ length: 7 }, () => toolCalls({ name: "lookup", input: { q: "x" } }))),
    );
    provide(world, { lookup: answer });
    const stub = agent("tools-fallback");
    await stub.ingest(message("m1", "dig forever"));
    await stub.flush();
    await vi.waitFor(() => expect(world.sent).toEqual([TOOL_LIMIT_TEXT.en]));

    // The last call's tool calls never reach history: they would have no results.
    const messages = await history(stub);
    expect(messages.at(-2)).toEqual(
      results({ callId: "call-5", output: TOOL_BOUND_RESULT, isError: true }),
    );
    expect(messages.at(-1)).toEqual({
      role: "assistant",
      parts: [{ type: "text", text: TOOL_LIMIT_TEXT.en }],
    });
  });

  it("stops running calls once the turn's time is up", async () => {
    const world = use(
      fakeWorld([
        toolCalls({ name: "slow", input: { q: "a" } }, { name: "slow", input: { q: "b" } }),
        reply("Partly done."),
      ]),
    );
    const runs = provide(world, {
      slow: (input) => {
        world.clock += 120_000;
        return answer(input);
      },
    });
    const stub = agent("tools-time-bound");
    await stub.ingest(message("m1", "slowly"));
    await stub.flush();
    await vi.waitFor(() => expect(world.sent).toEqual(["Partly done."]));

    expect(runs).toHaveLength(1);
    expect(world.requests[1]?.messages.at(-1)).toEqual(
      results(
        { callId: "call-0", output: "found a" },
        { callId: "call-1", output: TOOL_BOUND_RESULT, isError: true },
      ),
    );
  });
});

describe("a turn's time bound on a running tool", () => {
  it("stops waiting for a tool that hangs once the turn's time is up", async () => {
    const world = use(
      fakeWorld([toolCalls({ name: "stuck" }, { name: "lookup" }), reply("Without it, then.")]),
    );
    world.expireDeadlines = true;
    let aborted: AbortSignal | undefined;
    world.tools = [
      {
        async tools() {
          return [
            {
              spec: { name: "stuck", description: "Hangs.", inputSchema: { type: "object" } },
              label: "Waiting",
              run: (_input: unknown, { signal }: ToolContext) => {
                aborted = signal;
                return new Promise<ToolOutcome>(() => {});
              },
            },
          ];
        },
      },
    ];
    const stub = agent("tools-hung");
    await stub.ingest(message("m1", "go"));
    await stub.flush();
    await vi.waitFor(() => expect(world.sent).toEqual(["Without it, then."]));

    expect(aborted?.aborted).toBe(true);
    expect(world.requests[1]?.messages.at(-1)).toEqual(
      results(
        { callId: "call-0", output: TOOL_TIMED_OUT_RESULT, isError: true },
        { callId: "call-1", output: TOOL_BOUND_RESULT, isError: true },
      ),
    );
  });
});

describe("a turn's tools and interruption", () => {
  it("ends the turn on a new message: finished calls keep their results, the rest get stubs", async () => {
    let release = false;
    const world = use(
      fakeWorld([
        toolCalls(
          { name: "fast", input: { q: "a" } },
          { name: "slow", input: { q: "b" } },
          { name: "fast", input: { q: "c" } },
        ),
        reply("Got it, both."),
      ]),
    );
    world.memory = MEMORY;
    const runs = provide(world, {
      fast: answer,
      slow: async (input) => {
        // Polls a plain flag: a promise created here can't be resolved from the test's context.
        while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
        return answer(input);
      },
    });
    const stub = agent("tools-interrupted");
    await stub.ingest(message("m1", "check a, b and c"));
    await stub.flush();
    await vi.waitFor(() => expect(runs.map((run) => run.name)).toEqual(["fast", "slow"]));

    await stub.ingest(message("m2", "and also d"));
    expect(runs[1]?.signal.aborted).toBe(true);
    release = true;
    await stub.flush();
    await vi.waitFor(() => expect(world.sent).toEqual(["Got it, both."]));

    // Every call has its result row, and the interrupted turn's memory block stays in place.
    expect(world.requests[1]?.messages).toEqual([
      withMemory("check a, b and c"),
      toolUse([
        { id: "call-0", name: "fast", input: { q: "a" } },
        { id: "call-1", name: "slow", input: { q: "b" } },
        { id: "call-2", name: "fast", input: { q: "c" } },
      ]),
      // The call that was running may have done its work; the next one never started.
      results(
        { callId: "call-0", output: "found a" },
        { callId: "call-1", output: TOOL_STOPPED_RESULT, isError: true },
        { callId: "call-2", output: TOOL_NOT_RUN_RESULT, isError: true },
      ),
      user("and also d"),
    ]);
    expect(runs).toHaveLength(2);
    // The interrupted turn answered nothing, so the next recall asks about both messages.
    expect(world.recalls[1]?.question).toBe("check a, b and c\nand also d");
  });

  it("closes the calls an eviction left open before calling the model again", async () => {
    const world = use(fakeWorld([toolCalls({ name: "stuck" }), reply("Recovered.")]));
    world.memory = MEMORY;
    provide(world, { stuck: () => new Promise<ToolOutcome>(() => {}) });
    const stub = agent("tools-evicted");
    await stub.ingest(message("m1", "try the stuck one"));
    await stub.flush();
    await vi.waitFor(async () => expect(await history(stub)).toHaveLength(2));

    await evictDurableObject(stub);
    await runDurableObjectAlarm(stub);
    await vi.waitFor(() => expect(world.sent).toEqual(["Recovered."]));

    // The block sent with the first round stays; recall doesn't run again for the same turn.
    expect(world.recalls).toHaveLength(1);
    expect(world.requests[1]).not.toHaveProperty("context");
    expect(world.requests[1]?.messages).toEqual([
      withMemory("try the stuck one"),
      toolUse([{ id: "call-0", name: "stuck", input: {} }]),
      results({ callId: "call-0", output: TOOL_STOPPED_RESULT, isError: true }),
    ]);
  });

  it("drops a recovered turn's native output when its tools changed during the eviction", async () => {
    const world = use(fakeWorld([toolCalls({ name: "stuck" }), reply("Recovered.")]));
    provide(world, { stuck: () => new Promise<ToolOutcome>(() => {}) });
    const stub = agent("tools-evicted-changed");
    await stub.ingest(message("m1", "try the stuck one"));
    await stub.flush();
    await vi.waitFor(async () => expect(await history(stub)).toHaveLength(2));

    // A provider arrives while the object is away.
    provide(world, { stuck: () => new Promise<ToolOutcome>(() => {}), lookup: answer });
    await evictDurableObject(stub);
    await runDurableObjectAlarm(stub);
    await vi.waitFor(() => expect(world.sent).toEqual(["Recovered."]));

    expect(world.requests[1]?.tools).toHaveLength(2);
    expect(world.requests[1]?.messages[1]).toEqual({
      role: "assistant",
      parts: [{ type: "tool_call", id: "call-0", name: "stuck", input: {} }],
    });
  });

  it("drops a recovered turn's native output when a deploy edited built-in prompt text meanwhile", async () => {
    const world = use(fakeWorld([toolCalls({ name: "stuck" }), reply("Recovered.")]));
    provide(world, { stuck: () => new Promise<ToolOutcome>(() => {}) });
    const stub = agent("tools-evicted-deploy");
    await stub.ingest(message("m1", "try the stuck one"));
    await stub.flush();
    await vi.waitFor(async () => expect(await history(stub)).toHaveLength(2));

    // The first round ran under the built-in text of an earlier deploy.
    await runInDurableObject(stub, (_instance: ConversationAgent, state) => {
      state.storage.sql.exec("UPDATE turns SET prompt_key = ?", "an earlier deploy's key");
    });
    await evictDurableObject(stub);
    await runDurableObjectAlarm(stub);
    await vi.waitFor(() => expect(world.sent).toEqual(["Recovered."]));

    expect(world.requests[1]?.messages[1]).toEqual({
      role: "assistant",
      parts: [{ type: "tool_call", id: "call-0", name: "stuck", input: {} }],
    });
  });

  it("keeps a refused turn's memory block once its calls are in history", async () => {
    const world = use(fakeWorld([toolCalls({ name: "lookup", input: { q: "a" } })]));
    world.memory = MEMORY;
    provide(world, { lookup: answer });
    // The second round is refused.
    const refusing = world.ports.generate;
    let rounds = 0;
    world.ports.generate = async (tier, request) => {
      rounds += 1;
      if (rounds !== 2) return refusing(tier, request);
      world.requests.push(structuredClone(request));
      return {
        events: (async function* () {
          yield {
            type: "finish" as const,
            reason: "refusal" as const,
            message: { role: "assistant" as const, parts: [] },
            usage: [],
          };
        })(),
        cancel() {},
      };
    };
    const stub = agent("tools-refused");
    await stub.ingest(message("m1", "look it up"));
    await stub.flush();
    await settled(stub);
    expect((await stub.turns()).at(-1)?.status).toBe("refused");

    expect((await history(stub))[0]).toEqual(withMemory("look it up"));
  });
});

describe("a turn's tools in history", () => {
  it("never cuts a checkpoint between a call and its result", async () => {
    const world = use(
      fakeWorld([
        reply("r0"),
        sayThenCall("SAID BEFORE", { name: "lookup", input: { q: "a" } }),
        reply("r1"),
        reply("r2"),
        reply("r3", OVER_BUDGET),
        reply("THE SUMMARY"),
        reply("r4"),
      ]),
    );
    provide(world, { lookup: answer });
    const stub = agent("tools-checkpoint");
    for (const [index, text] of ["q0", "q1", "q2", "q3"].entries()) {
      await stub.ingest(message(`m${index}`, text));
      await stub.flush();
      await vi.waitFor(async () => expect((await stub.turns()).at(-1)?.status).toBe("delivered"));
    }

    // The latest six rows start on q1's tool result; the cut moves on to the next user row.
    await stub.compact();
    const summarized = world.requests.at(-1)?.messages[0];
    const input = summarized?.role === "user" ? (summarized.parts[0]?.text ?? "") : "";
    for (const text of ["q0", "r0", "q1", "r1"]) expect(input).toContain(text);
    // Rows without text of their own leave no blank line, and what the model said before its calls
    // never reached the person, so it stays out.
    expect(input).not.toMatch(/assistant: (\n|$)/);
    expect(input).not.toContain("SAID BEFORE");

    await stub.ingest(message("m4", "q4"));
    await stub.flush();
    await vi.waitFor(() => expect(world.sent.at(-1)).toBe("r4"));
    const next = world.requests.at(-1)?.messages ?? [];
    expect(next.map((row) => row.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
  });

  it("leaves calls and results out of the session page, which records what the person saw", async () => {
    const world = use(
      fakeWorld([
        sayThenCall("Let me check.", { name: "lookup", input: { q: "a" } }),
        reply("Done."),
      ]),
    );
    provide(world, { lookup: answer });
    const stub = agent("tools-session");
    await stub.ingest(message("m1", "look it up"));
    await stub.flush();
    await vi.waitFor(() => expect(world.sent).toEqual(["Done."]));

    await stub.closeSession();
    const page = world.remembered[0]?.changes[0]?.content ?? "";
    expect(page).toContain("look it up");
    expect(page).toContain("Done.");
    expect(page).not.toContain("found a");
    // Said before the calls, but never delivered.
    expect(page).not.toContain("Let me check.");
  });
});

describe("a turn's steps", () => {
  it("keeps typing up on Telegram, which shows no steps", async () => {
    const world = use(fakeWorld([toolCalls({ name: "lookup" }), reply("Done.")]));
    provide(world, { lookup: answer });
    const stub = agent("tools-telegram-steps");
    await stub.ingest(message("m1", "go"));
    await stub.flush();
    await vi.waitFor(() => expect(world.sent).toEqual(["Done."]));
    expect(world.steps).toEqual([]);
    expect(world.typingKept).toBe(1);
  });
});
