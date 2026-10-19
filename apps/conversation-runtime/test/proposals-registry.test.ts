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
      // A value for each field: an undefined one would lose its stale check.
      proposal({ before: { spawn: undefined } as never }),
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

  it("counts an approval being applied as pending for its target's cap", async () => {
    const stub = await withAgents("proposals-caps-applying");
    const id = await idOf(await stub.propose(proposal(), byMaster));
    expect(await stub.claimProposal(id, page)).toMatchObject({
      ok: true,
      value: { status: "applying" },
    });

    expect(
      await stub.propose(proposal({ changes: { remit: "x" }, before: { remit: "" } }), byMaster),
    ).toEqual({ ok: false, reason: "too_many" });
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

  it("settles a conflict, and takes no outcome it doesn't know", async () => {
    const stub = await withAgents("proposals-release");
    const id = await idOf(await stub.propose(proposal(), byMaster));

    await stub.claimProposal(id, page);
    expect(await stub.finishProposal(id, "released" as never, page)).toEqual({
      ok: false,
      reason: "invalid_input",
    });
    expect(await stub.finishProposal(id, "conflict", page)).toMatchObject({
      ok: true,
      value: { status: "conflict" },
    });
    expect((await eventsOf(stub)).map((event) => (event as { kind: string }).kind)).toEqual([
      "proposed",
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

  it("tells nothing to a proposer deleted since", async () => {
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
    // A cascade deletes the subagent, then its creator, within the void's grace.
    await stub.remove("sales-sub-a1b2c3", owner);
    const due = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec("SELECT next_tell_at FROM proposals WHERE id = ?", id).one(),
    );
    expect(Number(due.next_tell_at)).toBeGreaterThan(Date.now() + 50_000);
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
      state.storage.sql
        .exec("SELECT tell_attempts, next_tell_at, told_at FROM proposals WHERE id = ?", id)
        .one(),
    );
    expect(row).toEqual({ tell_attempts: 0, next_tell_at: null, told_at: null });
    expect((await eventsOf(stub)).at(-1)).toEqual({ kind: "untold", user_id: null, via: "kelpie" });
  });

  it("stores the change as its target's role takes it", async () => {
    const stub = await withAgents("proposals-parsed");
    const made = await stub.propose(
      proposal({
        target: "books",
        changes: { tools: ["memory_search", "memory_search"], remit: "  Books.  " },
        before: { tools: null, remit: "" },
      }),
      byMaster,
    );
    expect(made).toMatchObject({
      ok: true,
      value: { changes: { tools: ["memory_search"], remit: "Books." } },
    });
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

  it("is woken for five minutes after its claim", async () => {
    const stub = await withAgents("proposals-abandoned-wake");
    const id = await idOf(await stub.propose(proposal(), byMaster));
    await stub.claimProposal(id, page);

    const [claimedAt, alarm] = await runInDurableObject(stub, async (_instance, state) => [
      Number(state.storage.sql.exec("SELECT claimed_at FROM proposals").one().claimed_at),
      await state.storage.getAlarm(),
    ]);
    expect(alarm).toBe(claimedAt + 5 * 60_000);
  });

  it("settles a chat change by the Registry's own chat, and one whose target went as void", async () => {
    const stub = await withAgents("proposals-abandoned-chat");
    const chat = await idOf(
      await stub.propose(proposal({ changes: { chat: true }, before: { chat: false } }), byMaster),
    );
    await stub.claimProposal(chat, page);
    await stub.setChat("sales", true, owner);
    const gone = await abandoned(stub, "books");
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE proposals SET claimed_at = ? WHERE id = ?",
        Date.now() - 6 * 60_000,
        chat,
      );
      // As if the target's row went with no deletion to void it.
      state.storage.sql.exec("DELETE FROM agents WHERE id = 'books'");
    });

    await runDurableObjectAlarm(stub);

    expect((await stub.proposal(chat))?.status).toBe("applied");
    expect((await stub.proposal(gone))?.status).toBe("void");
  });

  it("waits for the next alarm when its target can't be read", async () => {
    const stub = await withAgents("proposals-abandoned-unread");
    await stub.add("ab-unread", "Unread", owner);
    const id = await abandoned(stub, "ab-unread");

    await runInDurableObject(stub, async (instance) => {
      const real = (instance as unknown as { env: Env }).env;
      const failing = {
        ...real,
        AGENT_HOST: { getByName: () => ({ config: () => Promise.reject(new Error("down")) }) },
      };
      Object.defineProperty(instance, "env", {
        value: failing,
        configurable: true,
        writable: true,
      });
      try {
        await instance.alarm();
      } finally {
        Object.defineProperty(instance, "env", { value: real, configurable: true, writable: true });
      }
    });

    const row = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec("SELECT status, claimed_at FROM proposals WHERE id = ?", id).one(),
    );
    expect(row.status).toBe("applying");
    // Five minutes later before its expiry, not an hour.
    expect(Number(row.claimed_at)).toBeGreaterThan(Date.now() - 60_000);
    expect(Number(row.claimed_at)).toBeLessThan(Date.now() + 60_000);
  });

  it("doesn't release an approval that finished during its read", async () => {
    const stub = await withAgents("proposals-abandoned-raced");
    await stub.add("ab-raced", "Raced", owner);
    const id = await abandoned(stub, "ab-raced");

    await runInDurableObject(stub, async (instance) => {
      const real = (instance as unknown as { env: Env }).env;
      // The page's own approval finishes while the alarm reads the target, which doesn't hold it.
      const racing = {
        ...real,
        AGENT_HOST: {
          getByName: () => ({
            config: async () => {
              await instance.finishProposal(id, "applied", page);
              return { settings: { spawn: false }, promptVersion: 0 };
            },
          }),
        },
      };
      Object.defineProperty(instance, "env", { value: racing, configurable: true, writable: true });
      try {
        await instance.alarm();
      } finally {
        Object.defineProperty(instance, "env", { value: real, configurable: true, writable: true });
      }
    });

    expect(await stub.proposal(id)).toMatchObject({ status: "applied" });
    expect((await eventsOf(stub)).map((event) => (event as { kind: string }).kind)).not.toContain(
      "released",
    );
  });

  it("keeps an unreadable approval being applied past its expiry, tried hourly, out of the caps", async () => {
    const stub = await withAgents("proposals-abandoned-unread-due");
    await stub.add("ab-unread-due", "Unread", owner);
    const id = await abandoned(stub, "ab-unread-due");
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        "UPDATE proposals SET expires_at = ? WHERE id = ?",
        Date.now() - 1,
        id,
      );
      const real = (instance as unknown as { env: Env }).env;
      const failing = {
        ...real,
        AGENT_HOST: { getByName: () => ({ config: () => Promise.reject(new Error("down")) }) },
      };
      Object.defineProperty(instance, "env", {
        value: failing,
        configurable: true,
        writable: true,
      });
      try {
        await instance.alarm();
      } finally {
        Object.defineProperty(instance, "env", { value: real, configurable: true, writable: true });
      }
    });

    // Unread isn't unapplied: nothing claims it didn't apply.
    const row = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec("SELECT status, claimed_at FROM proposals WHERE id = ?", id).one(),
    );
    expect(row.status).toBe("applying");
    expect(Number(row.claimed_at)).toBeGreaterThan(Date.now() + 50 * 60_000);
    const alarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    expect(alarm).toBe(Number(row.claimed_at) + 5 * 60_000);
    // It holds no cap any more: its proposer may propose about that agent again.
    expect(await stub.propose(proposal({ target: "ab-unread-due" }), byMaster)).toMatchObject({
      ok: true,
    });
  });

  it("puts one that didn't apply back to pending, and expires it when it is due", async () => {
    const stub = await withAgents("proposals-abandoned-due");
    await stub.add("ab-due", "Due", owner);
    const id = await abandoned(stub, "ab-due");
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE proposals SET expires_at = ? WHERE id = ?",
        Date.now() - 1,
        id,
      );
    });

    await runDurableObjectAlarm(stub);

    const status = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec("SELECT status FROM proposals WHERE id = ?", id).one(),
    );
    expect(status).toEqual({ status: "expired" });
    expect((await eventsOf(stub)).map((event) => (event as { kind: string }).kind)).toEqual([
      "proposed",
      "claimed",
      "released",
      "expired",
    ]);
    // And telling its proposer is tried in that same alarm; it fails here, with no conversation.
    const told = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec("SELECT tell_attempts, next_tell_at FROM proposals WHERE id = ?", id)
        .one(),
    );
    expect(told.tell_attempts).toBe(1);
    expect(told.next_tell_at).not.toBeNull();
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
