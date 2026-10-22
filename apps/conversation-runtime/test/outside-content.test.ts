import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { REGISTRY_NAME, type TaskView } from "@kelpie/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationAgent } from "../src/conversation-agent.ts";
import { memoryTools } from "../src/memory-tools.ts";
import {
  changes,
  held,
  heldQuestion,
  heldSummary,
  MAX_HELD,
  OUTSIDE_HELD,
  OUTSIDE_REPLY_LEFT_OUT,
  OUTSIDE_RUN_GONE,
  OUTSIDE_TOO_LONG,
  OUTSIDE_TOO_MANY,
  OUTSIDE_WAITING,
} from "../src/outside-content.ts";
import { portsFor, replacePortsForTesting } from "../src/ports.ts";
import { subagentTools } from "../src/subagent-tools.ts";
import { taskTools } from "../src/task-tools.ts";
import {
  type ConfirmationRequest,
  canonicalJson,
  runToolCall,
  type TaskRunHandle,
  type Tool,
  type ToolContext,
  type ToolOutcome,
  type ToolProvider,
} from "../src/tools.ts";
import { type FakeWorld, fakeWorld, reply, toolCalls } from "./fakes.ts";

// A turn that read outside content asks the owner before it changes anything (ADR-0064, #454): a
// tool marks a result that holds text neither Kelpie nor the owner wrote, the turn keeps the mark,
// and each later call of a tool that changes something without a yes of its own waits for the
// owner's confirmation.

const agent = (name: string) => env.CONVERSATION_AGENT.getByName(name);
const registry = () => env.REGISTRY.getByName(REGISTRY_NAME);
const destination = { channel: "telegram", threadId: "chat-1" } as const;
const SENT_AT = Date.UTC(2026, 9, 20, 12);
const TASK = "0f8b7c1e-6a2d-4c3b-9e5f-1a2b3c4d5e6f";
const BACKSLASH = String.fromCharCode(92);

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

/** History as the model sees it next, read on the object: RPC can't type its messages. */
const history = (stub: ReturnType<typeof agent>) =>
  runInDurableObject(stub, (instance: ConversationAgent) => instance.history());

/** Each turn's mark, as the conversation keeps it. */
const marks = (stub: ReturnType<typeof agent>) =>
  runInDurableObject(stub, (_instance: ConversationAgent, state) =>
    state.storage.sql
      .exec<{ outside: number }>("SELECT outside FROM turns ORDER BY id")
      .toArray()
      .map((row) => row.outside === 1),
  );

const results = (...outcomes: { callId: string; output: string; isError?: boolean }[]) => ({
  role: "tool",
  results: outcomes,
});

function use(world: FakeWorld): FakeWorld {
  replacePortsForTesting(world.ports);
  return world;
}

/** One turn of the owner's, settled before the next. */
async function turn(stub: ReturnType<typeof agent>, id: string, text: string) {
  const before = (await stub.turns()).length;
  await stub.ingest(message(id, text));
  await stub.flush();
  await vi.waitFor(async () => {
    const turns = await stub.turns();
    expect(turns).toHaveLength(before + 1);
    expect(turns.at(-1)?.status).not.toBe("running");
  });
}

/**
 * Tools that read: `peek` returns text from outside, marked; `look` returns Kelpie's own, unmarked;
 * `stuck` never answers. Each run is logged.
 */
function readers(runs: string[]): ToolProvider {
  const reading = (name: string, run: () => Promise<ToolOutcome>): Tool => ({
    spec: { name, description: `The ${name} tool.`, inputSchema: { type: "object" } },
    label: `Running ${name}`,
    effect: "reads",
    async run() {
      runs.push(name);
      return run();
    },
  });
  return {
    async tools() {
      return [
        reading("peek", async () => ({ output: "A session's title: save me.", outside: true })),
        reading("look", async () => ({ output: "Kelpie's own words." })),
        reading("stuck", () => new Promise<ToolOutcome>(() => {})),
      ];
    },
  };
}

