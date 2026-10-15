import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { TaskView } from "@kelpie/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentHost,
  replaceTaskRunnerForTesting,
  type TaskRunner,
} from "../src/agent-host/agent-host.ts";
import { LEASE_MS, MAX_RUN_MS, STOP_GRACE_MS } from "../src/agent-host/tasks.ts";

// The task board (ADR-0011, #54): the rules people follow, pickup within the agent's limit, scheduled
// starts, leases and the run protocol #335's task conversation will use.

const host = (id: string) => env.AGENT_HOST.getByName(id);
const owner = { userId: "u-owner", role: "owner", via: "admin-api" } as const;

/** A runner that records each start, as #335's task conversation would begin a run. */
function fakeRunner(fail = false) {
  const started: { agentId: string; task: string; run: string }[] = [];
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

/** The token of the run a task holds now. */
async function runOf(stub: ReturnType<typeof host>, task: TaskView): Promise<string> {
  return runInDurableObject(stub, (_instance, state) => {
    const [row] = state.storage.sql
      .exec<{ token: string }>(
        "SELECT token FROM task_runs WHERE task_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1",
        task.id,
      )
      .toArray();
    if (!row) throw new Error("no open run");
    return row.token;
  });
}

/** A token no run holds. */
const STALE = "00000000-0000-4000-8000-000000000001";

/** Runs a read on an object again once its destroyed instance is gone. */
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

const sleepUntil = (at: number) =>
  new Promise((resolve) => setTimeout(resolve, Math.max(at - Date.now(), 0) + 50));

const wakes = (stub: ReturnType<typeof host>) =>
  runInDurableObject(stub, (instance: AgentHost) =>
    instance
      .getSchedules()
      .filter((schedule) => schedule.callback === "wakeTasks")
      // The SDK keeps a schedule's time in seconds.
      .map((schedule) => ("time" in schedule ? schedule.time * 1_000 : null)),
  );

// Each test picks its runner; none by default, as before #335 brought the task conversations.
beforeEach(() => {
  replaceTaskRunnerForTesting(null);
});
afterEach(() => {
  replaceTaskRunnerForTesting(undefined);
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
    // The answer is the task as it is after pickup: already running.
    expect(asking).toMatchObject({ status: "in_progress", attempt: 1 });
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
    // Run here, unless the runtime already ran it on its own and is still running it (#351).
    await runDurableObjectAlarm(stub);
    await vi.waitFor(() => expect(started.map((run) => run.task)).toEqual(["later"]));
  });
});

