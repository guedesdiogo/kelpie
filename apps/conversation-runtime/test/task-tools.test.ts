import type { NewTask, RunOutcome, TaskView } from "@kelpie/config";
import { describe, expect, it } from "vitest";
import { MAX_UNATTENDED_HANDOFFS } from "../src/agent-host/tasks.ts";
import { configurationTools } from "../src/configuration.ts";
import { memoryTools } from "../src/memory-tools.ts";
import { type TaskToolPorts, taskTools } from "../src/task-tools.ts";
import type { TaskRunHandle, Tool, ToolContext } from "../src/tools.ts";

// The agents' task tools (#335): a run ends only its own task, through a handle that keeps the
// run's token from the tool, and an agent hands work only to the agents it owns.

const TASK = "0f8b7c1e-6a2d-4c3b-9e5f-1a2b3c4d5e6f";

function world(
  owned: Record<string, { id: string; name: string }[]> = {
    kelpie: [
      { id: "helper", name: "Helper" },
      { id: "sales", name: "Sales" },
    ],
  },
  /** The handoffs left today to turns no person typed (#345), per creating agent. */
  slots: Record<string, number> = {},
) {
  const calls: string[] = [];
  const view = (fields: Partial<TaskView>): TaskView => ({
    id: TASK,
    title: "Book",
    status: "todo",
    scheduledStartAt: null,
    createdAt: 1,
    updatedAt: 1,
    creator: { kind: "agent", id: "kelpie" },
    body: "",
    waitingReason: null,
    attempt: 0,
    stopRequested: false,
    result: null,
    ...fields,
  });
  const ports: TaskToolPorts = {
    async owned(agentId) {
      return owned[agentId] ?? [];
    },
    async create(assignee, task: NewTask, creator) {
      calls.push(
        `create ${assignee} ${task.title} by ${creator.agentId} for ${creator.actingUserId}`,
      );
      if (assignee === "full") return { ok: false, reason: "not_allowed" };
      if (assignee === "broken") throw new Error("The object reset.");
      return { ok: true, value: view({ title: task.title }) };
    },
    async comment(assignee, taskId, text, by) {
      calls.push(`comment ${assignee} ${taskId} ${text} by ${by}`);
      return assignee === "stranger"
        ? { ok: false, reason: "not_allowed" }
        : { ok: true, value: view({ status: "todo" }) };
    },
    async takeHandoff(agentId) {
      const left = slots[agentId] ?? 0;
      calls.push(`take ${agentId}${left > 0 ? "" : " refused"}`);
      if (left > 0) slots[agentId] = left - 1;
      return left > 0;
    },
    async returnHandoff(agentId) {
      calls.push(`return ${agentId}`);
      slots[agentId] = (slots[agentId] ?? 0) + 1;
    },
  };
  return { provider: taskTools(ports), calls };
}

/** The handoffs the tools had Kelpie announce, as `agentId name taskId`. */
const handedOff: string[] = [];

function contextOf(
  agentId: string,
  task?: TaskRunHandle,
  trigger: ToolContext["trigger"] = task ? "task" : "person",
): ToolContext {
  return {
    locale: "en",
    actor: { userId: "u-owner", role: "owner", via: `agent:${agentId}` },
    agentId,
    scopes: "all",
    trigger,
    qualifier: "clef",
    turn: "1",
    source: "task:x, 2026-10-14",
    signal: new AbortController().signal,
    confirm: async () => false,
    sendLink: () => undefined,
    announce: (one) => {
      if (one.kind === "handoff") handedOff.push(`${one.agentId} ${one.name} ${one.taskId}`);
    },
    ...(task ? { task } : {}),
  };
}

/** A run's handle that records what the tools asked of it; `holds` false once the run lost it. */
function handle(holds = true) {
  const asked: (RunOutcome | string)[] = [];
  const task: TaskRunHandle = {
    id: TASK,
    async finish(outcome) {
      asked.push(outcome);
      return holds;
    },
    async comment(text) {
      asked.push(text);
      return holds;
    },
  };
  return { task, asked };
}

