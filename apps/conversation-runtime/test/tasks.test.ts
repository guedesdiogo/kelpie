import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { TaskView } from "@kelpie/config";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AgentHost,
  replaceTaskRunnerForTesting,
  type TaskRunner,
} from "../src/agent-host/agent-host.ts";
import { LEASE_MS, MAX_RUN_MS } from "../src/agent-host/tasks.ts";

// The task board (ADR-0011, #54): the rules people follow, pickup within the agent's limit, scheduled
// starts, leases and the run protocol #335's task conversation will use.

const host = (id: string) => env.AGENT_HOST.getByName(id);
const owner = { userId: "u-owner", role: "owner", via: "admin-api" } as const;

/** A runner that records each start, as #335's task conversation would begin a run. */
function fakeRunner(fail = false) {
  const started: { agentId: string; task: string; run: number }[] = [];
  const runner: TaskRunner = {
    async start(agentId, task, run) {
      if (fail) throw new Error("no runner today");
      started.push({ agentId, task: task.title, run });
    },
  };
  replaceTaskRunnerForTesting(runner);
  return started;
}

async function create(stub: ReturnType<typeof host>, title: string, extra: object = {}) {
  const created = await stub.createTask({ title, ...extra } as never, owner);
  if (!created.ok) throw new Error(`refused: ${created.reason}`);
  return created.value;
}

const statuses = async (stub: ReturnType<typeof host>) =>
  Object.fromEntries((await stub.listTasks()).map((task) => [task.title, task.status]));

/** Puts a running task's lease in the past, as if its run went silent. */
const expireLease = (stub: ReturnType<typeof host>, task: TaskView) =>
  runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE tasks SET lease_until = ? WHERE id = ?",
      Date.now() - 1,
      task.id,
    );
  });

/** The run a task holds now, from its detail. */
async function runOf(stub: ReturnType<typeof host>, task: TaskView): Promise<number> {
  return runInDurableObject(stub, (_instance, state) => {
    const [row] = state.storage.sql
      .exec<{ id: number }>(
        "SELECT id FROM task_runs WHERE task_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1",
        task.id,
      )
      .toArray();
    if (!row) throw new Error("no open run");
    return row.id;
  });
}

const wakes = (stub: ReturnType<typeof host>) =>
  runInDurableObject(stub, (instance: AgentHost) =>
    instance
      .getSchedules()
      .filter((schedule) => schedule.callback === "wakeTasks")
      // The SDK keeps a schedule's time in seconds.
      .map((schedule) => ("time" in schedule ? schedule.time * 1_000 : null)),
  );

afterEach(() => {
  replaceTaskRunnerForTesting(null);
});

describe("the task board's rules for people (ADR-0011)", () => {
  it("creates tasks in Backlog by default or in To do, with the creator from the actor", async () => {
    const stub = host("board-create");
    const task = await create(stub, "Book the flights", { body: "Lisbon, in May." });
    expect(task).toMatchObject({
      title: "Book the flights",
      body: "Lisbon, in May.",
      status: "backlog",
      scheduledStartAt: null,
      creator: { kind: "user", id: "u-owner" },
      attempt: 0,
      stopRequested: false,
      result: null,
    });
    expect(await create(stub, "Pay the bill", { status: "todo" })).toMatchObject({
      status: "todo",
    });
    expect(await stub.createTask({ title: "Run", status: "in_progress" } as never, owner)).toEqual({
      ok: false,
      reason: "invalid_input",
    });
    expect(await stub.createTask({ title: "Run" } as never, { ...owner, userId: "" })).toEqual({
      ok: false,
      reason: "invalid_input",
    });
  });

  it("lets people edit and move a task only between Backlog and To do, and comment at any time", async () => {
    const stub = host("board-rules");
    const task = await create(stub, "Draft");

    expect(await stub.editTask(task.id, { title: "Draft the letter" }, owner)).toMatchObject({
      ok: true,
      value: { title: "Draft the letter" },
    });
    expect(await stub.moveTask(task.id, "todo", owner)).toMatchObject({
      value: { status: "todo" },
    });
    expect(await stub.moveTask(task.id, "backlog", owner)).toMatchObject({
      value: { status: "backlog" },
    });
    expect(await stub.moveTask(task.id, "done" as never, owner)).toEqual({
      ok: false,
      reason: "invalid_input",
    });
    expect(await stub.commentTask(task.id, "Use the new address.", owner)).toMatchObject({
      ok: true,
    });

    const detail = await stub.getTask(task.id);
    if (!detail.ok) throw new Error("no detail");
    expect(detail.value.comments).toEqual([
      {
        at: expect.any(Number),
        author: { kind: "user", id: "u-owner" },
        source: "board",
        text: "Use the new address.",
      },
    ]);
    expect(detail.value.events.map((event) => [event.kind, event.from, event.to])).toEqual([
      ["created", null, "backlog"],
      ["edited", null, null],
      ["moved", "backlog", "todo"],
      ["moved", "todo", "backlog"],
      ["commented", null, null],
    ]);
    expect(detail.value.events[0]).toMatchObject({
      actor: { kind: "user", id: "u-owner" },
      via: "admin-api",
    });

    const unknown = "00000000-0000-4000-8000-000000000000";
    expect(await stub.getTask(unknown)).toEqual({ ok: false, reason: "unknown_task" });
    expect(await stub.moveTask(unknown, "todo", owner)).toEqual({
      ok: false,
      reason: "unknown_task",
    });
    expect(await stub.getTask("not-a-task")).toEqual({ ok: false, reason: "invalid_input" });
  });

  it("claims nothing while no runner exists, as in production until #335", async () => {
    const stub = host("board-no-runner");
    await create(stub, "Queued", { status: "todo" });
    expect(await statuses(stub)).toEqual({ Queued: "todo" });
    expect(await wakes(stub)).toEqual([]);
  });
});