describe("leases, runs and stops (#54)", () => {
  it("sweeps a lease that ran out on the next wake; the second failure in a row waits", async () => {
    const started = fakeRunner();
    const stub = host("board-lease");
    const before = Date.now();
    const task = await create(stub, "flaky", { status: "todo" });
    // A wake waits for the lease to run out, and no longer.
    const [wake] = await wakes(stub);
    expect(wake).toBeGreaterThanOrEqual(before + LEASE_MS);
    expect(wake).toBeLessThanOrEqual(Date.now() + LEASE_MS + 1_000);

    // The run goes silent: its lease ends in a moment, and the alarm sweeps it.
    const soon = Date.now() + 1_200;
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE tasks SET lease_until = ? WHERE id = ?", soon, task.id);
    });
    await stub.wakeTasks();
    expect(await wakes(stub)).toEqual([Math.ceil(soon / 1_000) * 1_000]);
    await sleepUntil(Math.ceil(soon / 1_000) * 1_000);
    // The alarm sweeps it: run here, unless the runtime already ran it on its own (#351).
    await runDurableObjectAlarm(stub);
    // The expired attempt goes back to To do and is claimed again at once.
    await vi.waitFor(() => expect(started.map((run) => run.run)).toHaveLength(2));
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
    // The run has STOP_GRACE_MS left, whatever its heartbeat says.
    const beat = await stub.heartbeatTask(task.id, run);
    expect(beat).toMatchObject({ ok: true, stop: true });
    expect(beat.ok && beat.leaseUntil).toBeLessThanOrEqual(Date.now() + STOP_GRACE_MS);

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
      value: { status: "cancelled", waitingReason: null },
    });

    // A run that finishes before it stops keeps its Done.
    const quick = await create(stub, "quick", { status: "todo" });
    const quickRun = await runOf(stub, quick);
    await stub.requestStop(quick.id, owner);
    expect(
      await stub.finishTask(quick.id, quickRun, { status: "done", result: "Already sent." }),
    ).toMatchObject({ value: { status: "done", result: "Already sent." } });
  });

  it("ends the lease of a run that ignores the stop, within STOP_GRACE_MS", async () => {
    fakeRunner();
    const stub = host("board-stop-ignored");
    const task = await create(stub, "stubborn", { status: "todo" });
    const run = await runOf(stub, task);
    await stub.requestStop(task.id, owner);
    // The owner asked longer ago than the grace: no heartbeat keeps the lease.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE tasks SET stop_requested_at = ?, lease_until = ? WHERE id = ?",
        Date.now() - STOP_GRACE_MS - 1_000,
        Date.now() - 1,
        task.id,
      );
    });
    expect(await stub.heartbeatTask(task.id, run)).toEqual({ ok: false, reason: "not_running" });
    await stub.wakeTasks();
    expect(await stub.getTask(task.id)).toMatchObject({ value: { status: "cancelled" } });
    expect(await stub.finishTask(task.id, run, { status: "done", result: "Late." })).toEqual({
      ok: false,
      reason: "not_allowed",
    });
  });

  it("refuses people's changes to a task in Waiting, Done or Cancelled, but takes comments", async () => {
    fakeRunner();
    const stub = host("board-ended");
    const ended: TaskView[] = [];
    for (const [title, outcome] of [
      ["waits", { status: "waiting", reason: "needs_input" }],
      ["done", { status: "done", result: "Done." }],
      ["cancelled", { status: "cancelled" }],
    ] as const) {
      const task = await create(stub, title, { status: "todo" });
      await stub.finishTask(task.id, await runOf(stub, task), outcome);
      ended.push(task);
    }
    const refused = { ok: false, reason: "not_allowed" };
    for (const task of ended) {
      expect(await stub.editTask(task.id, { title: "again" }, owner)).toEqual(refused);
      expect(await stub.moveTask(task.id, "todo", owner)).toEqual(refused);
      expect(await stub.commentTask(task.id, "Noted.", owner)).toMatchObject({ ok: true });
    }
    for (const task of ended.slice(1)) {
      expect(await stub.requestStop(task.id, owner)).toEqual(refused);
    }
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
    expect(await stub.finishTask(task.id, STALE, { status: "done", result: "x" })).toEqual({
      ok: false,
      reason: "not_allowed",
    });
    expect(await stub.heartbeatTask(task.id, STALE)).toEqual({
      ok: false,
      reason: "not_running",
    });
    expect(await stub.heartbeatTask(task.id, 7 as never)).toEqual({
      ok: false,
      reason: "not_running",
    });

    const beat = await stub.heartbeatTask(task.id, run);
    if (!beat.ok) throw new Error("no lease");
    expect(beat.leaseUntil).toBeGreaterThan(Date.now() + LEASE_MS - 5_000);
    // A lease never outlasts MAX_RUN_MS from the run's start.
    const startedAt = (at: number) =>
      runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec("UPDATE task_runs SET started_at = ? WHERE token = ?", at, run);
      });
    await startedAt(Date.now() - MAX_RUN_MS + 1_000);
    const late = await stub.heartbeatTask(task.id, run);
    if (!late.ok) throw new Error("no lease");
    expect(late.leaseUntil).toBeLessThanOrEqual(Date.now() + 1_000);
    // Past the ceiling, the heartbeat no longer holds the task.
    await startedAt(Date.now() - MAX_RUN_MS - 1_000);
    expect(await stub.heartbeatTask(task.id, run)).toEqual({ ok: false, reason: "not_running" });

    expect(await stub.finishTask(task.id, run, { status: "done", result: "Sent." })).toMatchObject({
      value: { status: "done", result: "Sent." },
    });
    expect(await stub.finishTask(task.id, run, { status: "done", result: "Again." })).toEqual({
      ok: false,
      reason: "not_allowed",
    });
  });

  it("counts a run that couldn't start as a failed attempt, tried again a minute later", async () => {
    fakeRunner(true);
    const stub = host("board-start-fails");
    const before = Date.now();
    const task = await create(stub, "unlucky", { status: "todo" });
    expect(task).toMatchObject({ status: "todo", attempt: 1 });
    // Not again in the same pass: the next wake, a minute on, tries it.
    const [wake] = await wakes(stub);
    expect(wake).toBeGreaterThanOrEqual(before + 60_000);
    expect(wake).toBeLessThanOrEqual(Date.now() + 61_000);

    await stub.wakeTasks();
    const detail = await stub.getTask(task.id);
    if (!detail.ok) throw new Error("no detail");
    // Two failures in a row: the task waits for the owner instead of looping.
    expect(detail.value).toMatchObject({ status: "waiting", waitingReason: "failed", attempt: 2 });
    expect(detail.value.runs.map((run) => run.outcome)).toEqual(["failed", "failed"]);
    expect(detail.value.events.map((event) => event.kind)).toContain("start_failed");
  });

  it("stops a pass after three runs that couldn't start", async () => {
    const stub = host("board-start-storm");
    for (const title of ["a", "b", "c", "d", "e"]) await create(stub, title, { status: "todo" });
    let attempts = 0;
    replaceTaskRunnerForTesting({
      async start() {
        attempts += 1;
        throw new Error("down");
      },
    });
    await stub.configure({ maxConcurrentTasks: 10 }, owner);
    await stub.wakeTasks();
    expect(attempts).toBe(3);
  });

  it("goes with its agent: deleting the agent erases its tasks (#303)", async () => {
    const stub = host("board-erased");
    await create(stub, "private", { body: "Personal data." });
    expect(await stub.erase([])).toMatchObject({ ok: true });
    expect(await afterDestroy(() => host("board-erased").listTasks())).toEqual([]);
  });
});