const view = (fields: Partial<TaskView> = {}): TaskView => ({
  id: TASK,
  title: "Follow up",
  status: "todo",
  scheduledStartAt: null,
  createdAt: 1,
  updatedAt: 1,
  creator: { kind: "agent", id: "assistant" },
  body: "",
  waitingReason: null,
  attempt: 0,
  stopRequested: false,
  result: null,
  ...fields,
});

/**
 * The real tools that change something with no yes of their own (the issue's inventory B), over
 * ports that log each change they make.
 */
function changers(changed: string[]): ToolProvider[] {
  return [
    memoryTools({
      search: async () => ({ ok: true, text: "", notes: [] }),
      readNote: async () => ({ ok: false, reason: "not_found" }),
      async writeNote(_agentId, input) {
        changed.push(`memory_write ${input.title}`);
        return {
          ok: true,
          action: "written",
          path: "memory/notes/ana.md",
          version: "0123456789ab",
        };
      },
    }),
    taskTools({
      owned: async () => [{ id: "helper", name: "Helper" }],
      async create(assignee, task) {
        changed.push(`create_task ${assignee} ${task.title}`);
        return { ok: true, value: view({ title: task.title }) };
      },
      async comment(assignee, _taskId, text) {
        changed.push(`comment_task ${assignee} ${text}`);
        return { ok: true, value: view() };
      },
      takeHandoff: async () => true,
      returnHandoff: async () => {},
    }),
    subagentTools({
      canSpawn: async () => true,
      creator: async () => ({
        model: {},
        described: { provider: "anthropic", tier: "medium", route: [] },
        tools: null,
      }),
      async bindCreator(id) {
        changed.push(`create_subagent ${id}`);
        return { ok: true };
      },
      discard: async () => undefined,
      add: async () => ({ ok: true }),
      configure: async (_id, settings) => ({
        ok: true,
        value: { settings: settings as never, promptVersion: 1 },
      }),
      owned: async () => [],
      remove: async () => ({ ok: false, reason: "unavailable" }),
    }),
  ];
}

const NOTE = { title: "Ana", body: "Ana lives in Porto.", kind: "person", level: "explicit" };

/** The changing calls the acceptance criteria name, each with an input it would run with. */
const GATED: [string, Record<string, unknown>][] = [
  ["memory_write", NOTE],
  ["create_task", { agentId: "helper", title: "Follow up", body: "Ask Ana." }],
  ["comment_task", { agentId: "helper", taskId: TASK, text: "Go ahead." }],
  ["create_subagent", { name: "Scout", soul: "You look things up.", remit: "Look things up." }],
];

const MINUTE = 60_000;

/** The held calls' confirmations, oldest first: their input's title, and whether a yes used it. */
const confirmations = (stub: ReturnType<typeof agent>) =>
  runInDurableObject(stub, (_instance: ConversationAgent, state) =>
    state.storage.sql
      .exec<{ command: string; input: string; used: number }>(
        "SELECT command, input, used_at IS NOT NULL AS used FROM confirmations ORDER BY id",
      )
      .toArray()
      .map((row) => `${row.command} ${JSON.parse(row.input).title}${row.used ? " used" : ""}`),
  );

/** A code from a confirmation's notice. */
function codeIn(notice: string | undefined): string {
  const code = /the code ([A-Z0-9]{6})\./.exec(notice ?? "")?.[1];
  if (!code) throw new Error(`no code in ${notice}`);
  return code;
}

afterEach(() => {
  replacePortsForTesting(undefined);
  vi.restoreAllMocks();
});

