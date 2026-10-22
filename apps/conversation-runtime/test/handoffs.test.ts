import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { REGISTRY_NAME } from "@kelpie/config";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceTaskRunnerForTesting } from "../src/agent-host/agent-host.ts";
import { replacePortsForTesting } from "../src/ports.ts";
import { taskTools } from "../src/task-tools.ts";
import { type FakeWorld, fakeWorld, refuse, reply, toolCalls, toolCallsAfter } from "./fakes.ts";

// The mandatory handoff (ADR-0036 §4, #287): Master's prompt lists the specialists it owns
// with their remits, and Kelpie, not the model, announces each task Master hands one.

const host = (agentId: string) => env.AGENT_HOST.getByName(agentId);
const agent = (name: string) => env.CONVERSATION_AGENT.getByName(name);
const registry = () => env.REGISTRY.getByName(REGISTRY_NAME);
const owner = { userId: "u-owner", role: "owner", via: "admin-api" } as const;

function use(world: FakeWorld): FakeWorld {
  world.tools = [
    taskTools({
      owned: async (id) =>
        (await registry().list())
          .filter((entry) => entry.owner === id)
          .map(({ id: agentId, name }) => ({ id: agentId, name })),
      agents: async () =>
        (await registry().list()).map((entry) => ({ id: entry.id, name: entry.name })),
      isMaster: async (id) => (await registry().get(id))?.role === "master",
      create: (assignee, task, creator) => host(assignee).createTaskFor(task, creator),
      comment: (assignee, taskId, text, by) =>
        host(assignee).commentTaskAs(taskId, text, by, "chat"),
      takeHandoff: (id) => host(id).takeHandoff(),
      returnHandoff: (id) => host(id).returnHandoff(),
    }),
  ];
  replacePortsForTesting(world.ports);
  return world;
}

const message = (thread: string, id: string, text: string) => ({
  agentId: "kelpie",
  providerMessageId: `${thread}:${id}`,
  userId: "u-owner",
  role: "owner" as const,
  chatType: "direct" as const,
  text,
  destination: { channel: "telegram" as const, threadId: thread },
  sentAt: Date.now(),
  timeZone: null,
});

/** A fallback before the turn's first call, and Kelpie's notice of it (#293). */
const SPENT = {
  type: "fallback" as const,
  failed: {
    provider: "anthropic" as const,
    model: "claude-haiku-5-5",
    code: "out_of_credits" as const,
  },
  next: { provider: "openai" as const, model: "gpt-6-luna" },
};
const ROUTE_NOTE =
  "Note: Anthropic (claude-haiku-5-5) ran out of credits, or reached its spend limit, so OpenAI (gpt-6-luna) answered.";

const handOff = (title: string) =>
  toolCalls({ name: "create_task", input: { agentId: "hf-sales", title, body: "Padaria Silva." } });

beforeAll(async () => {
  await registry().add("hf-sales", "Sales", owner);
  await host("hf-sales").configure(
    { remit: "Quotes and follow-ups for wholesale clients." },
    owner,
  );
  await registry().add("hf-blank", "Blank", owner);
});
beforeEach(() => {
  // The tasks stay on the board: no specialist runs them here.
  replaceTaskRunnerForTesting(null);
});
afterEach(() => {
  replaceTaskRunnerForTesting(undefined);
  replacePortsForTesting(undefined);
});