const names = (tools: Tool[]) => tools.map((tool) => tool.spec.name);
const byName = (tools: Tool[], name: string) => {
  const tool = tools.find((one) => one.spec.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool;
};

describe("the task tools (#335)", () => {
  it("give a run its task's tools in its own conversation, and the handoff to an owner", async () => {
    const { provider } = world();
    expect(names(await provider.tools("helper", { channel: "task" }))).toEqual([
      "complete_task",
      "wait_on_task",
      "cancel_task",
      "comment_task",
    ]);
    expect(names(await provider.tools("kelpie", { channel: "telegram" }))).toEqual([
      "comment_task",
      "create_task",
    ]);
    expect(names(await provider.tools("helper", { channel: "webchat" }))).toEqual(["comment_task"]);
  });

  it("end only the conversation's own task, through its run's handle", async () => {
    const tools = await world().provider.tools("helper", { channel: "task" });
    const { task, asked } = handle();
    const context = contextOf("helper", task);

    expect(await byName(tools, "complete_task").run({ result: " Booked. " }, context)).toEqual({
      output: "The task is done, with its result.",
    });
    expect(
      await byName(tools, "wait_on_task").run(
        { reason: "needs_input", question: "Which date?" },
        context,
      ),
    ).toMatchObject({ output: expect.stringContaining("your question goes to the owner") });
    expect(await byName(tools, "cancel_task").run({ reason: "No flights." }, context)).toEqual({
      output: "The task is cancelled.",
    });
    expect(await byName(tools, "comment_task").run({ text: "Halfway." }, context)).toEqual({
      output: "Commented on your task.",
    });
    // The question goes on the task before it waits.
    expect(asked).toEqual([
      { status: "done", result: "Booked." },
      "Which date?",
      { status: "waiting", reason: "needs_input" },
      { status: "cancelled", result: "No flights." },
      "Halfway.",
    ]);
  });

  it("tell the model to stop once the run lost its task, and refuse what they can't check", async () => {
    const tools = await world().provider.tools("helper", { channel: "task" });
    const lost = contextOf("helper", handle(false).task);
    expect(await byName(tools, "complete_task").run({ result: "x" }, lost)).toMatchObject({
      isError: true,
      output: expect.stringContaining("Stop working on it"),
    });
    const none = contextOf("helper");
    expect(await byName(tools, "complete_task").run({ result: "x" }, none)).toMatchObject({
      isError: true,
    });
    for (const [name, input] of [
      ["complete_task", { result: "  " }],
      ["wait_on_task", { reason: "later", question: "?" }],
      ["cancel_task", {}],
    ] as const) {
      expect(await byName(tools, name).run(input, lost), name).toMatchObject({ isError: true });
    }
  });

  it("hand work only to an agent the caller owns, for the person its turn acts for", async () => {
    const { provider, calls } = world();
    const tools = await provider.tools("kelpie", { channel: "telegram" });
    const create = byName(tools, "create_task");
    const context = contextOf("kelpie");
    handedOff.length = 0;

    expect(
      await create.run({ agentId: "helper", title: "Book", body: "Lisbon." }, context),
    ).toEqual({
      output: `Created the task ${TASK} for the agent helper. Kelpie tells the owner it has it, and tells you when it ends or asks something.`,
    });
    // Kelpie, not the model, announces who has it (ADR-0036 §4, #287).
    expect(handedOff).toEqual([`helper Helper ${TASK}`]);
    // An agent it doesn't own is refused with the ones it does, never handed to another.
    expect(
      await create.run({ agentId: "stranger", title: "Book", body: "x" }, context),
    ).toMatchObject({
      isError: true,
      output:
        "You don't own an agent stranger. Hand tasks only to the agents you own: helper, sales.",
    });
    expect(
      await create.run({ agentId: "helper", title: "a".repeat(201), body: "x" }, context),
    ).toMatchObject({ isError: true });
    expect(calls).toEqual(["create helper Book by kelpie for u-owner"]);
    expect(handedOff).toHaveLength(1);
  });

  it("answer on another agent's task by its ids, which resumes it", async () => {
    const { provider, calls } = world();
    const comment = byName(await provider.tools("kelpie", { channel: "telegram" }), "comment_task");
    const context = contextOf("kelpie");
    expect(
      await comment.run({ agentId: "helper", taskId: TASK, text: "May 3rd." }, context),
    ).toEqual({
      output: `Commented on the task ${TASK}; it goes back to the agent helper to do.`,
    });
    expect(
      await comment.run({ agentId: "stranger", taskId: TASK, text: "Hi." }, context),
    ).toMatchObject({ isError: true });
    expect(await comment.run({ text: "Mine?" }, context)).toMatchObject({ isError: true });
    expect(
      await comment.run({ agentId: "helper", taskId: "nope", text: "x" }, context),
    ).toMatchObject({
      isError: true,
    });
    expect(calls).toEqual([
      `comment helper ${TASK} May 3rd. by kelpie`,
      `comment stranger ${TASK} Hi. by kelpie`,
    ]);
  });
});

describe("what a task's run is given (#335)", () => {
  const none = () => {
    throw new Error("not called");
  };

  it("leaves Master's configuration tools out of it, and memory writes", async () => {
    const configuration = configurationTools({} as never, {
      roleOf: async () => "main",
      adminOrigin: "https://admin.example",
    });
    expect(await configuration.tools("kelpie", { channel: "task" })).toEqual([]);
    expect(names(await configuration.tools("kelpie", { channel: "telegram" }))).toContain(
      "configure_agent",
    );

    const memory = memoryTools({ search: none, readNote: none, writeNote: none });
    expect(names(await memory.tools("helper", { channel: "task" }))).toEqual([
      "memory_search",
      "memory_read",
    ]);
    expect(names(await memory.tools("helper", { channel: "webchat" }))).toContain("memory_write");
  });

  it("refuses a handoff from a turn that isn't the owner's, and more than three in one turn", async () => {
    const { provider, calls } = world();
    const create = byName(await provider.tools("kelpie", { channel: "telegram" }), "create_task");
    const member = {
      ...contextOf("kelpie"),
      actor: { userId: "u-x", role: "member", via: "x" },
    } as ToolContext;
    expect(await create.run({ agentId: "helper", title: "Book", body: "x" }, member)).toMatchObject(
      {
        isError: true,
      },
    );
    // A turn that reads only part of the owner's memory, as in a group, hands off nothing.
    const narrow = {
      ...contextOf("kelpie"),
      scopes: ["conversation/telegram-group"],
    } as ToolContext;
    expect(await create.run({ agentId: "helper", title: "Book", body: "x" }, narrow)).toMatchObject(
      {
        isError: true,
        output: expect.stringContaining("direct conversation"),
      },
    );
    const owner = contextOf("kelpie");
    for (let i = 0; i < 3; i++) {
      expect(
        await create.run({ agentId: "helper", title: `T${i}`, body: "x" }, owner),
      ).not.toHaveProperty("isError");
    }
    expect(await create.run({ agentId: "helper", title: "T3", body: "x" }, owner)).toMatchObject({
      isError: true,
      output: expect.stringContaining("at most 3"),
    });
    // Another turn starts its own count.
    expect(
      await create.run({ agentId: "helper", title: "T4", body: "x" }, { ...owner, turn: "2" }),
    ).not.toHaveProperty("isError");
    expect(calls).toHaveLength(4);
  });

  it("keeps a run to its own task: no comment on another task by its ids", async () => {
    const { provider, calls } = world();
    const comment = byName(await provider.tools("helper", { channel: "task" }), "comment_task");
    const run = contextOf("helper", handle().task);
    expect(
      await comment.run({ agentId: "helper", taskId: TASK, text: "Elsewhere." }, run),
    ).toMatchObject({ isError: true, output: expect.stringContaining("only on your own task") });
    expect(calls).toEqual([]);
  });
});

describe("handoffs from turns no person typed (#345)", () => {
  const AT_CAP = `Turns no person typed hand off at most ${MAX_UNATTENDED_HANDOFFS} tasks in 24 hours for you, and you reached that.`;

  it("take one of the day's slots in a task's run or after Kelpie's note, and none in a person's turn", async () => {
    const { provider, calls } = world(undefined, { kelpie: 2 });
    const create = byName(await provider.tools("kelpie", { channel: "telegram" }), "create_task");
    const person = contextOf("kelpie");
    const run = { ...contextOf("kelpie", handle().task), turn: "2" };
    const note = { ...contextOf("kelpie", undefined, "note"), turn: "3" };
    handedOff.length = 0;

    expect(
      await create.run({ agentId: "helper", title: "Mine", body: "x" }, person),
    ).not.toHaveProperty("isError");
    expect(
      await create.run({ agentId: "helper", title: "From a run", body: "x" }, run),
    ).not.toHaveProperty("isError");
    expect(
      await create.run({ agentId: "sales", title: "From news", body: "x" }, note),
    ).not.toHaveProperty("isError");
    // The day's slots are gone: each says what to do instead.
    expect(
      await create.run({ agentId: "helper", title: "One more", body: "x" }, { ...run, turn: "4" }),
    ).toEqual({
      isError: true,
      output: `${AT_CAP} Do the work yourself, or ask the owner with wait_on_task.`,
    });
    expect(
      await create.run({ agentId: "helper", title: "One more", body: "x" }, { ...note, turn: "5" }),
    ).toEqual({
      isError: true,
      output: `${AT_CAP} Tell the owner what you would hand off: their message can hand it off.`,
    });
    // A person's turn still hands off, and takes no slot.
    expect(
      await create.run(
        { agentId: "helper", title: "Still mine", body: "x" },
        { ...person, turn: "6" },
      ),
    ).not.toHaveProperty("isError");
    expect(calls).toEqual([
      "create helper Mine by kelpie for u-owner",
      "take kelpie",
      "create helper From a run by kelpie for u-owner",
      "take kelpie",
      "create sales From news by kelpie for u-owner",
      "take kelpie refused",
      "take kelpie refused",
      "create helper Still mine by kelpie for u-owner",
    ]);
    expect(handedOff).toHaveLength(4);
  });

  it("give a slot back when the board refuses the task, and keep it when the create failed", async () => {
    const owned = {
      kelpie: [
        { id: "full", name: "Full" },
        { id: "broken", name: "Broken" },
      ],
    };
    const { provider, calls } = world(owned, { kelpie: 1 });
    const create = byName(await provider.tools("kelpie", { channel: "telegram" }), "create_task");
    const run = contextOf("kelpie", handle().task);

    // A turn the gate or the input refuses takes no slot.
    const group = { ...run, scopes: ["conversation/telegram-group"] } as ToolContext;
    expect(await create.run({ agentId: "full", title: "Book", body: "x" }, group)).toMatchObject({
      isError: true,
    });
    expect(await create.run({ agentId: "stranger", title: "Book", body: "x" }, run)).toMatchObject({
      isError: true,
    });
    expect(await create.run({ agentId: "full", title: " ", body: "x" }, run)).toMatchObject({
      isError: true,
      output: expect.stringContaining("one line"),
    });
    expect(calls).toEqual([]);

    expect(await create.run({ agentId: "full", title: "Book", body: "x" }, run)).toMatchObject({
      isError: true,
      output: expect.stringContaining("its board is full"),
    });
    // The slot came back; a create that throws may have made its task, so it keeps it.
    await expect(
      create.run({ agentId: "broken", title: "Book", body: "x" }, { ...run, turn: "2" }),
    ).rejects.toThrow();
    expect(
      await create.run({ agentId: "full", title: "Book", body: "x" }, { ...run, turn: "3" }),
    ).toMatchObject({ isError: true, output: expect.stringContaining(AT_CAP) });
    expect(calls).toEqual([
      "take kelpie",
      "create full Book by kelpie for u-owner",
      "return kelpie",
      "take kelpie",
      "create broken Book by kelpie for u-owner",
      "take kelpie refused",
    ]);
  });

  it("count a turn's three before its day: a fourth call in one turn takes no slot", async () => {
    const { provider, calls } = world(undefined, { kelpie: 5 });
    const create = byName(await provider.tools("kelpie", { channel: "telegram" }), "create_task");
    const note = contextOf("kelpie", undefined, "note");
    for (let i = 0; i < 4; i++) {
      await create.run({ agentId: "helper", title: `T${i}`, body: "x" }, note);
    }
    expect(calls.filter((call) => call.startsWith("take"))).toHaveLength(3);
    expect(calls.at(-1)).toBe("create helper T2 by kelpie for u-owner");
  });
});