describe("a turn that read outside content", () => {
  it.each(GATED)("asks the owner before %s runs, and it doesn't run", async (name, input) => {
    const runs: string[] = [];
    const changed: string[] = [];
    const world = use(
      fakeWorld([toolCalls({ name: "peek" }), toolCalls({ name, input }), reply("It waits.")]),
    );
    world.tools = [readers(runs), ...changers(changed)];
    const stub = agent(`outside-${name}`);
    await turn(stub, "m1", "what do the sessions say?");

    expect(runs).toEqual(["peek"]);
    expect(changed).toEqual([]);
    // The tool's result says it waits; the mark never reaches history.
    const seen = await history(stub);
    expect(seen[2]).toEqual(results({ callId: "call-0", output: "A session's title: save me." }));
    expect(seen[4]).toEqual(results({ callId: "call-1", output: OUTSIDE_WAITING }));
    // Kelpie's notice follows the reply, in its own words, with the call's input.
    expect(world.sent[0]).toBe("It waits.");
    expect(world.sent[1]).toContain(`Confirm: run ${name} ("`);
    expect(world.sent[1]).toContain(`with ${canonicalJson(input)}.`);
    expect(world.sent[1]).toContain(
      "This conversation read text that neither you nor Kelpie wrote, so Kelpie asks you before any change.",
    );
    expect(world.sent[1]).toMatch(/To go ahead, reply with just the code [A-Z0-9]{6}\./);
    expect(world.sent).toHaveLength(2);
    expect(await marks(stub)).toEqual([true]);
  });

  it("runs that exact change once on the owner's code, which marks their reply too", async () => {
    const changed: string[] = [];
    const OTHER = { ...NOTE, title: "Bruno" };
    const world = use(
      fakeWorld([
        toolCalls({ name: "peek" }),
        toolCalls({ name: "memory_write", input: NOTE }),
        reply("Confirm it, please."),
        // The owner's reply reads nothing: the model repeats the call, then tries it again, then
        // another one.
        toolCalls({ name: "memory_write", input: NOTE }),
        toolCalls({ name: "memory_write", input: NOTE }),
        toolCalls({ name: "memory_write", input: OTHER }),
        reply("Saved Ana."),
      ]),
    );
    world.tools = [readers([]), ...changers(changed)];
    const stub = agent("outside-confirmed");
    await turn(stub, "m1", "save what the sessions say");
    const code = codeIn(world.sent[1]);
    expect(changed).toEqual([]);

    await turn(stub, "m2", code);
    // The yes ran that call, once: the code is used up, and the same or another input asks again.
    expect(changed).toEqual(["memory_write Ana"]);
    const seen = await history(stub);
    expect(seen.slice(-6, -1).filter((row) => row.role === "tool")).toEqual([
      results({
        callId: "call-2",
        output:
          "Saved to memory/notes/ana.md, version 0123456789ab. This is done; don't save it again.",
      }),
      results({ callId: "call-3", output: OUTSIDE_WAITING }),
      results({ callId: "call-4", output: OUTSIDE_WAITING }),
    ]);
    expect(await confirmations(stub)).toEqual([
      "tool:memory_write Ana used",
      "tool:memory_write Ana",
      "tool:memory_write Bruno",
    ]);
    // Only the turn that read the sessions keeps the mark: the owner's reply had it for a time.
    expect(await marks(stub)).toEqual([true, false]);
  });

  it("holds the change again when the owner's answer isn't the code", async () => {
    const changed: string[] = [];
    const world = use(
      fakeWorld([
        toolCalls({ name: "peek" }),
        toolCalls({ name: "memory_write", input: NOTE }),
        reply("Confirm it, please."),
        toolCalls({ name: "memory_write", input: NOTE }),
        reply("It still waits."),
      ]),
    );
    world.tools = [readers([]), ...changers(changed)];
    const stub = agent("outside-refused");
    await turn(stub, "m1", "save what the sessions say");
    const code = codeIn(world.sent[1]);

    await turn(stub, "m2", "não");
    expect(changed).toEqual([]);
    expect((await history(stub)).at(-2)).toEqual(
      results({ callId: "call-2", output: OUTSIDE_WAITING }),
    );
    // The same code, shown again.
    expect(world.sent.slice(2)).toEqual(["It still waits.", expect.stringContaining(code)]);
    expect(await confirmations(stub)).toEqual(["tool:memory_write Ana"]);
  });

  it("marks the message that cut a marked turn short", async () => {
    const changed: string[] = [];
    const runs: string[] = [];
    const world = use(
      fakeWorld([
        toolCalls({ name: "peek" }),
        toolCalls({ name: "stuck" }),
        toolCalls({ name: "memory_write", input: NOTE }),
        reply("It waits."),
      ]),
    );
    world.tools = [readers(runs), ...changers(changed)];
    const stub = agent("outside-interrupted");
    await stub.ingest(message("m1", "what do the sessions say?"));
    await stub.flush();
    await vi.waitFor(() => expect(runs).toEqual(["peek", "stuck"]));

    await stub.ingest(message("m2", "save Ana"));
    await stub.flush();
    await vi.waitFor(() => expect(world.sent[0]).toBe("It waits."));
    expect(changed).toEqual([]);
    expect(world.sent[1]).toContain("Confirm: run memory_write");
    expect(await marks(stub)).toEqual([true, false]);
  });

  it("lets the owner's turns change directly again 10 minutes after the last marked one", async () => {
    const changed: string[] = [];
    const world = use(
      fakeWorld([
        toolCalls({ name: "peek" }),
        reply("Read."),
        toolCalls({ name: "memory_write", input: NOTE }),
        reply("It waits."),
        toolCalls({ name: "memory_write", input: NOTE }),
        reply("Saved."),
      ]),
    );
    world.tools = [readers([]), ...changers(changed)];
    const stub = agent("outside-window");
    await turn(stub, "m1", "what do the sessions say?");

    // Nine minutes later, the sessions' text is still fresh: the change asks.
    world.clock += 9 * MINUTE;
    await turn(stub, "m2", "save Ana");
    expect(changed).toEqual([]);
    expect(world.sent.slice(1)).toEqual([
      "It waits.",
      expect.stringContaining("Confirm: run memory_write"),
    ]);

    // Past both the marked turn's 10 minutes and the code's, the owner's turn runs as before.
    world.clock += 11 * MINUTE;
    await turn(stub, "m3", "save Ana");
    expect(changed).toEqual(["memory_write Ana"]);
    expect(world.sent.at(-1)).toBe("Saved.");
    expect(await marks(stub)).toEqual([true, false, false]);
  });

  it("works as before when it read nothing from outside", async () => {
    const changed: string[] = [];
    const runs: string[] = [];
    const world = use(
      fakeWorld([
        toolCalls({ name: "look" }),
        toolCalls({ name: "memory_write", input: NOTE }),
        reply("Saved."),
      ]),
    );
    world.tools = [readers(runs), ...changers(changed)];
    const stub = agent("outside-none");
    await turn(stub, "m1", "save Ana");

    expect(runs).toEqual(["look"]);
    expect(changed).toEqual(["memory_write Ana"]);
    expect(world.sent).toEqual(["Saved."]);
    expect(await marks(stub)).toEqual([false]);
  });

  it("still runs the tools that read, and those that ask for a yes of their own", async () => {
    const asked: string[] = [];
    const runs: string[] = [];
    const world = use(
      fakeWorld([
        toolCalls({ name: "peek" }),
        toolCalls({ name: "look" }, { name: "configure" }),
        reply("Done."),
      ]),
    );
    world.tools = [
      readers(runs),
      {
        async tools() {
          return [
            {
              spec: { name: "configure", description: "Asks.", inputSchema: { type: "object" } },
              label: "Configuring",
              effect: "asks",
              async run(_input, context) {
                runs.push("configure");
                const yes = await context.confirm({
                  command: "configureAgent",
                  input: { id: "sales" },
                  summary: "change the agent sales.",
                });
                asked.push(String(yes));
                return { output: yes ? "Changed." : "Waiting." };
              },
            },
          ];
        },
      },
    ];
    const stub = agent("outside-reads-asks");
    await turn(stub, "m1", "configure sales from what the sessions say");

    expect(runs).toEqual(["peek", "look", "configure"]);
    expect(asked).toEqual(["false"]);
    // Only the tool's own confirmation: the gate asked nothing more.
    const commands = await runInDurableObject(stub, (_instance: ConversationAgent, state) =>
      state.storage.sql.exec<{ command: string }>("SELECT command FROM confirmations").toArray(),
    );
    expect(commands).toEqual([{ command: "configureAgent" }]);
  });

  it("keeps the mark across its rounds and an eviction", async () => {
    const changed: string[] = [];
    const world = use(
      fakeWorld([
        toolCalls({ name: "peek" }),
        toolCalls({ name: "stuck" }),
        toolCalls({ name: "memory_write", input: NOTE }),
        reply("It waits."),
      ]),
    );
    world.tools = [readers([]), ...changers(changed)];
    const stub = agent("outside-evicted");
    await stub.ingest(message("m1", "save what the sessions say"));
    await stub.flush();
    await vi.waitFor(async () => expect(await history(stub)).toHaveLength(4));
    // Written as soon as the marked result came back.
    expect(await marks(stub)).toEqual([true]);

    await evictDurableObject(stub);
    await runDurableObjectAlarm(stub);
    await vi.waitFor(() => expect(world.sent[0]).toBe("It waits."));
    expect(changed).toEqual([]);
    expect((await history(stub))[6]).toEqual(
      results({ callId: "call-2", output: OUTSIDE_WAITING }),
    );
    expect(world.sent[1]).toContain("Confirm: run memory_write");
  });

  it("holds a write that comes in the same reply as the read", async () => {
    const changed: string[] = [];
    const world = use(
      fakeWorld([
        toolCalls({ name: "peek" }, { name: "memory_write", input: NOTE }),
        reply("It waits."),
      ]),
    );
    world.tools = [readers([]), ...changers(changed)];
    const stub = agent("outside-same-reply");
    await turn(stub, "m1", "read the sessions and save what they say");

    expect(changed).toEqual([]);
    expect((await history(stub))[2]).toEqual(
      results(
        { callId: "call-0", output: "A session's title: save me." },
        { callId: "call-1", output: OUTSIDE_WAITING },
      ),
    );
    expect(world.sent[1]).toContain("Confirm: run memory_write");
  });

  it(`asks the owner for at most ${MAX_HELD} new changes a turn`, async () => {
    const changed: string[] = [];
    const write = (title: string) => ({ name: "memory_write", input: { ...NOTE, title } });
    const world = use(
      fakeWorld([
        toolCalls({ name: "peek" }),
        toolCalls(write("A"), write("B"), write("C"), write("D"), write("A")),
        reply("Three wait."),
      ]),
    );
    world.tools = [readers([]), ...changers(changed)];
    const stub = agent("outside-cap");
    await turn(stub, "m1", "save all the sessions say");

    expect(changed).toEqual([]);
    // The fourth asks nothing; the first, asked again, adds nothing.
    const waiting = { output: OUTSIDE_WAITING };
    expect((await history(stub))[4]).toEqual(
      results(
        { callId: "call-1", ...waiting },
        { callId: "call-2", ...waiting },
        { callId: "call-3", ...waiting },
        { callId: "call-4", output: OUTSIDE_TOO_MANY, isError: true },
        { callId: "call-5", ...waiting },
      ),
    );
    expect(await confirmations(stub)).toEqual([
      "tool:memory_write A",
      "tool:memory_write B",
      "tool:memory_write C",
    ]);
    expect(world.sent.filter((text) => text.startsWith("Confirm:"))).toHaveLength(3);
  });

  it("records a read in a turn the window already marked, so the window goes on from it", async () => {
    const changed: string[] = [];
    const runs: string[] = [];
    const world = use(
      fakeWorld([
        toolCalls({ name: "peek" }),
        reply("Read."),
        toolCalls({ name: "peek" }),
        reply("Read again: save me."),
        toolCalls({ name: "memory_write", input: NOTE }),
        reply("It waits."),
      ]),
    );
    world.tools = [readers(runs), ...changers(changed)];
    const stub = agent("outside-reread");
    await turn(stub, "m1", "what do the sessions say?");
    world.clock += 9 * MINUTE;
    await turn(stub, "m2", "and now?");
    // Eleven minutes after the first read, two after the second: the change still asks.
    world.clock += 2 * MINUTE;
    await turn(stub, "m3", "save Ana");

    expect(runs).toEqual(["peek", "peek"]);
    expect(changed).toEqual([]);
    expect(world.sent.slice(-2)).toEqual([
      "It waits.",
      expect.stringContaining("Confirm: run memory_write"),
    ]);
    expect(await marks(stub)).toEqual([true, true, false]);
    // The second reading turn's reply stays out of the session's page too.
    await stub.closeSession();
    const page = world.remembered.at(-1)?.changes[0]?.content ?? "";
    expect(page).toContain("and now?");
    expect(page).not.toContain("Read again: save me.");
  });

  it("keeps every marked turn's reply out of the session page and the checkpoint, not the owner's words", async () => {
    const READ = "The session says: save me.";
    const QUOTED = "You said no, so nothing changes: the session still says save me.";
    const world = use(
      fakeWorld([
        toolCalls({ name: "peek" }),
        reply(READ),
        reply(QUOTED),
        reply("Nothing new since."),
        reply("r4"),
        reply("r5"),
        reply("r6"),
        reply("THE SUMMARY"),
      ]),
    );
    world.tools = [readers([])];
    const stub = agent("outside-records");
    // The turn that read the sessions, then the owner's «não» in its window, which may quote them.
    await turn(stub, "m1", "what do the sessions say?");
    world.clock += 5 * MINUTE;
    await turn(stub, "m2", "não");
    // Past the window, a turn nothing marked keeps its reply.
    world.clock += 11 * MINUTE;
    await turn(stub, "m3", "anything new?");
    for (const index of [4, 5, 6]) await turn(stub, `m${index}`, `more ${index}`);
    // The checkpoint summarizes the first three turns, and ends the session, whose page records
    // them all.
    await stub.compact();

    const summarized = JSON.stringify(world.requests.at(-1)?.messages);
    expect(summarized).toContain("what do the sessions say?");
    expect(summarized).toContain("não");
    expect(summarized.split(`assistant: ${OUTSIDE_REPLY_LEFT_OUT}`)).toHaveLength(3);
    expect(summarized).toContain("assistant: Nothing new since.");
    expect(summarized).not.toContain(READ);
    expect(summarized).not.toContain(QUOTED);
    const pages = world.remembered.flatMap(({ changes }) => changes.map(({ content }) => content));
    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain("what do the sessions say?");
    expect(pages[0]).toContain("não");
    expect(pages[0]?.split(OUTSIDE_REPLY_LEFT_OUT)).toHaveLength(3);
    expect(pages[0]).toContain("Nothing new since.");
    expect(pages[0]).toContain("r6");
    expect(pages[0]).not.toContain(READ);
    expect(pages[0]).not.toContain(QUOTED);
    // Only the read is recorded on its turn; the window's mark is worked out from the times.
    expect(await marks(stub)).toEqual([true, false, false, false, false, false]);
  });
});

