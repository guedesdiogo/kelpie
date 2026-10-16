import { runInDurableObject } from "cloudflare:test";
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

/** The conversations a test started, which `afterEach` lets finish before the next one. */
const started: string[] = [];

async function queue(agentId: string, title: string, body = ""): Promise<TaskView> {
  const created = await host(agentId).createTask(
    { title, body, status: "todo", scheduledStartAt: null },
    owner,
  );
  if (!created.ok) throw new Error(created.reason);
  started.push(`${agentId}:task:${created.value.id}`);
  return created.value;
}

async function statusOf(agentId: string, taskId: string) {
  const task = await host(agentId).getTask(taskId);
  if (!task.ok) throw new Error(task.reason);
  return task.value;
}

const until = (check: () => Promise<void>) => vi.waitFor(check, { timeout: 5_000 });

/**
 * Waits until none of these conversations runs a turn: a run's last round can outlive its task's
 * end, and would take the next test's model scripts.
 */
async function quiet(...names: string[]) {
  await until(async () => {
    for (const name of names) {
      const turns = await agent(name).turns();
      expect(turns.every((turn) => turn.status !== "running")).toBe(true);
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
}

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
afterEach(async () => {
  await quiet(...started.splice(0));
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
    // Exactly one nudge a run: two runs, two turns each.
    expect(world.requests).toHaveLength(4);
    expect(
      userTexts(world).filter((text) =>
        text.includes("your turn ended, but the task is still running"),
      ),
    ).toHaveLength(4);
  });

  it("nudges a turn that ended with no reply at all, as one that said something", async () => {
    use(fakeWorld([reply(""), toolCalls({ name: "complete_task", input: { result: "Done." } })]));
    const task = await queue("runs-silent", "Quiet");
    await until(async () => {
      expect(await statusOf("runs-silent", task.id)).toMatchObject({ status: "done" });
    });
  });

  it("can't confirm, isn't captured, and goes with its agent when it is deleted", async () => {
    const answers: boolean[] = [];
    const world = use(
      fakeWorld([
        toolCalls({ name: "ask_yes" }),
        toolCalls({ name: "complete_task", input: { result: "Asked." } }),
        reply("Done."),
      ]),
    );
    world.tools.push({
      async tools() {
        return [
          {
            spec: { name: "ask_yes", description: "Asks.", inputSchema: { type: "object" } },
            label: "Asking",
            async run(_input, context) {
              answers.push(await context.confirm({ command: "x", input: {}, summary: "do x." }));
              return { output: "asked" };
            },
          },
        ];
      },
    });
    const task = await queue("runs-sealed", "Sealed");
    const name = `runs-sealed:task:${task.id}`;
    await until(async () => {
      expect(await statusOf("runs-sealed", task.id)).toMatchObject({ status: "done" });
    });
    expect(answers).toEqual([false]);
    // No notice for a confirmation was written, and nothing went to a channel.
    expect(
      await runInDurableObject(agent(name), (_instance, state) =>
        state.storage.sql.exec("SELECT id FROM confirmations").toArray(),
      ),
    ).toEqual([]);
    expect(world.sendAttempts).toBe(0);
    await agent(name).closeSession();
    expect(world.remembered).toEqual([]);

    // Deleting the agent erases the run's conversation too.
    expect(await host("runs-sealed").erase([])).toMatchObject({ ok: true });
    await until(async () => {
      expect(await agent(name).turns()).toEqual([]);
    });
  });

  it("keeps a task waiting when its run comments right after it asked", async () => {
    use(
      fakeWorld([
        toolCalls(
          { name: "wait_on_task", input: { reason: "needs_input", question: "Which date?" } },
          { name: "comment_task", input: { text: "The owner said May." } },
        ),
        reply("Waiting."),
      ]),
    );
    const task = await queue("runs-parked", "Ask");
    await until(async () => {
      expect(await statusOf("runs-parked", task.id)).toMatchObject({
        status: "waiting",
        waitingReason: "needs_input",
        attempt: 1,
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await statusOf("runs-parked", task.id)).toMatchObject({ status: "waiting", attempt: 1 });
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
    started.push(name);
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

  it("asks the owner through the main agent, and the owner's reply resumes the task", async () => {
    await registry().add("runs-helper", "Helper", owner);
    const scripts = [reply("Oi!")];
    const world = use(fakeWorld(scripts));
    const main = await mainConversation(world, "kelpie:telegram:runs-asks");

    // The specialist asks; Kelpie tells the main agent, which asks the owner on Telegram.
    scripts.push(
      toolCalls({
        name: "wait_on_task",
        input: { reason: "needs_input", question: "Which date?" },
      }),
      reply("Asked."),
      reply("The helper asks: which date?"),
    );
    const task = await queue("runs-helper", "Book");
    await until(async () => {
      expect(world.sent.at(-1)).toBe("The helper asks: which date?");
    });
    expect(await statusOf("runs-helper", task.id)).toMatchObject({
      status: "waiting",
      waitingReason: "needs_input",
    });
    const note = userTexts(world).at(-1) ?? "";
    expect(note).toContain("It waits for an answer.");
    expect(note).toContain("Which date?");

    // The owner answers in the chat; the main agent puts the answer on the task, which runs again.
    scripts.push(
      toolCalls({
        name: "comment_task",
        input: { agentId: "runs-helper", taskId: task.id, text: "May 3rd." },
      }),
      reply("I told the helper."),
      toolCalls({ name: "complete_task", input: { result: "Booked for May 3rd." } }),
      reply("Done."),
      reply("The helper booked it for May 3rd."),
    );
    await main.ingest({
      agentId: "kelpie",
      providerMessageId: "runs-asks:m2",
      userId: "u-owner",
      role: "owner",
      chatType: "direct",
      text: "Dia 3 de maio.",
      destination: { channel: "telegram", threadId: "kelpie:telegram:runs-asks" },
      sentAt: Date.now(),
      timeZone: null,
    });
    await main.flush();

    await until(async () => {
      expect(world.sent.at(-1)).toBe("The helper booked it for May 3rd.");
    });
    const detail = await statusOf("runs-helper", task.id);
    expect(detail).toMatchObject({ status: "done", result: "Booked for May 3rd.", attempt: 2 });
    // The answer is on the task, from the chat, by the main agent.
    expect(detail.comments).toEqual([
      expect.objectContaining({
        author: { kind: "agent", id: "runs-helper" },
        text: "Which date?",
      }),
      expect.objectContaining({
        author: { kind: "agent", id: "kelpie" },
        source: "chat",
        text: "May 3rd.",
      }),
    ]);
    // The second run had the answer as data, in Kelpie's note.
    expect(
      userTexts(world).some(
        (text) => text.includes("The agent kelpie:") && text.includes("May 3rd."),
      ),
    ).toBe(true);
  });

  it("takes Kelpie's notes only in the agent's own conversations with a person", async () => {
    const unbound = agent("runs-note-unbound:telegram:x");
    expect(await unbound.kelpieNote("runs-note-unbound", "u-owner", "Hello.")).toBe(false);
    const world = use(fakeWorld([reply("Oi!")]));
    const main = await mainConversation(world, "kelpie:telegram:runs-notes");
    expect(await main.kelpieNote("someone-else", "u-owner", "Hello.")).toBe(false);
    expect(await main.kelpieNote("kelpie", "", "Hello.")).toBe(false);
    expect(await main.kelpieNote("kelpie", "u-owner", "")).toBe(false);
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
        { agentId: "stranger", actingUserId: "u-owner" },
      ),
    ).toEqual({ ok: false, reason: "not_allowed" });
    if (!made.ok) throw new Error("not made");
    expect(
      await host("runs-owned").commentTaskAs(made.value.id, "From a stranger.", "stranger", "chat"),
    ).toEqual({ ok: false, reason: "not_allowed" });
    expect(
      await host("runs-owned").commentTaskAs(made.value.id, "Look at May.", "kelpie", "chat"),
    ).toMatchObject({ ok: true });
  });
});
