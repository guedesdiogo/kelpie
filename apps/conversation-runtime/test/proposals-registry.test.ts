import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { NewProposal } from "@kelpie/config";
import { describe, expect, it, vi } from "vitest";

// The Registry keeps proposals (ADR-0061, #302): it checks the caps and settles each step in one
// synchronous step, and its alarm expires them and tells their proposers.

const registry = (name: string) => env.REGISTRY.getByName(name);
const owner = { userId: "u-owner", role: "owner", via: "admin-api" } as const;
const page = owner;
const DAY = 24 * 60 * 60_000;

/** A Registry with Master (kelpie), a specialist `sales` with a subagent, and another specialist. */
async function withAgents(name: string) {
  const stub = registry(name);
  await stub.add("sales", "Sales", owner);
  await stub.add("books", "Books", owner);
  await stub.addSubagent("sales-sub-a1b2c3", "Quotes", "sales", { ...owner, via: "agent:sales" });
  return stub;
}

const proposal = (fields: Partial<NewProposal> = {}): NewProposal => ({
  proposer: "kelpie",
  target: "sales",
  actingUserId: "u-owner",
  taskId: null,
  changes: { spawn: true },
  before: { spawn: false },
  reason: "It needs helpers.",
  ...fields,
});
const byMaster = { ...owner, via: "agent:kelpie" } as const;

async function eventsOf(stub: ReturnType<typeof registry>) {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec("SELECT kind, user_id, via FROM proposal_events ORDER BY id").toArray(),
  );
}

async function idOf(result: { ok: boolean; value?: { id: string } }): Promise<string> {
  if (!result.ok || !result.value) throw new Error("not proposed");
  return result.value.id;
}

