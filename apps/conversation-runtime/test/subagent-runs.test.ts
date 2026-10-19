import { env } from "cloudflare:workers";
import {
  type Actor,
  type AgentSettings,
  agentModel,
  type ConfigPorts,
  createConfigCommands,
  DEFAULT_SETTINGS,
  REGISTRY_NAME,
} from "@kelpie/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceTaskRunnerForTesting } from "../src/agent-host/agent-host.ts";
import { configurationTools, heldTools, MASTER_TOOLS } from "../src/configuration.ts";
import { memoryTools } from "../src/memory-tools.ts";
import { replacePortsForTesting } from "../src/ports.ts";
import { SUBAGENT_TOOLS } from "../src/subagent-limits.ts";
import { subagentTools } from "../src/subagent-tools.ts";
import { taskTools } from "../src/task-tools.ts";
import { type FakeWorld, fakeWorld, reply, toolCalls } from "./fakes.ts";

// A Master's temporary subagent, end to end (ADR-0036 §5, #290): it creates one for a demand,
// hands it a task, hears the result, and deletes it. The subagent reads only its creator's memory,
// with only a subagent's tools.

const host = (agentId: string) => env.AGENT_HOST.getByName(agentId);
const agent = (name: string) => env.CONVERSATION_AGENT.getByName(name);
const registry = () => env.REGISTRY.getByName(REGISTRY_NAME);
const MASTER_CHAT = "kelpie:telegram:subagent-e2e";

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
      canSpawn: async (id) => (await registry().get(id))?.role === "master",
      creator: async (id) => {
        const { settings } = await host(id).config();
        return {
          model: agentModel(settings),
          described: { provider: "anthropic", tier: "medium", route: [] },
          // As production reads it (ports.ts): what the creator holds, by its role (#391).
          tools: heldTools((await registry().get(id))?.role ?? null, settings.tools),
        };
      },
      add: (id, name, creator, actor) => registry().addSubagent(id, name, creator, actor),
      bindCreator: (id, creator) => host(id).bindCreator(creator),
      discard: (id) => host(id).erase([]),
      configure: (id, settings, actor) => host(id).configure(settings, actor),
      owned: async (creator) =>
        (await registry().list()).filter((entry) => entry.owner === creator),
      // #303's real deletion, as production wires it.
      remove: (actor, id) => commands().deleteAgent(actor, { id }),
    }),
    taskTools({
      owned: async (id) =>
        (await registry().list())
          .filter((entry) => entry.owner === id)
          .map((entry) => ({ id: entry.id, name: entry.name })),
      create: (assignee, task, creator) => host(assignee).createTaskFor(task, creator),
      comment: (assignee, taskId, text, by) =>
        host(assignee).commentTaskAs(taskId, text, by, "chat"),
    }),
  ];
  replacePortsForTesting(world.ports);
  return world;
}

const until = (check: () => Promise<void>) => vi.waitFor(check, { timeout: 8_000 });

/**
 * The configuration commands over the real Registry and AgentHosts, with no bot to disconnect;
 * made where they run, since a stub serves only the request that made it.
 */
const commands = () =>
  createConfigCommands({
    registry: registry(),
    agents: {
      configure: (id: string, changes: Partial<AgentSettings>, actor: Actor) =>
        host(id).configure(changes, actor),
      config: (id: string) => host(id).config(),
      erase: (id: string, names: string[]) => host(id).erase(names),
    },
    channels: { disconnectTelegram: async () => ({ ok: true, webhook: "none" }) },
    directory: {
      listIdentities: async () => {
        throw new Error("not bound");
      },
    },
  } as unknown as ConfigPorts);