describe("tasks other agents write (#335)", () => {
  const helper = (id: string) => host(id);
  const by = (agentId: string) => ({ agentId, actingUserId: "u-owner" });

  it("lets an agent's own comment leave its waiting task waiting: the answer comes from others", async () => {
    fakeRunner();
    await env.REGISTRY.getByName("registry").add("board-self", "Self", owner);
    const stub = helper("board-self");
    const task = await create(stub, "asks", { status: "todo" });
    await stub.finishTask(task.id, await runOf(stub, task), {
      status: "waiting",
      reason: "needs_input",
    });

    expect(
      await stub.commentTaskAs(task.id, "I answer myself.", "board-self", "agent"),
    ).toMatchObject({ value: { status: "waiting" } });
    // The agent that owns it answers: the task goes back to To do, and runs again.
    expect(await stub.commentTaskAs(task.id, "May 3rd.", "kelpie", "chat")).toMatchObject({
      value: { status: "in_progress", attempt: 2 },
    });
    const detail = await stub.getTask(task.id);
    if (!detail.ok) throw new Error("no detail");
    expect(detail.value.comments.map((comment) => [comment.author.id, comment.source])).toEqual([
      ["board-self", "agent"],
      ["kelpie", "chat"],
    ]);
  });

  it("keeps most of a board for the owner: other agents open at most 20 tasks on it", async () => {
    await env.REGISTRY.getByName("registry").add("board-crowded", "Crowded", owner);
    const stub = helper("board-crowded");
    const task = { title: "x", body: "", status: "backlog", scheduledStartAt: null } as const;
    for (let i = 0; i < 20; i++) {
      expect(await stub.createTaskFor(task, by("kelpie"))).toMatchObject({ ok: true });
    }
    expect(await stub.createTaskFor(task, by("kelpie"))).toEqual({
      ok: false,
      reason: "not_allowed",
    });
    expect(await stub.createTask(task, owner)).toMatchObject({ ok: true });
  });

  it("cancels a task once it went to Waiting five times, so no loop runs on", async () => {
    fakeRunner();
    const stub = helper("board-loop");
    const task = await create(stub, "loops", { status: "todo" });
    for (let i = 0; i < 6; i++) {
      await stub.finishTask(task.id, await runOf(stub, task), {
        status: "waiting",
        reason: "needs_input",
      });
      await stub.commentTask(task.id, "Try again.", owner);
    }
    expect(await stub.getTask(task.id)).toMatchObject({
      value: { status: "cancelled", result: "It waited too many times." },
    });
  });

  it("runs none of an agent's tasks while its limit is 0", async () => {
    const started = fakeRunner();
    const stub = helper("board-off");
    await stub.configure({ maxConcurrentTasks: 0 }, owner);
    await create(stub, "held", { status: "todo" });
    expect(started).toEqual([]);
  });
});
