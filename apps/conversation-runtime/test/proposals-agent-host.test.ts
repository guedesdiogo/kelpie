import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { ProposalOutcome, TaskDetail } from "@kelpie/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  outcomeNote,
  replaceTaskRunnerForTesting,
  runInput,
  type TaskRunner,
} from "../src/agent-host/agent-host.ts";

// What an AgentHost does for proposals (#302): a change that applies only while the settings hold
// what it was proposed against, and Kelpie's word of an outcome to the proposer, on the task that
// made it or in its latest conversation with the owner.

const host = (id: string) => env.AGENT_HOST.getByName(id);
const owner = { userId: "u-owner", role: "owner", via: "admin-api" } as const;
const PROPOSAL = "1a2b3c4d-1111-4222-8333-444455556666";
const asProposal = { ...owner, via: `proposal:${PROPOSAL}` } as const;

const outcome = (fields: Partial<ProposalOutcome> = {}): ProposalOutcome => ({
  id: PROPOSAL,
  target: "sales-sub-a1b2c3",
  taskId: null,
  actingUserId: "u-owner",
  status: "refused",
  fields: ["model", "remit"],
  ...fields,
});

const auditOf = (stub: ReturnType<typeof host>) =>
  runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec("SELECT via, fields FROM audit_log ORDER BY id").toArray(),
  );

describe("a proposal's change on the target's AgentHost (#302)", () => {
  it("applies only while the settings hold what it was proposed against", async () => {
    const stub = host("expect-applies");

    expect(await stub.configure({ remit: "Quotes." }, asProposal, { remit: "" })).toMatchObject({
      ok: true,
      value: { settings: { remit: "Quotes." } },
    });
    expect(await auditOf(stub)).toEqual([
      { via: `proposal:${PROPOSAL}`, fields: JSON.stringify(["remit"]) },
    ]);
  });

  it("is a conflict once a field changed since, and a repeat of what applied changes nothing", async () => {
    const stub = host("expect-conflict");
    await stub.configure({ remit: "Edited by the owner." }, owner);

    expect(await stub.configure({ remit: "Quotes." }, asProposal, { remit: "" })).toEqual({
      ok: false,
      reason: "conflict",
    });
    expect((await stub.config()).settings.remit).toBe("Edited by the owner.");
    // A claim taken again after its finish was lost finds the change applied, and answers so.
    expect(
      await stub.configure({ remit: "Edited by the owner." }, asProposal, { remit: "" }),
    ).toMatchObject({ ok: true });
    expect(await auditOf(stub)).toHaveLength(1);
    expect(await stub.configure({ remit: "Quotes." }, asProposal, { remit: 7 } as never)).toEqual({
      ok: false,
      reason: "invalid_input",
    });
  });
});

