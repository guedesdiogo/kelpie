import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { REGISTRY_NAME } from "@kelpie/config";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceTaskRunnerForTesting } from "../src/agent-host/agent-host.ts";
import { replacePortsForTesting } from "../src/ports.ts";
import { taskTools } from "../src/task-tools.ts";
import { type FakeWorld, fakeWorld, refuse, reply, toolCalls, toolCallsAfter } from "./fakes.ts";

// The mandatory handoff (ADR-0036 §4, #287): the main agent's prompt lists the specialists it owns
// with their remits, and Kelpie, not the model, announces each task the main agent hands one.

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
      create: (assignee, task, creator) => host(assignee).createTaskFor(task, creator),
      comment: (assignee, taskId, text, by) =>
        host(assignee).commentTaskAs(taskId, text, by, "chat"),
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
  it("lists the specialists and their remits in the main agent's prompt, and announces the handoff after the reply", async () => {
    const world = use(fakeWorld([handOff("Quote"), reply("Sales is on it.")]));
    const main = agent("kelpie:telegram:handoff-en");
    await main.ingest(message("handoff-en", "m1", "Quote the Silva bakery for 40 loaves a week."));
    await main.flush();

    await vi.waitFor(() =>
      expect(world.sent).toEqual(["Sales is on it.", "Kelpie handed a task to Sales (hf-sales)."]),
    );
    const system = world.requests[0]?.system ?? "";
    expect(system).toContain("# Your specialists");
    expect(system).toContain('- hf-sales ("Sales"): Quotes and follow-ups for wholesale clients.');
    expect(system).toContain('- hf-blank ("Blank"): no remit set');
    expect((await host("hf-sales").listTasks()).map((task) => task.title)).toContain("Quote");
    // The notice is Kelpie's: the model never sees it.
    expect(JSON.stringify(await main.history())).not.toContain("Kelpie handed");
  });

  it("says it in the conversation's language", async () => {
    const world = use(fakeWorld([handOff("Orçamento"), reply("A Sales já está cuidando disso.")]));
    const main = agent("kelpie:telegram:handoff-pt");
    await main.ingest(
      message(
        "handoff-pt",
        "m1",
        "Preciso de um orçamento para a Padaria Silva, com entrega toda semana, por favor.",
      ),
    );
    await main.flush();
    await vi.waitFor(() =>
      expect(world.sent).toEqual([
        "A Sales já está cuidando disso.",
        "O Kelpie passou uma tarefa para Sales (hf-sales).",
      ]),
    );
  });

  it("announces a handoff whose turn sent no reply with the next one, once", async () => {
    const world = use(fakeWorld([handOff("Follow up"), refuse(), reply("Here."), reply("Again.")]));
    const main = agent("kelpie:telegram:handoff-refused");
    await main.ingest(message("handoff-refused", "m1", "Follow up with the Silva bakery."));
    await main.flush();
    await vi.waitFor(async () => expect(await main.turns()).toMatchObject([{ status: "refused" }]));
    expect(world.sent).toEqual([]);

    await main.ingest(message("handoff-refused", "m2", "Anything?"));
    await main.flush();
    await vi.waitFor(() =>
      expect(world.sent).toEqual(["Here.", "Kelpie handed a task to Sales (hf-sales)."]),
    );
    await main.ingest(message("handoff-refused", "m3", "And now?"));
    await main.flush();
    await vi.waitFor(() =>
      expect(world.sent).toEqual(["Here.", "Kelpie handed a task to Sales (hf-sales).", "Again."]),
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
    const main = agent("kelpie:telegram:handoff-route");
    await main.ingest(message("handoff-route", "m1", "Quote the Silva bakery."));
    await main.flush();
    await vi.waitFor(() =>
      expect(world.sent).toEqual([
        "Sales is on it.",
        ROUTE_NOTE,
        "Kelpie handed a task to Sales (hf-sales).",
      ]),
    );
    await main.ingest(message("handoff-route", "m2", "Thanks."));
    await main.flush();
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
    const main = agent("kelpie:telegram:handoff-failed-send");
    await main.ingest(message("handoff-failed-send", "m1", "Quote the Silva bakery."));
    await main.flush();
    await vi.waitFor(() => expect(world.sent).toEqual(["Sales is on it.", ROUTE_NOTE]));
    await vi.waitFor(async () =>
      expect((await main.turns()).every((turn) => turn.status !== "running")).toBe(true),
    );

    await main.ingest(message("handoff-failed-send", "m2", "Thanks."));
    await main.flush();
    await vi.waitFor(() =>
      expect(world.sent.slice(-2)).toEqual(["Next.", "Kelpie handed a task to Sales (hf-sales)."]),
    );
  });

  it("isn't said again after an eviction cut its delivery short", async () => {
    const world = use(fakeWorld([handOff("Resumed"), reply("Sales is on it."), reply("Next.")]));
    // The notice's first send never completes: the eviction ends it, and recovery sends it again.
    world.hangSends.add(1);
    const main = agent("kelpie:telegram:handoff-evicted");
    await main.ingest(message("handoff-evicted", "m1", "Quote the Silva bakery."));
    await main.flush();
    await vi.waitFor(() => expect(world.sent).toEqual(["Sales is on it."]));

    await evictDurableObject(main);
    expect(await runDurableObjectAlarm(main)).toBe(true);
    await vi.waitFor(() =>
      expect(world.sent).toEqual(["Sales is on it.", "Kelpie handed a task to Sales (hf-sales)."]),
    );
    await vi.waitFor(async () =>
      expect(await main.turns()).toMatchObject([{ status: "delivered" }]),
    );

    await main.ingest(message("handoff-evicted", "m2", "Thanks."));
    await main.flush();
    await vi.waitFor(() =>
      expect(world.sent).toEqual([
        "Sales is on it.",
        "Kelpie handed a task to Sales (hf-sales).",
        "Next.",
      ]),
    );
  });
});