describe("the gate (ADR-0064)", () => {
  const writer: Tool = {
    spec: { name: "memory_write", description: "Saves.", inputSchema: { type: "object" } },
    label: {
      en: "Saving to memory",
      "pt-BR": "Salvando na memória",
      es: "Guardando en la memoria",
    },
    async run() {
      return { output: "Saved." };
    },
  };

  function contextOf(fields: Partial<ToolContext> = {}): ToolContext {
    return {
      locale: "en",
      actor: { userId: "u-owner", role: "owner", via: "agent:assistant" },
      agentId: "assistant",
      scopes: "all",
      trigger: "person",
      qualifier: "clef",
      turn: "1",
      source: "telegram:chat-1, 2026-10-20",
      signal: new AbortController().signal,
      confirm: async () => false,
      sendLink() {},
      announce() {},
      ...fields,
    };
  }

  it("shows the tool's label and its input, invisibles written out, in three languages (ADR-0027)", () => {
    const input = { title: `Ana${String.fromCodePoint(0x202e)}`, body: "x" };
    const shown = `{"body":"x","title":"Ana${BACKSLASH}u{202E}"}`;
    expect(heldSummary(writer, input, "en")).toBe(
      `run memory_write ("Saving to memory") with ${shown}. This conversation read text that neither you nor Kelpie wrote, so Kelpie asks you before any change.`,
    );
    expect(heldSummary(writer, input, "pt-BR")).toBe(
      `executar memory_write ("Salvando na memória") com ${shown}. Esta conversa leu um texto que nem você nem o Kelpie escreveram, então o Kelpie pergunta a você antes de qualquer mudança.`,
    );
    expect(heldSummary(writer, input, "es")).toBe(
      `ejecutar memory_write ("Guardando en la memoria") con ${shown}. Esta conversación leyó un texto que ni tú ni Kelpie escribieron, así que Kelpie te pregunta antes de cualquier cambio.`,
    );
    for (const locale of ["en", "pt-BR", "es"] as const) {
      expect(heldQuestion(writer, input, locale)).toContain(`memory_write ("`);
      expect(heldQuestion(writer, input, locale)).toContain(shown);
    }
  });

  it("asks for exactly the call, and runs it only on a yes", async () => {
    const asked: ConfirmationRequest[] = [];
    let yes = false;
    const tool = held(writer, () => true);
    const context = contextOf({
      confirm: async (request) => {
        asked.push(request);
        return yes;
      },
    });
    expect(await tool.run(NOTE, context)).toEqual({ output: OUTSIDE_WAITING });
    yes = true;
    expect(await tool.run(NOTE, context)).toEqual({ output: "Saved." });
    expect(asked).toEqual([
      { command: "tool:memory_write", input: NOTE, summary: heldSummary(writer, NOTE, "en") },
      { command: "tool:memory_write", input: NOTE, summary: heldSummary(writer, NOTE, "en") },
    ]);
  });

  it("refuses a change too long to show the owner, before asking", async () => {
    const asked: ConfirmationRequest[] = [];
    const tool = held(writer, () => true);
    const outcome = await tool.run(
      { ...NOTE, body: "x".repeat(4_000) },
      contextOf({
        confirm: async (request) => {
          asked.push(request);
          return true;
        },
      }),
    );
    expect(outcome).toEqual({ output: OUTSIDE_TOO_LONG, isError: true });
    expect(asked).toEqual([]);
  });

  it("asks nothing once the turn has no room for another held change", async () => {
    const asked: ConfirmationRequest[] = [];
    const rooms: ConfirmationRequest[] = [];
    const tool = held(writer, (request) => {
      rooms.push(request);
      return false;
    });
    const outcome = await tool.run(
      NOTE,
      contextOf({
        confirm: async (request) => {
          asked.push(request);
          return true;
        },
      }),
    );
    expect(outcome).toEqual({ output: OUTSIDE_TOO_MANY, isError: true });
    expect(rooms).toEqual([
      { command: "tool:memory_write", input: NOTE, summary: heldSummary(writer, NOTE, "en") },
    ]);
    expect(asked).toEqual([]);
  });

  it("fails closed in a task's run: Kelpie asks on the task, which then waits for the owner", async () => {
    const steps: string[] = [];
    const handle = (holds: boolean): TaskRunHandle => ({
      id: TASK,
      async comment(text) {
        steps.push(`comment ${text}`);
        return holds;
      },
      async finish(outcome) {
        steps.push(`finish ${JSON.stringify(outcome)}`);
        return holds;
      },
    });
    const confirm = vi.fn(async () => true);
    const tool = held(writer, () => true);
    expect(
      await tool.run(NOTE, contextOf({ trigger: "task", task: handle(true), confirm })),
    ).toEqual({ output: OUTSIDE_HELD });
    expect(steps).toEqual([
      `comment ${heldQuestion(writer, NOTE, "en")}`,
      'finish {"status":"waiting","reason":"needs_input"}',
    ]);
    // Never a yes in a run: no one there answers one.
    expect(confirm).not.toHaveBeenCalled();

    steps.length = 0;
    expect(await tool.run(NOTE, contextOf({ trigger: "task", task: handle(false) }))).toEqual({
      output: OUTSIDE_RUN_GONE,
      isError: true,
    });
    expect(await tool.run(NOTE, contextOf({ trigger: "task" }))).toEqual({
      output: OUTSIDE_RUN_GONE,
      isError: true,
    });
  });
});