describe("a proposal's outcome on the proposer's AgentHost (#302)", () => {
  let comments: { taskId: string; text: string }[];
  beforeEach(() => {
    comments = [];
    const runner: TaskRunner = {
      async start() {},
      async comment(_agentId, taskId, _userId, text) {
        comments.push({ taskId, text });
      },
    };
    replaceTaskRunnerForTesting(runner);
  });
  afterEach(() => replaceTaskRunnerForTesting(undefined));

  async function waitingTask(stub: ReturnType<typeof host>, reason = "dependency") {
    const created = await stub.createTask(
      { title: "Price the quote", body: "", status: "backlog", scheduledStartAt: null },
      owner,
    );
    if (!created.ok) throw new Error(created.reason);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE tasks SET status = 'waiting', waiting_reason = ? WHERE id = ?",
        reason,
        created.value.id,
      );
    });
    return created.value.id;
  }

  it("comments on the task that made it as Kelpie, which resumes a waiting one", async () => {
    const stub = host("outcome-task");
    const taskId = await waitingTask(stub);

    expect(await stub.proposalOutcome(outcome({ taskId, status: "applied" }))).toBe(true);

    const detail = await stub.getTask(taskId);
    expect(detail).toMatchObject({
      ok: true,
      value: {
        // Back to To do; the runner then takes it.
        comments: [{ author: { kind: "kelpie", id: "kelpie" }, source: "kelpie" }],
      },
    });
    const value = (detail as { value: TaskDetail }).value;
    expect(["todo", "in_progress"]).toContain(value.status);
    expect(value.comments[0]?.text).toContain(`The owner approved your proposal ${PROPOSAL}`);
    // Kelpie's own steps carry no actor.
    expect(value.events.filter((event) => event.kind === "commented")).toEqual([
      expect.objectContaining({ actor: null, via: `proposal:${PROPOSAL}` }),
    ]);
  });

  it("resumes only a task waiting on other work, and comments once however often it is told", async () => {
    const stub = host("outcome-asked");
    const asked = await waitingTask(stub, "needs_input");

    expect(await stub.proposalOutcome(outcome({ taskId: asked, status: "refused" }))).toBe(true);
    expect(await stub.proposalOutcome(outcome({ taskId: asked, status: "refused" }))).toBe(true);

    const detail = await stub.getTask(asked);
    // Its question still waits for the owner's answer.
    expect(detail).toMatchObject({ ok: true, value: { status: "waiting" } });
    expect((detail as { value: TaskDetail }).value.comments).toHaveLength(1);
  });

  it("reaches a running task's run in Kelpie's words, never fenced as another agent's", async () => {
    const stub = host("outcome-running");
    const taskId = await waitingTask(stub);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE tasks SET status = 'in_progress' WHERE id = ?", taskId);
    });

    expect(await stub.proposalOutcome(outcome({ taskId, status: "expired" }))).toBe(true);

    expect(comments).toEqual([
      {
        taskId,
        text: expect.stringMatching(
          /^Kelpie, automatically \(not the owner\): Your proposal .* expired/,
        ),
      },
    ]);
    expect(comments[0]?.text).not.toContain("agent-words-");
  });

  it("falls back to the proposer's conversation, and says when nothing took it", async () => {
    const stub = host("outcome-none");

    // No such task, and no conversation with the owner yet.
    expect(
      await stub.proposalOutcome(
        outcome({ taskId: "0f8b7c1e-6a2d-4c3b-9e5f-1a2b3c4d5e6f", status: "conflict" }),
      ),
    ).toBe(false);
    expect(await stub.proposalOutcome(outcome())).toBe(false);
    expect(await stub.proposalOutcome({ ...outcome(), status: "void" } as never)).toBe(false);
    expect(await stub.proposalNotice({} as never)).toBe(false);
  });
});

describe("Kelpie's words of an outcome (#302)", () => {
  it("says what happened, and that nothing changed unless it was applied", () => {
    const what = `your proposal ${PROPOSAL} to change model, remit of the agent sales-sub-a1b2c3`;
    expect(outcomeNote(outcome({ status: "applied" }))).toBe(
      `The owner approved ${what}: it is applied.`,
    );
    for (const status of ["refused", "expired", "conflict", "void"] as const) {
      const note = outcomeNote(outcome({ status }));
      expect(note, status).toContain("Nothing changed.");
      expect(note, status).toContain("unless the need is new");
    }
    expect(outcomeNote(outcome({ status: "conflict" }))).toContain(
      "the agent sales-sub-a1b2c3 changed since you proposed it",
    );
    expect(outcomeNote(outcome({ status: "void" }))).toMatch(
      /^Your proposal .* no longer applies: an agent it named was deleted\./,
    );
  });

  it("puts Kelpie's comments in a run's input as its own, unfenced", () => {
    const input = runInput({
      id: "0f8b7c1e-6a2d-4c3b-9e5f-1a2b3c4d5e6f",
      title: "Price the quote",
      status: "todo",
      scheduledStartAt: null,
      createdAt: 1,
      updatedAt: 1,
      creator: { kind: "agent", id: "kelpie" },
      body: "",
      waitingReason: null,
      attempt: 1,
      stopRequested: false,
      result: null,
      comments: [
        {
          at: 2,
          author: { kind: "kelpie", id: "kelpie" },
          source: "kelpie",
          text: "The owner approved your proposal.",
        },
      ],
      events: [],
      runs: [],
    });
    expect(input.note).toContain(
      "Kelpie's notes on it, oldest first:\n- The owner approved your proposal.",
    );
  });
});