describe("Registry proposals (#302)", () => {
  it("records a pending proposal about an agent its proposer owns, and audits it", async () => {
    const stub = await withAgents("proposals-record");
    const before = Date.now();

    const made = await stub.propose(proposal(), byMaster);

    expect(made).toMatchObject({
      ok: true,
      value: {
        proposer: "kelpie",
        target: "sales",
        status: "pending",
        changes: { spawn: true },
        before: { spawn: false },
        decidedAt: null,
        decidedBy: null,
      },
    });
    const id = await idOf(made);
    const shown = await stub.proposal(id);
    expect(shown?.expiresAt).toBeGreaterThanOrEqual(before + 72 * 60 * 60_000);
    expect(await stub.proposals("pending")).toEqual([shown]);
    expect(await eventsOf(stub)).toEqual([
      { kind: "proposed", user_id: "u-owner", via: "agent:kelpie" },
    ]);
    // A creator proposes about its own subagent.
    expect(
      await stub.propose(
        proposal({
          proposer: "sales",
          target: "sales-sub-a1b2c3",
          changes: { remit: "Quotes." },
          before: { remit: "" },
        }),
        { ...owner, via: "agent:sales" },
      ),
    ).toMatchObject({ ok: true, value: { status: "pending" } });
  });

  it("refuses a target its proposer doesn't own, and input it doesn't take", async () => {
    const stub = await withAgents("proposals-refused");
    const notAllowed = { ok: false, reason: "not_allowed" };
    const invalid = { ok: false, reason: "invalid_input" };

    expect(await stub.propose(proposal({ proposer: "sales", target: "books" }), byMaster)).toEqual(
      notAllowed,
    );
    expect(await stub.propose(proposal({ target: "kelpie" }), byMaster)).toEqual(notAllowed);
    expect(await stub.propose(proposal({ target: "ghost" }), byMaster)).toEqual({
      ok: false,
      reason: "unknown_agent",
    });
    for (const bad of [
      proposal({ changes: { systemPrompt: "Be terse." }, before: { systemPrompt: "" } }),
      proposal({ reason: "" }),
      proposal({ taskId: "7" }),
      proposal({ actingUserId: "" }),
      proposal({ before: null as never }),
      // The snapshot names the same fields as the change, and stays small.
      proposal({ before: {} }),
      proposal({ before: { remit: "" } }),
      proposal({ before: { spawn: "a".repeat(200_001) as never } }),
    ]) {
      expect(await stub.propose(bad, byMaster), JSON.stringify(bad)).toEqual(invalid);
    }
    expect(await stub.propose(proposal(), { ...owner, role: "member" } as never)).toEqual(invalid);
    expect(await stub.proposals()).toEqual([]);
  });

  it("holds the caps: one per target, three per proposer, ten a day, twenty in all", async () => {
    const stub = await withAgents("proposals-caps");
    const tooMany = { ok: false, reason: "too_many" };
    await stub.add("ops", "Ops", owner);
    await stub.add("hr", "HR", owner);

    await idOf(await stub.propose(proposal(), byMaster));
    expect(
      await stub.propose(proposal({ changes: { remit: "x" }, before: { remit: "" } }), byMaster),
    ).toEqual(tooMany);
    await idOf(await stub.propose(proposal({ target: "books" }), byMaster));
    await idOf(await stub.propose(proposal({ target: "ops" }), byMaster));
    expect(await stub.propose(proposal({ target: "hr" }), byMaster)).toEqual(tooMany);

    // Settled ones don't count against what is pending, but do against the day.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE proposals SET status = 'refused'");
      for (let i = 0; i < 7; i++) {
        state.storage.sql.exec(
          "INSERT INTO proposals (id, proposer_id, target_id, acting_user_id, changes, before, reason, status, created_at, expires_at) VALUES (?, 'kelpie', 'hr', 'u-owner', '{}', '{}', 'x', 'refused', ?, ?)",
          `old-${i}`,
          Date.now() - 1_000,
          Date.now() + DAY,
        );
      }
    });
    expect(await stub.propose(proposal({ target: "hr" }), byMaster)).toEqual(tooMany);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE proposals SET created_at = ?", Date.now() - DAY - 1);
    });
    await idOf(await stub.propose(proposal({ target: "hr" }), byMaster));

    // Twenty pending in all, whoever proposed them.
    await runInDurableObject(stub, (_instance, state) => {
      for (let i = 0; i < 19; i++) {
        state.storage.sql.exec(
          "INSERT INTO proposals (id, proposer_id, target_id, acting_user_id, changes, before, reason, status, created_at, expires_at) VALUES (?, ?, 'x', 'u-owner', '{}', '{}', 'x', 'pending', ?, ?)",
          `other-${i}`,
          `agent-${i}`,
          Date.now() - DAY - 1,
          Date.now() + DAY,
        );
      }
    });
    expect(
      await stub.propose(
        proposal({
          proposer: "sales",
          target: "sales-sub-a1b2c3",
          changes: { remit: "Quotes." },
          before: { remit: "" },
        }),
        { ...owner, via: "agent:sales" },
      ),
    ).toEqual(tooMany);
  });

  it("refuses once, and a repeat or an approval after it changes nothing", async () => {
    const stub = await withAgents("proposals-refuse");
    const id = await idOf(await stub.propose(proposal(), byMaster));

    expect(await stub.refuseProposal(id, page)).toMatchObject({
      ok: true,
      value: { status: "refused", decidedBy: "u-owner" },
    });
    expect(await stub.refuseProposal(id, page)).toEqual({ ok: false, reason: "not_pending" });
    expect(await stub.claimProposal(id, page)).toEqual({ ok: false, reason: "not_pending" });
    expect(await stub.refuseProposal("1a2b3c4d-1111-4222-8333-444455556666", page)).toEqual({
      ok: false,
      reason: "unknown_proposal",
    });
    expect((await eventsOf(stub)).map((event) => (event as { kind: string }).kind)).toEqual([
      "proposed",
      "refused",
    ]);
  });

  it("claims a pending proposal once, and finishes it once", async () => {
    const stub = await withAgents("proposals-claim");
    const id = await idOf(await stub.propose(proposal(), byMaster));

    expect(await stub.claimProposal(id, page)).toMatchObject({
      ok: true,
      value: { status: "applying" },
    });
    expect(await stub.claimProposal(id, page)).toEqual({ ok: false, reason: "not_pending" });
    // However long it has been: an approval that never finished is the alarm's to settle.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE proposals SET claimed_at = ?", Date.now() - 61_000);
    });
    expect(await stub.claimProposal(id, page)).toEqual({ ok: false, reason: "not_pending" });
    expect(await stub.finishProposal(id, "applied", page)).toMatchObject({
      ok: true,
      value: { status: "applied", decidedBy: "u-owner" },
    });
    expect(await stub.finishProposal(id, "applied", page)).toEqual({
      ok: false,
      reason: "not_pending",
    });
  });

  it("releases a claim back to pending, and settles a conflict", async () => {
    const stub = await withAgents("proposals-release");
    const id = await idOf(await stub.propose(proposal(), byMaster));

    await stub.claimProposal(id, page);
    expect(await stub.finishProposal(id, "released", page)).toMatchObject({
      ok: true,
      value: { status: "pending", decidedAt: null },
    });
    await stub.claimProposal(id, page);
    expect(await stub.finishProposal(id, "conflict", page)).toMatchObject({
      ok: true,
      value: { status: "conflict" },
    });
    expect((await eventsOf(stub)).map((event) => (event as { kind: string }).kind)).toEqual([
      "proposed",
      "claimed",
      "released",
      "claimed",
      "conflict",
    ]);
  });

  it("settles instead of claiming one that is due, whose target went, or whose owner changed", async () => {
    const stub = await withAgents("proposals-settle");
    const due = await idOf(await stub.propose(proposal(), byMaster));
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE proposals SET expires_at = ?", Date.now() - 1);
    });
    // Reading it changes nothing; it only shows as expired.
    expect((await stub.proposal(due))?.status).toBe("expired");
    expect(
      await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec("SELECT status FROM proposals").one(),
      ),
    ).toEqual({ status: "pending" });
    // And it lists as expired, not as pending.
    expect((await stub.proposals("pending")).map((one) => one.id)).not.toContain(due);
    expect((await stub.proposals("expired")).map((one) => one.id)).toEqual([due]);
    expect(await stub.claimProposal(due, page)).toMatchObject({
      ok: true,
      value: { status: "expired", decidedBy: null },
    });
    expect((await stub.proposals("expired")).map((one) => one.id)).toEqual([due]);
    expect(await stub.refuseProposal(due, page)).toEqual({ ok: false, reason: "not_pending" });

    const moved = await idOf(await stub.propose(proposal({ target: "books" }), byMaster));
    await stub.setMaster("sales", owner);
    expect(await stub.claimProposal(moved, page)).toMatchObject({
      ok: true,
      value: { status: "conflict" },
    });
  });

  it("voids the pending proposals by or about an agent that is deleted", async () => {
    const stub = await withAgents("proposals-void");
    const about = await idOf(
      await stub.propose(
        proposal({
          proposer: "sales",
          target: "sales-sub-a1b2c3",
          changes: { remit: "Quotes." },
          before: { remit: "" },
        }),
        { ...owner, via: "agent:sales" },
      ),
    );
    const other = await idOf(await stub.propose(proposal({ target: "books" }), byMaster));

    expect(await stub.remove("sales-sub-a1b2c3", owner)).toEqual({ ok: true });

    expect((await stub.proposal(about))?.status).toBe("void");
    expect((await stub.proposal(other))?.status).toBe("pending");
    expect((await eventsOf(stub)).filter((event) => event.kind === "void")).toEqual([
      { kind: "void", user_id: "u-owner", via: "admin-api" },
    ]);
    // Its proposer remains, so it hears it, as of any outcome.
    const told = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec(
          "SELECT tell_attempts + (next_tell_at IS NOT NULL) AS due FROM proposals WHERE id = ?",
          about,
        )
        .one(),
    );
    expect(Number(told.due)).toBeGreaterThan(0);
  });

  it("tells nothing to a proposer deleted since, and makes no object for it", async () => {
    const stub = await withAgents("proposals-untold");
    const id = await idOf(
      await stub.propose(
        proposal({
          proposer: "sales",
          target: "sales-sub-a1b2c3",
          changes: { remit: "Quotes." },
          before: { remit: "" },
        }),
        { ...owner, via: "agent:sales" },
      ),
    );
    await stub.remove("sales-sub-a1b2c3", owner);
    // The void is told at once, and the first try fails: sales has no conversation yet.
    await vi.waitFor(async () => {
      const row = await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec("SELECT tell_attempts FROM proposals WHERE id = ?", id).one(),
      );
      expect(row.tell_attempts).toBe(1);
    });
    await stub.remove("sales", owner);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE proposals SET next_tell_at = ? WHERE id = ?",
        Date.now() - 1,
        id,
      );
    });

    await runDurableObjectAlarm(stub);

    const row = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec("SELECT next_tell_at, told_at FROM proposals WHERE id = ?", id).one(),
    );
    expect(row).toEqual({ next_tell_at: null, told_at: null });
    expect((await eventsOf(stub)).at(-1)).toEqual({ kind: "untold", user_id: null, via: "kelpie" });
  });

  it("validates a step's input, because it is an RPC boundary", async () => {
    const stub = await withAgents("proposals-validates");
    const invalid = { ok: false, reason: "invalid_input" };

    expect(await stub.refuseProposal("nope", page)).toEqual(invalid);
    expect(await stub.claimProposal("nope", page)).toEqual(invalid);
    expect(await stub.finishProposal("nope", "applied", page)).toEqual(invalid);
    expect(
      await stub.finishProposal("1a2b3c4d-1111-4222-8333-444455556666", "maybe" as never, page),
    ).toEqual(invalid);
    expect(await stub.proposal("nope")).toBeNull();
    expect(await stub.proposals("maybe" as never)).toEqual([]);
  });
});