describe("pickup, the limit and scheduled starts (#54)", () => {
  it("runs up to maxConcurrentTasks, and starts the others in order as slots free", async () => {
    const stub = host("board-limit");
    await stub.configure({ maxConcurrentTasks: 2 }, owner);
    // Queued while no runner takes them, then picked up together.
    const first = await create(stub, "first", { status: "todo" });
    for (const title of ["second", "third", "fourth"])
      await create(stub, title, { status: "todo" });
    const started = fakeRunner();
    await stub.wakeTasks();

    expect(started.map((run) => run.task)).toEqual(["first", "second"]);
    expect(await statuses(stub)).toEqual({
      first: "in_progress",
      second: "in_progress",
      third: "todo",
      fourth: "todo",
    });

    const run = await runOf(stub, first);
    expect(
      await stub.finishTask(first.id, run, { status: "done", result: "Done well." }),
    ).toMatchObject({
      ok: true,
      value: { status: "done", result: "Done well." },
    });
    expect(started.map((one) => one.task)).toEqual(["first", "second", "third"]);
    expect(started[0]?.agentId).toBe("board-limit");

    // Raising the limit counts at the next pickup; lowering it stops nothing that runs.
    await stub.configure({ maxConcurrentTasks: 3 }, owner);
    await stub.wakeTasks();
    expect(started.map((one) => one.task)).toEqual(["first", "second", "third", "fourth"]);
    await stub.configure({ maxConcurrentTasks: 1 }, owner);
    await stub.wakeTasks();
    expect(await statuses(stub)).toMatchObject({
      second: "in_progress",
      third: "in_progress",
      fourth: "in_progress",
    });
  });

  it("holds no slot for a task in Waiting", async () => {
    const started = fakeRunner();
    const stub = host("board-waiting");
    await stub.configure({ maxConcurrentTasks: 1 }, owner);
    const asking = await create(stub, "asking", { status: "todo" });
    await create(stub, "next", { status: "todo" });
    expect(started.map((run) => run.task)).toEqual(["asking"]);

    await stub.finishTask(asking.id, await runOf(stub, asking), {
      status: "waiting",
      reason: "needs_input",
    });
    expect(started.map((run) => run.task)).toEqual(["asking", "next"]);
    expect(await stub.getTask(asking.id)).toMatchObject({
      value: { status: "waiting", waitingReason: "needs_input" },
    });
  });

  it("picks up a task at its scheduled start, on the alarm", async () => {
    const started = fakeRunner();
    const stub = host("board-scheduled");
    const at = Date.now() + 1_200;
    await create(stub, "later", { status: "todo", scheduledStartAt: at });
    expect(started).toEqual([]);
    // The wake is set for the next whole second from the start, so it never fires early.
    expect(await wakes(stub)).toEqual([Math.ceil(at / 1_000) * 1_000]);

    await new Promise((resolve) =>
      setTimeout(resolve, Math.ceil(at / 1_000) * 1_000 - Date.now() + 50),
    );
    await runDurableObjectAlarm(stub);
    expect(started.map((run) => run.task)).toEqual(["later"]);
  });
});