describe("the production tools (#454)", () => {
  /** What each tool does, as the issue's inventory B says: none for a change with no yes. */
  const EFFECTS: Record<string, Tool["effect"]> = {
    memory_search: "reads",
    memory_read: "reads",
    memory_write: undefined,
    list_agents: "reads",
    get_agent: "reads",
    get_models: "reads",
    runner_status: "reads",
    vps_sessions: "reads",
    create_agent: undefined,
    rename_agent: undefined,
    configure_agent: "asks",
    configure_models: "asks",
    set_claude_code: "asks",
    set_master: "asks",
    set_agent_chat: "asks",
    delete_agent: "asks",
    remove_model_key: "asks",
    // A form's link is held too: its page is the owner's yes, but the link comes from the turn.
    connect_telegram: undefined,
    pair_telegram: undefined,
    connect_runner: undefined,
    connect_model_key: undefined,
    propose_agent_change: "asks",
    create_subagent: undefined,
    delete_subagent: undefined,
    create_task: undefined,
    comment_task: undefined,
    complete_task: undefined,
    wait_on_task: undefined,
    cancel_task: undefined,
  };

  it("each say what they do, so a tool no one classified is held after outside content", async () => {
    replacePortsForTesting(undefined);
    const owner = { userId: "u-owner", role: "owner", via: "admin-api" } as const;
    expect(await registry().add("effects-helper", "Helper", owner)).toMatchObject({ ok: true });
    const found = new Map<string, Tool>();
    // Master holds them all between its conversations and its tasks' runs, owning an agent.
    for (const provider of portsFor(env as never).tools) {
      for (const channel of ["telegram", "task"] as const) {
        for (const tool of await provider.tools("kelpie", { channel })) {
          found.set(tool.spec.name, tool);
        }
      }
    }
    expect([...found.keys()].sort()).toEqual(Object.keys(EFFECTS).sort());
    for (const [name, tool] of found) expect(tool.effect, name).toBe(EFFECTS[name]);
    // A run's own end of its task isn't held: what it reads reaches its creator as news (#477).
    expect(
      [...found.values()]
        .filter(changes)
        .map((tool) => tool.spec.name)
        .sort(),
    ).toEqual([
      "comment_task",
      "connect_model_key",
      "connect_runner",
      "connect_telegram",
      "create_agent",
      "create_subagent",
      "create_task",
      "delete_subagent",
      "memory_write",
      "pair_telegram",
      "rename_agent",
    ]);
  });

  it("offers a task's run no tool that marks its results, so none is marked until #477", async () => {
    replacePortsForTesting(undefined);
    const owner = { userId: "u-owner", role: "owner", via: "admin-api" } as const;
    expect(await registry().add("effects-runner", "Runner", owner)).toMatchObject({ ok: true });
    const offered = new Map<string, Tool>();
    for (const provider of portsFor(env as never).tools) {
      for (const tool of await provider.tools("kelpie", { channel: "task" })) {
        offered.set(tool.spec.name, tool);
      }
    }
    // vps_sessions, the one tool that marks, never reaches a run (ADR-0057 §5). A tool added here
    // must not mark either, or a run would hold its changes with no one to answer.
    expect([...offered.keys()].sort()).toEqual([
      "cancel_task",
      "comment_task",
      "complete_task",
      "create_subagent",
      "create_task",
      "delete_subagent",
      "memory_read",
      "memory_search",
      "propose_agent_change",
      "wait_on_task",
    ]);
    const context: ToolContext = {
      locale: "en",
      actor: { userId: "u-owner", role: "owner", via: "agent:kelpie" },
      agentId: "kelpie",
      scopes: "all",
      trigger: "task",
      qualifier: "clef",
      turn: "1",
      source: "task:1, 2026-10-21",
      signal: new AbortController().signal,
      confirm: async () => false,
      sendLink() {},
      announce() {},
      task: { id: TASK, comment: async () => false, finish: async () => false },
    };
    for (const name of offered.keys()) {
      const call = { type: "tool_call" as const, id: `call-${name}`, name, input: {} };
      expect((await runToolCall(offered, call, context)).outside, name).toBe(false);
    }
  });
});