describe("Registry proposals' alarm (#302)", () => {
  it("expires a due proposal and tries telling its proposer three times, then gives up", async () => {
    const stub = await withAgents("proposals-alarm");
    const id = await idOf(await stub.propose(proposal({ proposer: "kelpie" }), byMaster));
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE proposals SET expires_at = ?", Date.now() - 1);
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect(await stub.proposal(id)).toMatchObject({ status: "expired", decidedBy: null });
    // Master holds no conversation here, so the first try fails, and two more follow.
    for (let i = 0; i < 2; i++) {
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec("UPDATE proposals SET next_tell_at = ?", Date.now() - 1);
      });
      expect(await runDurableObjectAlarm(stub)).toBe(true);
    }
    const row = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec("SELECT tell_attempts, told_at, next_tell_at FROM proposals").one(),
    );
    expect(row).toEqual({ tell_attempts: 3, told_at: null, next_tell_at: null });
    expect((await eventsOf(stub)).map((event) => (event as { kind: string }).kind)).toEqual([
      "proposed",
      "expired",
      "untold",
    ]);
    // Nothing is left to wake for.
    expect(await runDurableObjectAlarm(stub)).toBe(false);
  });

  it("tells a task-run proposer the outcome as Kelpie's comment on its task", async () => {
    const stub = await withAgents("proposals-told");
    const specialist = env.AGENT_HOST.getByName("told-sales");
    const task = await specialist.createTask(
      { title: "Price the quote", body: "", status: "backlog", scheduledStartAt: null },
      owner,
    );
    if (!task.ok) throw new Error(task.reason);
    // The proposer here is a specialist the test lists, owning a subagent.
    await stub.add("told-sales", "Sales", owner);
    await stub.addSubagent("told-sales-sub-a1b2c3", "Quotes", "told-sales", {
      ...owner,
      via: "agent:told-sales",
    });
    const id = await idOf(
      await stub.propose(
        proposal({
          proposer: "told-sales",
          target: "told-sales-sub-a1b2c3",
          taskId: task.value.id,
          changes: { remit: "Quotes." },
          before: { remit: "" },
        }),
        { ...owner, via: "agent:told-sales" },
      ),
    );

    await stub.refuseProposal(id, page);
    // The alarm is set for now, so it runs at once; running it here too changes nothing.
    await runDurableObjectAlarm(stub);
    await vi.waitFor(async () =>
      expect((await eventsOf(stub)).map((event) => (event as { kind: string }).kind)).toContain(
        "told",
      ),
    );

    const detail = await specialist.getTask(task.value.id);
    expect(detail).toMatchObject({
      ok: true,
      value: { comments: [{ author: { kind: "kelpie", id: "kelpie" }, source: "kelpie" }] },
    });
    const comment = detail.ok ? (detail.value.comments[0]?.text ?? "") : "";
    expect(comment).toContain(`The owner refused your proposal ${id}`);
    expect(comment).toContain("Nothing changed");
    expect((await eventsOf(stub)).map((event) => (event as { kind: string }).kind)).toEqual([
      "proposed",
      "refused",
      "told",
    ]);
  });
});