describe("the mandatory handoff (#287)", () => {
  it("lists the specialists and their remits in Master's prompt, and announces the handoff after the reply", async () => {
    const world = use(fakeWorld([handOff("Quote"), reply("Sales is on it.")]));
    const master = agent("kelpie:telegram:handoff-en");
    await master.ingest(
      message("handoff-en", "m1", "Quote the Silva bakery for 40 loaves a week."),
    );
    await master.flush();

    await vi.waitFor(() =>
      expect(world.sent).toEqual([
        "Sales is on it.",
        'Kelpie handed a task to "Sales" (hf-sales).',
      ]),
    );
    const system = world.requests[0]?.system ?? "";
    expect(system).toContain("# Your specialists");
    expect(system).toContain('- hf-sales ("Sales"): Quotes and follow-ups for wholesale clients.');
    expect(system).toContain('- hf-blank ("Blank"): no remit set');
    expect((await host("hf-sales").listTasks()).map((task) => task.title)).toContain("Quote");
    // The notice is Kelpie's: the model never sees it.
    expect(JSON.stringify(await master.history())).not.toContain("Kelpie handed");
  });

  it("says it in the conversation's language", async () => {
    const world = use(fakeWorld([handOff("Orçamento"), reply("A Sales já está cuidando disso.")]));
    const master = agent("kelpie:telegram:handoff-pt");
    await master.ingest(
      message(
        "handoff-pt",
        "m1",
        "Preciso de um orçamento para a Padaria Silva, com entrega toda semana, por favor.",
      ),
    );
    await master.flush();
    await vi.waitFor(() =>
      expect(world.sent).toEqual([
        "A Sales já está cuidando disso.",
        'O Kelpie passou uma tarefa para "Sales" (hf-sales).',
      ]),
    );
  });

  it("announces a handoff whose turn sent no reply with the next one, once", async () => {
    const world = use(fakeWorld([handOff("Follow up"), refuse(), reply("Here."), reply("Again.")]));
    const master = agent("kelpie:telegram:handoff-refused");
    await master.ingest(message("handoff-refused", "m1", "Follow up with the Silva bakery."));
    await master.flush();
    await vi.waitFor(async () =>
      expect(await master.turns()).toMatchObject([{ status: "refused" }]),
    );
    expect(world.sent).toEqual([]);

    await master.ingest(message("handoff-refused", "m2", "Anything?"));
    await master.flush();
    await vi.waitFor(() =>
      expect(world.sent).toEqual(["Here.", 'Kelpie handed a task to "Sales" (hf-sales).']),
    );
    await master.ingest(message("handoff-refused", "m3", "And now?"));
    await master.flush();
    await vi.waitFor(() =>
      expect(world.sent).toEqual([
        "Here.",
        'Kelpie handed a task to "Sales" (hf-sales).',
        "Again.",
      ]),
    );
  });
  it("follows a route's notice when the turn fell back, and isn't said again", async () => {
    const world = use(
      fakeWorld([
        toolCallsAfter([SPENT], {
          name: "create_task",
          input: { agentId: "hf-sales", title: "Quote", body: "Padaria Silva." },
        }),
        reply("Sales is on it."),
        reply("Next."),
      ]),
    );
    const master = agent("kelpie:telegram:handoff-route");
    await master.ingest(message("handoff-route", "m1", "Quote the Silva bakery."));
    await master.flush();
    await vi.waitFor(() =>
      expect(world.sent).toEqual([
        "Sales is on it.",
        ROUTE_NOTE,
        'Kelpie handed a task to "Sales" (hf-sales).',
      ]),
    );
    await master.ingest(message("handoff-route", "m2", "Thanks."));
    await master.flush();
    await vi.waitFor(() => expect(world.sent.at(-1)).toBe("Next."));
    expect(world.sent).toHaveLength(4);
  });

  it("is said with the next reply when its own send failed after the route's notice went out", async () => {
    const world = use(
      fakeWorld([
        toolCallsAfter([SPENT], {
          name: "create_task",
          input: { agentId: "hf-sales", title: "Retried", body: "Padaria Silva." },
        }),
        reply("Sales is on it."),
        reply("Next."),
      ]),
    );
    // The reply and the route's notice go out; the handoff's notice, the third send, fails.
    world.failSends.add(2);
    const master = agent("kelpie:telegram:handoff-failed-send");
    await master.ingest(message("handoff-failed-send", "m1", "Quote the Silva bakery."));
    await master.flush();
    await vi.waitFor(() => expect(world.sent).toEqual(["Sales is on it.", ROUTE_NOTE]));
    await vi.waitFor(async () =>
      expect((await master.turns()).every((turn) => turn.status !== "running")).toBe(true),
    );

    await master.ingest(message("handoff-failed-send", "m2", "Thanks."));
    await master.flush();
    await vi.waitFor(() =>
      expect(world.sent.slice(-2)).toEqual([
        "Next.",
        'Kelpie handed a task to "Sales" (hf-sales).',
      ]),
    );
  });

  it("isn't said again after an eviction cut its delivery short", async () => {
    const world = use(fakeWorld([handOff("Resumed"), reply("Sales is on it."), reply("Next.")]));
    // The notice's first send never completes: the eviction ends it, and recovery sends it again.
    world.hangSends.add(1);
    const master = agent("kelpie:telegram:handoff-evicted");
    await master.ingest(message("handoff-evicted", "m1", "Quote the Silva bakery."));
    await master.flush();
    await vi.waitFor(() => expect(world.sent).toEqual(["Sales is on it."]));

    await evictDurableObject(master);
    expect(await runDurableObjectAlarm(master)).toBe(true);
    await vi.waitFor(() =>
      expect(world.sent).toEqual([
        "Sales is on it.",
        'Kelpie handed a task to "Sales" (hf-sales).',
      ]),
    );
    await vi.waitFor(async () =>
      expect(await master.turns()).toMatchObject([{ status: "delivered" }]),
    );

    await master.ingest(message("handoff-evicted", "m2", "Thanks."));
    await master.flush();
    await vi.waitFor(() =>
      expect(world.sent).toEqual([
        "Sales is on it.",
        'Kelpie handed a task to "Sales" (hf-sales).',
        "Next.",
      ]),
    );
  });
  it("announces a handoff kept by the release before #342, which had no kind", async () => {
    const world = use(fakeWorld([reply("Hello."), reply("Hi.")]));
    const master = agent("kelpie:telegram:handoff-legacy");
    await master.ingest(message("handoff-legacy", "m1", "Hello?"));
    await master.flush();
    await vi.waitFor(() => expect(world.sent).toEqual(["Hello."]));
    // Two handoffs as #287 kept them, and its marker for a notice that named the first and went
    // out, left unsettled when the deploy came.
    const [first] = await master.turns();
    await runInDurableObject(master, (_instance, state) => {
      const put = (key: string, value: unknown) =>
        state.storage.sql.exec(
          "INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          key,
          JSON.stringify(value),
        );
      put("handoffs", [
        { taskId: "legacy-1", agentId: "hf-sales", name: "Sales" },
        { taskId: "legacy-2", agentId: "hf-sales", name: "Sales" },
      ]);
      put("handoffNotice", { turnId: first?.id, seq: 0, taskIds: ["legacy-1"] });
    });
    await master.ingest(message("handoff-legacy", "m2", "Anything?"));
    await master.flush();
    await vi.waitFor(() =>
      expect(world.sent).toEqual(["Hello.", "Hi.", 'Kelpie handed a task to "Sales" (hf-sales).']),
    );
  });
  it("keeps a handoff in #287's shape and a subagent's changes apart, and says them all next", async () => {
    const world = use(
      fakeWorld([
        toolCalls(
          { name: "churn" },
          {
            name: "create_task",
            input: { agentId: "hf-sales", title: "Kept", body: "Padaria Silva." },
          },
        ),
        refuse(),
        reply("Done."),
      ]),
    );
    // A tool that makes a subagent and drops it in the same turn.
    world.tools = [
      ...world.tools,
      {
        async tools() {
          return [
            {
              spec: { name: "churn", description: "x", inputSchema: { type: "object" as const } },
              label: "Churning",
              async run(_input, context) {
                context.announce({ kind: "created", agentId: "kelpie-sub-abc123", name: "Scout" });
                context.announce({ kind: "deleted", agentId: "kelpie-sub-abc123", name: "Scout" });
                return { output: "ok" };
              },
            },
          ];
        },
      },
    ];
    const master = agent("kelpie:telegram:handoff-kinds");
    await master.ingest(message("handoff-kinds", "m1", "Make one, hand off, drop it."));
    await master.flush();
    await vi.waitFor(async () =>
      expect(await master.turns()).toMatchObject([{ status: "refused" }]),
    );
    // A release before #342 reads its handoffs, and never the subagents' changes.
    const kept = await runInDurableObject(master, (_instance, state) =>
      Object.fromEntries(
        state.storage.sql
          .exec<{ key: string; value: string }>(
            "SELECT key, value FROM state WHERE key IN ('handoffs', 'subagentChanges')",
          )
          .toArray()
          .map(({ key, value }) => [key, JSON.parse(value)]),
      ),
    );
    expect(kept.handoffs).toEqual([
      { taskId: expect.any(String), agentId: "hf-sales", name: "Sales" },
    ]);
    expect(kept.subagentChanges).toEqual([
      { kind: "created", agentId: "kelpie-sub-abc123", name: "Scout" },
      { kind: "deleted", agentId: "kelpie-sub-abc123", name: "Scout" },
    ]);

    await master.ingest(message("handoff-kinds", "m2", "Well?"));
    await master.flush();
    await vi.waitFor(() =>
      expect(world.sent).toEqual([
        "Done.",
        [
          'Kelpie created the subagent "Scout" (kelpie-sub-abc123).',
          'Kelpie handed a task to "Sales" (hf-sales).',
          'Kelpie deleted the subagent "Scout" (kelpie-sub-abc123).',
        ].join("\n"),
      ]),
    );
  });

  it("keeps a task Master stopped apart, and says it after the next reply (#492)", async () => {
    const world = use(fakeWorld([toolCalls({ name: "halt" }), reply("Stopped.")]));
    world.tools = [
      ...world.tools,
      {
        async tools() {
          return [
            {
              spec: { name: "halt", description: "x", inputSchema: { type: "object" as const } },
              label: "Halting",
              async run(_input, context) {
                context.announce({
                  kind: "stopped",
                  taskId: "0f8b7c1e-6a2d-4c3b-9e5f-1a2b3c4d5e6f",
                  agentId: "hf-sales",
                  name: "Sales",
                });
                // More handoffs than a conversation keeps unsaid: none pushes the stop out.
                for (let i = 0; i < 25; i++) {
                  context.announce({
                    kind: "handoff",
                    taskId: `1a2b3c4d-0000-4000-8000-${String(i).padStart(12, "0")}`,
                    agentId: "hf-blank",
                    name: "Blank",
                  });
                }
                return { output: "ok" };
              },
            },
          ];
        },
      },
    ];
    const master = agent("kelpie:telegram:handoff-stop");
    await master.ingest(message("handoff-stop", "m1", "Stop the Silva quote."));
    await master.flush();
    await vi.waitFor(() =>
      expect(world.sent).toEqual([
        "Stopped.",
        'Kelpie handed tasks to "Blank" (hf-blank).\nKelpie stopped a task of "Sales" (hf-sales).',
      ]),
    );
    // Said once: the key that kept it is empty again, and a release before #492 never reads it.
    const kept = await runInDurableObject(master, (_instance, state) =>
      state.storage.sql
        .exec<{ value: string }>("SELECT value FROM state WHERE key = 'taskStops'")
        .toArray()
        .map(({ value }) => JSON.parse(value)),
    );
    expect(kept).toEqual([[]]);
  });
});