describe("leases, runs and stops (#54)", () => {
  it("sweeps a lease that ran out on the next wake; the second failure in a row waits", async () => {
    const started = fakeRunner();
    const stub = host("board-lease");
    const task = await create(stub, "flaky", { status: "todo" });
    // A wake waits for the lease to run out.
    const [wake] = await wakes(stub);
    expect(wake).toBeGreaterThanOrEqual(Date.now() + LEASE_MS - 60_000);

    await expireLease(stub, task);
    await stub.wakeTasks();
    // The expired attempt goes back to To do and is claimed again at once.
    expect(started.map((run) => run.run)).toHaveLength(2);
    await expireLease(stub, task);
    await stub.wakeTasks();

    const detail = await stub.getTask(task.id);
    if (!detail.ok) throw new Error("no detail");
    expect(detail.value).toMatchObject({ status: "waiting", waitingReason: "failed", attempt: 2 });
    expect(detail.value.runs.map((run) => run.outcome)).toEqual(["expired", "expired"]);
    expect(detail.value.events.filter((event) => event.kind === "lease_expired")).toEqual([
      expect.objectContaining({ actor: null, via: "kelpie", from: "in_progress", to: "todo" }),
      expect.objectContaining({ actor: null, via: "kelpie", from: "in_progress", to: "waiting" }),
    ]);
  });

  it("keeps people out of a running task, and ends it in Cancelled on the owner's stop", async () => {
    fakeRunner();
    const stub = host("board-stop");
    const task = await create(stub, "long", { status: "todo" });
    const run = await runOf(stub, task);

    expect(await stub.moveTask(task.id, "backlog", owner)).toEqual({
      ok: false,
      reason: "not_allowed",
    });
    expect(await stub.editTask(task.id, { title: "shorter" }, owner)).toEqual({
      ok: false,
      reason: "not_allowed",
    });
    expect(await stub.commentTask(task.id, "Please stop.", owner)).toMatchObject({ ok: true });
    expect(await stub.requestStop(task.id, owner)).toMatchObject({
      value: { status: "in_progress", stopRequested: true },
    });
    expect(await stub.heartbeatTask(task.id, run)).toMatchObject({ ok: true, stop: true });

    // The run stops as asked; any end but Done is Cancelled.
    expect(await stub.finishTask(task.id, run, { status: "failed" })).toMatchObject({
      value: { status: "cancelled" },
    });
    expect(await stub.requestStop(task.id, owner)).toEqual({ ok: false, reason: "not_allowed" });

    // A task in Waiting has no run: the stop cancels it at once.
    const waiting = await create(stub, "asking", { status: "todo" });
    await stub.finishTask(waiting.id, await runOf(stub, waiting), {
      status: "waiting",
      reason: "dependency",
    });
    expect(await stub.requestStop(waiting.id, owner)).toMatchObject({
      value: { status: "cancelled" },
    });
  });

  it("cancels a stopped task whose run went silent, at its lease's end", async () => {
    fakeRunner();
    const stub = host("board-stop-silent");
    const task = await create(stub, "silent", { status: "todo" });
    await stub.requestStop(task.id, owner);
    await expireLease(stub, task);
    await stub.wakeTasks();
    expect(await stub.getTask(task.id)).toMatchObject({ value: { status: "cancelled" } });
  });

  it("takes only the current run's reports, and Done only with a result", async () => {
    fakeRunner();
    const stub = host("board-protocol");
    const task = await create(stub, "report", { status: "todo" });
    const run = await runOf(stub, task);

    expect(await stub.finishTask(task.id, run, { status: "done" } as never)).toEqual({
      ok: false,
      reason: "invalid_input",
    });
    expect(await stub.finishTask(task.id, run + 1, { status: "done", result: "x" })).toEqual({
      ok: false,
      reason: "not_allowed",
    });
    expect(await stub.heartbeatTask(task.id, run + 1)).toEqual({
      ok: false,
      reason: "not_running",
    });

    const beat = await stub.heartbeatTask(task.id, run);
    if (!beat.ok) throw new Error("no lease");
    expect(beat.leaseUntil).toBeGreaterThan(Date.now() + LEASE_MS - 5_000);
    // A lease never outlasts MAX_RUN_MS from the run's start.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE task_runs SET started_at = ? WHERE id = ?",
        Date.now() - MAX_RUN_MS + 1_000,
        run,
      );
    });
    const late = await stub.heartbeatTask(task.id, run);
    if (!late.ok) throw new Error("no lease");
    expect(late.leaseUntil).toBeLessThanOrEqual(Date.now() + 1_000);

    expect(await stub.finishTask(task.id, run, { status: "done", result: "Sent." })).toMatchObject({
      value: { status: "done", result: "Sent." },
    });
    expect(await stub.finishTask(task.id, run, { status: "done", result: "Again." })).toEqual({
      ok: false,
      reason: "not_allowed",
    });
  });

  it("counts a run that couldn't start as a failed attempt", async () => {
    fakeRunner(true);
    const stub = host("board-start-fails");
    const task = await create(stub, "unlucky", { status: "todo" });
    const detail = await stub.getTask(task.id);
    if (!detail.ok) throw new Error("no detail");
    // Two failures in a row: the task waits for the owner instead of looping.
    expect(detail.value).toMatchObject({ status: "waiting", waitingReason: "failed", attempt: 2 });
    expect(detail.value.runs.map((run) => run.outcome)).toEqual(["failed", "failed"]);
    expect(detail.value.events.map((event) => event.kind)).toContain("start_failed");
  });
});