/** Reads an object again once its destroyed instance is gone. */
async function afterDestroy<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      if (attempt >= 20 || !String(error).includes("destroyed")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

beforeEach(() => {
  replaceTaskRunnerForTesting(undefined);
});
/**
 * Waits until no conversation of the subagents' or theirs runs a turn: a run's last round can
 * outlive its task's end, and would take another test's model scripts.
 */
async function quiet() {
  const names = [MASTER_CHAT];
  const ids = (await registry().list())
    .map((entry) => entry.id)
    .filter((id) => id.includes("-sub-"));
  for (const id of [...ids, "allow-plain"]) {
    for (const task of await host(id).listTasks()) names.push(`${id}:task:${task.id}`);
  }
  await until(async () => {
    for (const name of names) {
      const turns = await agent(name)
        .turns()
        .catch(() => []);
      expect(turns.every((turn) => turn.status !== "running")).toBe(true);
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
}

afterEach(async () => {
  await quiet();
  replacePortsForTesting(undefined);
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
    const masterChat = agent(MASTER_CHAT);
    await masterChat.ingest({
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
    await masterChat.flush();
    await until(async () => {
      expect(world.sent.at(-1)).toMatch(/^Kelpie created the subagent "Scout" \(kelpie-sub-/);
    });
    const scout = (await registry().list()).find(
      (entry) => entry.owner === "kelpie" && entry.role === "subagent" && entry.name === "Scout",
    );
    if (!scout) throw new Error("no subagent");
    expect(scout).toMatchObject({ chat: false });
    // Kelpie, not the model, tells the owner it exists (#342).
    expect(world.sent.slice(-2)).toEqual([
      "I made a scout.",
      `Kelpie created the subagent "Scout" (${scout.id}).`,
    ]);

    // Master hands it a task; the subagent searches its creator's memory and ends it.
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
    await masterChat.ingest({
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
    await masterChat.flush();
    await until(async () => {
      expect(world.sent.at(-1)).toBe("The scout found TAP 123, aisle seat.");
    });
    // The handoff was Kelpie's to announce too (#287).
    expect(world.sent).toContain(`Kelpie handed a task to "Scout" (${scout.id}).`);

    // The subagent's turns had only a subagent's tools, and read as its creator.
    const theirs = world.requests
      .slice(requestsBefore)
      .filter((request) => (request.tools ?? []).some((spec) => spec.name === "complete_task"));
    expect(theirs.length).toBeGreaterThan(0);
    for (const request of theirs) {
      for (const spec of request.tools ?? []) expect(SUBAGENT_TOOLS.has(spec.name)).toBe(true);
    }
    expect(searches).toEqual(["kelpie"]);
    // The result reached the creator as Kelpie's news, so it outlives the subagent.
    const told = world.requests.some((request) =>
      request.messages.some(
        (message) =>
          message.role === "user" &&
          JSON.stringify(message.parts).includes("news of the task") &&
          JSON.stringify(message.parts).includes("TAP 123, aisle seat."),
      ),
    );
    expect(told).toBe(true);

    // Its demand over, Master deletes it.
    scripts.push(
      toolCalls({ name: "delete_subagent", input: { id: scout.id } }),
      reply("Deleted the scout."),
    );
    await masterChat.ingest({
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
    await masterChat.flush();
    await until(async () => {
      expect(world.sent.slice(-2)).toEqual([
        "Deleted the scout.",
        `Kelpie deleted the subagent "Scout" (${scout.id}).`,
      ]);
    });
    expect(await registry().get(scout.id)).toBeNull();
    // Its AgentHost is erased: its soul and pinned creator are gone.
    expect(await afterDestroy(() => host(scout.id).config())).toEqual({
      settings: DEFAULT_SETTINGS,
      promptVersion: 0,
    });
  });

  it("keeps every turn to its allowed tools: a subagent's even with no allowlist, within its creator's", async () => {
    const owner = { userId: "u-owner", role: "owner", via: "admin-api" } as const;
    const offered = async (world: FakeWorld, agentId: string) => {
      const created = await host(agentId).createTask(
        { title: "Look", body: "", status: "todo", scheduledStartAt: null },
        owner,
      );
      if (!created.ok) throw new Error(created.reason);
      await until(async () => {
        expect(
          (await host(agentId).getTask(created.value.id)).ok && world.requests.length,
        ).toBeTruthy();
      });
      await until(async () => {
        const task = await host(agentId).getTask(created.value.id);
        expect(task.ok && task.value.status).toBe("done");
      });
      return new Set(world.requests[0]?.tools?.map((spec) => spec.name) ?? []);
    };

    // An ordinary agent whose settings name its tools gets only those. It is one no agent owns, so
    // its task's news goes to no other conversation.
    await host("allow-plain").configure({ tools: ["complete_task", "comment_task"] }, owner);
    const plain = use(
      fakeWorld([toolCalls({ name: "complete_task", input: { result: "ok" } }), reply("ok")]),
    );
    expect(await offered(plain, "allow-plain")).toEqual(new Set(["complete_task", "comment_task"]));

    // A subagent whose allowlist Master cleared still gets only a subagent's tools, and only those
    // its creator may use.
    await host("allow-maker").configure({ tools: ["complete_task", "memory_search"] }, owner);
    await registry().addSubagent("allow-maker-sub-aaaaaa", "Sub", "kelpie", owner);
    await host("allow-maker-sub-aaaaaa").bindCreator("allow-maker");
    await host("allow-maker-sub-aaaaaa").configure({ tools: null }, owner);
    const child = use(
      fakeWorld([toolCalls({ name: "complete_task", input: { result: "ok" } }), reply("ok")]),
    );
    expect(await offered(child, "allow-maker-sub-aaaaaa")).toEqual(
      new Set(["complete_task", "memory_search"]),
    );
  });

  it("never narrows Master's orchestration tools: its allowlist narrows only the others (#391)", async () => {
    const owner = { userId: "u-owner", role: "owner", via: "admin-api" } as const;
    const world = use(fakeWorld([reply("One."), reply("Two."), reply("Three.")]));
    world.tools.push(
      configurationTools({} as never, {
        roleOf: async (id) => (await registry().get(id))?.role ?? null,
        adminOrigin: "https://admin.example",
      }),
    );
    // Master hands tasks only to agents it owns: this specialist is its own.
    await registry().add("allow-spec", "Spec", owner);
    // Every orchestration tool is one a provider offers Master, in a chat or a task's run.
    const provided = new Set<string>();
    for (const provider of world.tools) {
      for (const channel of ["telegram", "task"] as const) {
        for (const tool of await provider.tools("kelpie", { channel }))
          provided.add(tool.spec.name);
      }
    }
    for (const name of MASTER_TOOLS) expect(provided, name).toContain(name);
    /** The tools a direct turn of the agent is offered, in a thread of its own. */
    const offered = async (agentId: string, thread: string) => {
      const before = world.requests.length;
      const chat = agent(`${agentId}:telegram:${thread}`);
      await chat.ingest({
        agentId,
        providerMessageId: `${thread}:m1`,
        userId: "u-owner",
        role: "owner",
        chatType: "direct",
        text: "What can you do?",
        destination: { channel: "telegram", threadId: thread },
        sentAt: Date.now(),
        timeZone: null,
      });
      await chat.flush();
      await until(async () => {
        expect(world.requests.length).toBeGreaterThan(before);
        expect((await chat.turns()).every((turn) => turn.status !== "running")).toBe(true);
      });
      return new Set(world.requests[before]?.tools?.map((spec) => spec.name) ?? []);
    };

    const all = await offered("kelpie", "allow-master-all");
    // An allowlist stored on Master, as one from before #386 might be, narrows only the others.
    await host("kelpie").configure({ tools: ["memory_search"] }, owner);
    const narrowed = await offered("kelpie", "allow-master-narrow");
    await host("kelpie").configure({ tools: null }, owner);
    expect(narrowed).toEqual(
      new Set([...all].filter((name) => name === "memory_search" || MASTER_TOOLS.has(name))),
    );
    for (const name of ["configure_agent", "set_master", "create_subagent", "create_task"]) {
      expect(narrowed).toContain(name);
    }
    expect(narrowed).not.toContain("memory_read");

    // A specialist's allowlist still narrows everything it is given.
    await host("allow-spec").configure({ tools: ["memory_search"] }, owner);
    expect(await offered("allow-spec", "allow-spec-chat")).toEqual(new Set(["memory_search"]));
  });

  it("lets a narrowed Master create a subagent that can finish its task (#391)", async () => {
    const owner = { userId: "u-owner", role: "owner", via: "admin-api" } as const;
    const world = use(
      fakeWorld([
        toolCalls({
          name: "create_subagent",
          input: { name: "Narrow", soul: "You check one thing.", remit: "One check." },
        }),
        reply("Made it."),
      ]),
    );
    await host("kelpie").configure({ tools: ["memory_search"] }, owner);
    const chat = agent("kelpie:telegram:allow-narrow-spawn");
    await chat.ingest({
      agentId: "kelpie",
      providerMessageId: "narrow:m1",
      userId: "u-owner",
      role: "owner",
      chatType: "direct",
      text: "Make a helper.",
      destination: { channel: "telegram", threadId: "allow-narrow-spawn" },
      sentAt: Date.now(),
      timeZone: null,
    });
    await chat.flush();
    await until(async () => {
      expect(world.sent.at(-1)).toMatch(/^Kelpie created the subagent "Narrow" \(kelpie-sub-/);
    });
    const made = (await registry().list()).find((entry) => entry.name === "Narrow");
    if (!made) throw new Error("no subagent");
    // It holds a subagent's task tools, within what its narrowed creator holds.
    expect((await host(made.id).turnConfig()).agent?.creatorTools).toEqual(
      expect.arrayContaining(["memory_search", "complete_task"]),
    );
    await host("kelpie").configure({ tools: null }, owner);
    expect(await commands().deleteAgent(owner, { id: made.id })).toMatchObject({ ok: true });
  });
});
