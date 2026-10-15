import { env } from "cloudflare:workers";
import { agentModel, REGISTRY_NAME } from "@kelpie/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  replaceIdentitySourcesForTesting,
  replaceTaskRunnerForTesting,
} from "../src/agent-host/agent-host.ts";
import { memoryTools } from "../src/memory-tools.ts";
import { replacePortsForTesting } from "../src/ports.ts";
import { SUBAGENT_TOOLS } from "../src/subagent-limits.ts";
import { subagentTools } from "../src/subagent-tools.ts";
import { taskTools } from "../src/task-tools.ts";
import { type FakeWorld, fakeWorld, reply, toolCalls } from "./fakes.ts";

// A main agent's temporary subagent, end to end (ADR-0036 §5, #290): it creates one for a demand,
// hands it a task, hears the result, and deletes it. The subagent reads only its creator's memory,
// with only a subagent's tools.

const host = (agentId: string) => env.AGENT_HOST.getByName(agentId);
const agent = (name: string) => env.CONVERSATION_AGENT.getByName(name);
const registry = () => env.REGISTRY.getByName(REGISTRY_NAME);
const MAIN = "kelpie:telegram:subagent-e2e";

/** Every memory search, by the agent it read as. */
const searches: string[] = [];

function use(world: FakeWorld): FakeWorld {
  world.tools = [
    memoryTools({
      async search(agentId: string) {
        searches.push(agentId);
        return { ok: true, text: "The owner prefers aisle seats.", notes: [] };
      },
      async readNote() {
        return { ok: false, reason: "not_found" };
      },
      async writeNote() {
        return { ok: true, path: "x.md" };
      },
    } as never),
    subagentTools({
      canSpawn: async (id) => (await registry().get(id))?.role === "main",
      ceiling: async (id) => {
        const model = agentModel((await host(id).config()).settings);
        return { model, described: { provider: "anthropic", tier: "medium", route: [] } };
      },
      add: (id, name, creator, actor) => registry().addSubagent(id, name, creator, actor),
      configure: (id, settings, actor) => host(id).configure(settings, actor),
      owned: async (creator) =>
        (await registry().list()).filter((entry) => entry.owner === creator),
      remove: async (actor, id) => {
        await host(id).erase([]);
        const removed = await registry().remove(id, actor);
        return removed.ok
          ? { ok: true, value: { deleted: [id], webhooksLeft: [], everyThread: false } }
          : removed;
      },
    }),
    taskTools({
      owned: async (id) =>
        (await registry().list()).filter((entry) => entry.owner === id).map((entry) => entry.id),
      create: (assignee, task, creator) => host(assignee).createTaskFor(task, creator),
      comment: (assignee, taskId, text, by) =>
        host(assignee).commentTaskAs(taskId, text, by, "chat"),
    }),
  ];
  replacePortsForTesting(world.ports);
  return world;
}

const until = (check: () => Promise<void>) => vi.waitFor(check, { timeout: 8_000 });

beforeEach(() => {
  replaceTaskRunnerForTesting(undefined);
  // The model's route, as llm-gateway would describe it: the tier its settings name.
  replaceIdentitySourcesForTesting({
    agent: async (id) => {
      const entry = await registry().get(id);
      return entry ? { name: entry.name, role: entry.role, owner: entry.owner } : null;
    },
    describe: async (model) => ({
      provider: "anthropic",
      tier: model.conversation?.tier ?? "medium",
      route: [],
    }),
  });
});
afterEach(() => {
  replacePortsForTesting(undefined);
  replaceIdentitySourcesForTesting(undefined);
});

describe("a temporary subagent (#290)", () => {
  it("is created, does a task within its limits, reports back, and is deleted", async () => {
    const scripts = [
      toolCalls({
        name: "create_subagent",
        input: { name: "Scout", soul: "You find flights.", remit: "Flights to Lisbon." },
      }),
      reply("I made a scout."),
    ];
    const world = use(fakeWorld(scripts));
    const main = agent(MAIN);
    await main.ingest({
      agentId: "kelpie",
      providerMessageId: "e2e:m1",
      userId: "u-owner",
      role: "owner",
      chatType: "direct",
      text: "Find me flights to Lisbon.",
      destination: { channel: "telegram", threadId: "subagent-e2e" },
      sentAt: Date.now(),
      timeZone: null,
    });
    await main.flush();
    await until(async () => {
      expect(world.sent.at(-1)).toBe("I made a scout.");
    });
    const scout = (await registry().list()).find(
      (entry) => entry.owner === "kelpie" && entry.role === "subagent" && entry.name === "Scout",
    );
    if (!scout) throw new Error("no subagent");
    expect(scout).toMatchObject({ chat: false });

    // The main agent hands it a task; the subagent searches its creator's memory and ends it.
    scripts.push(
      toolCalls({
        name: "create_task",
        input: { agentId: scout.id, title: "Flights", body: "Lisbon, in May, aisle seat." },
      }),
      reply("The scout is on it."),
      toolCalls({ name: "memory_search", input: { query: "seat preference" } }),
      toolCalls({ name: "complete_task", input: { result: "TAP 123, aisle seat." } }),
      reply("Done."),
      reply("The scout found TAP 123, aisle seat."),
    );
    const requestsBefore = world.requests.length;
    await main.ingest({
      agentId: "kelpie",
      providerMessageId: "e2e:m2",
      userId: "u-owner",
      role: "owner",
      chatType: "direct",
      text: "Go.",
      destination: { channel: "telegram", threadId: "subagent-e2e" },
      sentAt: Date.now(),
      timeZone: null,
    });
    await main.flush();
    await until(async () => {
      expect(world.sent.at(-1)).toBe("The scout found TAP 123, aisle seat.");
    });

    // The subagent's turns had only a subagent's tools, and read as its creator.
    const theirs = world.requests
      .slice(requestsBefore)
      .filter((request) => (request.tools ?? []).some((spec) => spec.name === "complete_task"));
    expect(theirs.length).toBeGreaterThan(0);
    for (const request of theirs) {
      for (const spec of request.tools ?? []) expect(SUBAGENT_TOOLS.has(spec.name)).toBe(true);
    }
    expect(searches).toEqual(["kelpie"]);

    // Its demand over, the main agent deletes it.
    scripts.push(
      toolCalls({ name: "delete_subagent", input: { id: scout.id } }),
      reply("Deleted the scout."),
    );
    await main.ingest({
      agentId: "kelpie",
      providerMessageId: "e2e:m3",
      userId: "u-owner",
      role: "owner",
      chatType: "direct",
      text: "Thanks, you can let it go.",
      destination: { channel: "telegram", threadId: "subagent-e2e" },
      sentAt: Date.now(),
      timeZone: null,
    });
    await main.flush();
    await until(async () => {
      expect(world.sent.at(-1)).toBe("Deleted the scout.");
    });
    expect(await registry().get(scout.id)).toBeNull();
  });
});
