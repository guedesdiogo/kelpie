import { env } from "cloudflare:workers";
import { REGISTRY_NAME, type TaskView } from "@kelpie/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceTaskRunnerForTesting } from "../src/agent-host/agent-host.ts";
import { replacePortsForTesting } from "../src/ports.ts";
import { taskTools } from "../src/task-tools.ts";
import { type FakeWorld, fakeWorld, held, reply, toolCalls } from "./fakes.ts";

// Tasks run in their own conversations (#335): the board's runner starts one per run, its turns end
// the task through the task tools, and a question or a result reaches the owner through the agent
// that should hear it.

const host = (agentId: string) => env.AGENT_HOST.getByName(agentId);
const agent = (name: string) => env.CONVERSATION_AGENT.getByName(name);
const registry = () => env.REGISTRY.getByName(REGISTRY_NAME);
const owner = { userId: "u-owner", role: "owner", via: "admin-api" } as const;

/** The fake model, with the task tools wired to the real Registry and AgentHosts. */
function use(world: FakeWorld): FakeWorld {
  world.tools = [
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

async function queue(agentId: string, title: string, body = ""): Promise<TaskView> {
  const created = await host(agentId).createTask(
    { title, body, status: "todo", scheduledStartAt: null },
    owner,
  );
  if (!created.ok) throw new Error(created.reason);
  return created.value;
}

async function statusOf(agentId: string, taskId: string) {
  const task = await host(agentId).getTask(taskId);
  if (!task.ok) throw new Error(task.reason);
  return task.value;
}

const until = (check: () => Promise<void>) => vi.waitFor(check, { timeout: 5_000 });

/** The tools the latest model call was given. */
const offered = (world: FakeWorld) => (world.requests.at(-1)?.tools ?? []).map((tool) => tool.name);

/** The text of every user message the model was sent, in order. */
const userTexts = (world: FakeWorld) =>
  world.requests.flatMap((request) =>
    request.messages
      .filter((message) => message.role === "user")
      .map((message) => JSON.stringify(message.parts)),
  );

beforeEach(() => {
  replaceTaskRunnerForTesting(undefined);
});
afterEach(() => {
  replacePortsForTesting(undefined);
});

describe("a task's run (#335)", () => {
  it("runs in its own conversation, whose turn ends the task with its result", async () => {
    const world = use(
      fakeWorld([
        toolCalls({ name: "complete_task", input: { result: "Booked for May 3rd." } }),
        reply("Done."),
      ]),
    );
    const task = await queue("runs-done", "Book the flights", "Lisbon, in May.");

    await until(async () => {
      expect(await statusOf("runs-done", task.id)).toMatchObject({
        status: "done",
        result: "Booked for May 3rd.",
      });
    });
    expect(userTexts(world)[0]).toContain("A task on your board, from the owner.");
    expect(userTexts(world)[0]).toContain("# Book the flights");
    expect(userTexts(world)[0]).toContain("Lisbon, in May.");
    expect(offered(world)).toEqual(
      expect.arrayContaining(["complete_task", "wait_on_task", "cancel_task", "comment_task"]),
    );
    // Nothing went to any channel: a task's conversation reaches no one.
    expect(world.sendAttempts).toBe(0);
    expect(await agent(`runs-done:task:${task.id}`).turns()).not.toHaveLength(0);
  });

  it("nudges once a turn that leaves its task running, then counts the run as failed", async () => {
    const world = use(
      fakeWorld([
        reply("Thinking about it."),
        reply("Still thinking."),
        reply("Again."),
        reply("Nothing yet."),
      ]),
    );
    const task = await queue("runs-nudged", "Think");

    // Two runs of a turn and a nudge each: two failures in a row, so the task waits.
    await until(async () => {
      expect(await statusOf("runs-nudged", task.id)).toMatchObject({
        status: "waiting",
        waitingReason: "failed",
        attempt: 2,
      });
    });
    expect(
      userTexts(world).some((text) =>
        text.includes("your turn ended, but the task is still running"),
      ),
    ).toBe(true);
  });

  it("stops at once on the owner's stop: the turn ends, and the task is cancelled", async () => {
    const world = use(fakeWorld([held("Working.")]));
    world.modelHeld = true;
    const task = await queue("runs-stopped", "Long one");
    await until(async () => {
      expect(world.requests).toHaveLength(1);
    });

    expect(await host("runs-stopped").requestStop(task.id, owner)).toMatchObject({
      ok: true,
      value: { status: "cancelled", stopRequested: true },
    });
    world.modelHeld = false;
    const conversation = agent(`runs-stopped:task:${task.id}`);
    await until(async () => {
      expect((await conversation.turns()).at(-1)?.status).toBe("interrupted");
    });
    expect(await statusOf("runs-stopped", task.id)).toMatchObject({ status: "cancelled" });
  });

  it("hands a person's comment to the running task in its next round", async () => {
    const world = use(
      fakeWorld([
        held("Looking."),
        toolCalls({ name: "complete_task", input: { result: "Used the new date." } }),
        reply("Done."),
      ]),
    );
    world.modelHeld = true;
    const task = await queue("runs-commented", "Book");
    await until(async () => {
      expect(world.requests).toHaveLength(1);
    });
    expect(
      await host("runs-commented").commentTask(task.id, "Make it May 5th.", owner),
    ).toMatchObject({ ok: true, value: { status: "in_progress" } });
    world.modelHeld = false;

    await until(async () => {
      expect(await statusOf("runs-commented", task.id)).toMatchObject({ status: "done" });
    });
    expect(userTexts(world).at(-1)).toContain("the owner commented on the task: Make it May 5th.");
  });
});

describe("tasks between agents (#335)", () => {
  /** The main agent's conversation with the owner, with one turn done, so it is its latest. */
  async function mainConversation(world: FakeWorld, name: string) {
    const stub = agent(name);
    await stub.ingest({
      agentId: "kelpie",
      providerMessageId: `${name}:m1`,
      userId: "u-owner",
      role: "owner",
      chatType: "direct",
      text: "oi",
      destination: { channel: "telegram", threadId: name },
      sentAt: Date.now(),
      timeZone: null,
    });
    await stub.flush();
    await until(async () => {
      expect((await stub.turns()).at(-1)?.status).toBe("delivered");
    });
    expect(world.sent.length).toBeGreaterThan(0);
    return stub;
  }

  it("asks the owner through the main agent, whose answer resumes the task to its end", async () => {
    await registry().add("runs-helper", "Helper", owner);
    const scripts = [reply("Oi!")];
    const world = use(fakeWorld(scripts));
    const main = await mainConversation(world, "kelpie:telegram:runs-asks");

    // The specialist asks; Kelpie tells the main agent, which answers on the task.
    scripts.push(
      toolCalls({
        name: "wait_on_task",
        input: { reason: "needs_input", question: "Which date?" },
      }),
      reply("Asked."),
    );
    const task = await queue("runs-helper", "Book");
    scripts.push(
      toolCalls({
        name: "comment_task",
        input: { agentId: "runs-helper", taskId: task.id, text: "May 3rd." },
      }),
      reply("I answered it."),
      toolCalls({ name: "complete_task", input: { result: "Booked for May 3rd." } }),
      reply("Done."),
      reply("The helper booked it."),
    );

    await until(async () => {
      expect(await statusOf("runs-helper", task.id)).toMatchObject({
        status: "done",
        result: "Booked for May 3rd.",
      });
    });
    const texts = userTexts(world);
    expect(
      texts.some((text) => text.includes("waits for an answer") && text.includes("Which date?")),
    ).toBe(true);
    expect(
      texts.some((text) => text.includes("the owner commented") || text.includes("May 3rd.")),
    ).toBe(true);
    // The result reaches the main agent too, which relays it.
    await until(async () => {
      expect(world.sent.at(-1)).toBe("The helper booked it.");
    });
    const detail = await statusOf("runs-helper", task.id);
    expect(await main.turns()).not.toHaveLength(1);
    expect(detail.attempt).toBe(2);
  });

  it("lets only the owning agent hand an agent work, and records both", async () => {
    await registry().add("runs-owned", "Owned", owner);
    const made = await host("runs-owned").createTaskFor(
      { title: "Research", body: "Flights.", status: "backlog", scheduledStartAt: null },
      { agentId: "kelpie", actingUserId: "u-owner" },
    );
    expect(made).toMatchObject({
      ok: true,
      value: { creator: { kind: "agent", id: "kelpie" }, status: "backlog" },
    });
    expect(
      await host("runs-owned").createTaskFor(
        { title: "Research", body: "", status: "backlog", scheduledStartAt: null },
        { agentId: "setup", actingUserId: "u-owner" },
      ),
    ).toEqual({ ok: false, reason: "not_allowed" });
    if (!made.ok) throw new Error("not made");
    expect(
      await host("runs-owned").commentTaskAs(made.value.id, "From a stranger.", "setup", "chat"),
    ).toEqual({ ok: false, reason: "not_allowed" });
    expect(
      await host("runs-owned").commentTaskAs(made.value.id, "Look at May.", "kelpie", "chat"),
    ).toMatchObject({ ok: true });
  });
});