describe("Registry proposals' abandoned approvals (#302)", () => {
  /** A claimed proposal whose approval never finished, five minutes ago and more. */
  async function abandoned(stub: ReturnType<typeof registry>, target: string) {
    const id = await idOf(await stub.propose(proposal({ target }), byMaster));
    await stub.claimProposal(id, page);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE proposals SET claimed_at = ? WHERE id = ?",
        Date.now() - 6 * 60_000,
        id,
      );
    });
    return id;
  }

  it("settles one as applied when its target holds the change, as the owner who approved it", async () => {
    const stub = await withAgents("proposals-abandoned-applied");
    await stub.add("ab-ops", "Ops", owner);
    const id = await abandoned(stub, "ab-ops");
    await env.AGENT_HOST.getByName("ab-ops").configure({ spawn: true }, owner);

    await runDurableObjectAlarm(stub);

    expect(await stub.proposal(id)).toMatchObject({ status: "applied", decidedBy: "u-owner" });
  });

  it("puts one back to pending when its target doesn't hold the change", async () => {
    const stub = await withAgents("proposals-abandoned-released");
    await stub.add("ab-hr", "HR", owner);
    const id = await abandoned(stub, "ab-hr");

    await runDurableObjectAlarm(stub);

    expect(await stub.proposal(id)).toMatchObject({ status: "pending", decidedAt: null });
    expect((await eventsOf(stub)).at(-1)).toEqual({
      kind: "released",
      user_id: null,
      via: "kelpie",
    });
    // The owner decides it again.
    expect(await stub.refuseProposal(id, page)).toMatchObject({
      ok: true,
      value: { status: "refused" },
    });
  });
});

describe("Registry proposals after a rollback (#302)", () => {
  it("sets its alarm again as it starts, when a release without alarm() dropped it", async () => {
    const stub = await withAgents("proposals-rearm");
    await idOf(await stub.propose(proposal(), byMaster));
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAlarm();
    });

    await evictDurableObject(stub);

    expect(await stub.proposals("pending")).toHaveLength(1);
    expect(
      await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm()),
    ).not.toBeNull();
  });
});
