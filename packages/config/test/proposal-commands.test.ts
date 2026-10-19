import { describe, expect, it } from "vitest";
import {
  type Actor,
  type AgentEntry,
  type ConfigPorts,
  createConfigCommands,
} from "../src/commands.ts";
import type { NewProposal, Proposal, ProposalNotice } from "../src/proposals.ts";
import { type AgentSettings, DEFAULT_SETTINGS } from "../src/settings.ts";

// The proposal commands (ADR-0061, #302). The Registry's own rules, its caps and expiry, are its
// tests'; here it is a plain store that records each step.

const TASK = "0f8b7c1e-6a2d-4c3b-9e5f-1a2b3c4d5e6f";
const PROPOSAL = "1a2b3c4d-1111-4222-8333-444455556666";
/** Master's turn in a task's run, acting for the owner. */
const master: Actor = { userId: "u-owner", role: "owner", via: "agent:kelpie" };
/** A specialist with `spawn`, in its own turn. */
const sales: Actor = { userId: "u-owner", role: "owner", via: "agent:sales" };
/** The owner on the proposal's page. */
const page: Actor = { userId: "u-owner", role: "owner", via: "admin-api" };

function fake() {
  const calls: string[] = [];
  const agents = new Map<string, AgentEntry>([
    ["kelpie", { id: "kelpie", name: "Kelpie", role: "master", owner: null, chat: true }],
    ["sales", { id: "sales", name: "Sales", role: "specialist", owner: "kelpie", chat: false }],
    [
      "sales-sub-a1b2c3",
      { id: "sales-sub-a1b2c3", name: "Quotes", role: "subagent", owner: "sales", chat: false },
    ],
  ]);
  const settings = new Map<string, AgentSettings>(
    [...agents.keys()].map((id) => [id, { ...DEFAULT_SETTINGS }]),
  );
  const subagent = settings.get("sales-sub-a1b2c3") as AgentSettings;
  subagent.model = { provider: "anthropic", conversation: { tier: "cheap", effort: "low" } };
  const proposals = new Map<string, Proposal>();
  const notices: { master: string; notice: ProposalNotice }[] = [];
  const state = { failApply: false, failFinish: false, notify: true as boolean | "throws" };
  const setStatus = (id: string, status: Proposal["status"], by: Actor) => {
    const proposal = proposals.get(id) as Proposal;
    const settled = status !== "pending" && status !== "applying";
    const next = {
      ...proposal,
      status,
      ...(settled ? { decidedAt: 5_000, decidedBy: by.userId } : {}),
    };
    proposals.set(id, next);
    return { ok: true as const, value: next };
  };
  const ports = {
    registry: {
      get: async (id: string) => agents.get(id) ?? null,
      list: async () => [...agents.values()],
      async setChat(id: string, chat: boolean, actor: Actor, expect?: boolean) {
        calls.push(`setChat ${id} ${chat} ${actor.via} expect=${expect}`);
        const agent = agents.get(id);
        if (!agent) return { ok: false, reason: "unknown_agent" };
        if (agent.chat !== chat && expect !== undefined && agent.chat !== expect) {
          return { ok: false, reason: "conflict" };
        }
        agent.chat = chat;
        return { ok: true };
      },
    },
    agents: {
      async config(id: string) {
        return { settings: settings.get(id) as AgentSettings, promptVersion: 0 };
      },
      async configure(
        id: string,
        changes: Partial<AgentSettings>,
        actor: Actor,
        expect?: Partial<AgentSettings>,
      ) {
        calls.push(`configure ${id} ${JSON.stringify(changes)} ${actor.via}`);
        if (state.failApply) throw new Error("unreachable");
        const current = settings.get(id) as AgentSettings;
        const stale = Object.entries(expect ?? {}).some(
          ([key, value]) =>
            JSON.stringify(current[key as keyof AgentSettings]) !== JSON.stringify(value),
        );
        if (stale) return { ok: false, reason: "conflict" };
        settings.set(id, { ...current, ...changes });
        return {
          ok: true,
          value: { settings: settings.get(id) as AgentSettings, promptVersion: 0 },
        };
      },
    },
    models: { providers: async () => ["anthropic"] },
    proposals: {
      async propose(proposal: NewProposal, actor: Actor) {
        calls.push(`propose ${proposal.proposer}->${proposal.target} ${actor.userId}`);
        const made: Proposal = {
          ...proposal,
          id: PROPOSAL,
          status: "pending",
          createdAt: 1_000,
          expiresAt: 1_000 + 72 * 3_600_000,
          decidedAt: null,
          decidedBy: null,
        };
        proposals.set(made.id, made);
        return { ok: true, value: made };
      },
      get: async (id: string) => proposals.get(id) ?? null,
      list: async (status?: string) =>
        [...proposals.values()].filter((one) => !status || one.status === status),
      async refuse(id: string, actor: Actor) {
        calls.push(`refuse ${id} ${actor.via}`);
        const proposal = proposals.get(id);
        if (!proposal) return { ok: false, reason: "unknown_proposal" };
        if (proposal.status !== "pending") return { ok: false, reason: "not_pending" };
        return setStatus(id, "refused", actor);
      },
      async claim(id: string, actor: Actor) {
        calls.push(`claim ${id} ${actor.via}`);
        const proposal = proposals.get(id);
        if (!proposal) return { ok: false, reason: "unknown_proposal" };
        if (proposal.status !== "pending") return { ok: false, reason: "not_pending" };
        return setStatus(id, "applying", actor);
      },
      async finish(id: string, outcome: string, actor: Actor) {
        calls.push(`finish ${id} ${outcome}`);
        if (state.failFinish && outcome !== "released") throw new Error("unreachable");
        return setStatus(id, outcome === "released" ? "pending" : (outcome as never), actor);
      },
      async notify(to: string, notice: ProposalNotice) {
        if (state.notify === "throws") throw new Error("unreachable");
        notices.push({ master: to, notice });
        return state.notify;
      },
    },
  };
  const commands = createConfigCommands(ports as unknown as ConfigPorts);
  return { commands, calls, agents, settings, proposals, notices, state };
}

describe("proposeAgentChange (#302)", () => {
  it("records a creator's change to its subagent, its trio merged in, and has Master's conversation told", async () => {
    const { commands, notices, calls } = fake();

    const result = await commands.proposeAgentChange(sales, {
      agentId: "sales-sub-a1b2c3",
      changes: { model: { conversation: { tier: "medium" } }, remit: "Prices quotes." },
      reason: "Long quotes need the medium tier.",
      taskId: TASK,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        noticed: true,
        proposal: {
          proposer: "sales",
          target: "sales-sub-a1b2c3",
          actingUserId: "u-owner",
          taskId: TASK,
          // The whole trio that applies, so the owner approves the result.
          changes: {
            model: { provider: "anthropic", conversation: { tier: "medium", effort: "low" } },
            remit: "Prices quotes.",
          },
          before: {
            model: { provider: "anthropic", conversation: { tier: "cheap", effort: "low" } },
            remit: "",
          },
          reason: "Long quotes need the medium tier.",
        },
      },
    });
    expect(calls).toEqual(["propose sales->sales-sub-a1b2c3 u-owner"]);
    // Ids and fields only: the reason is the page's to show.
    expect(notices).toEqual([
      {
        master: "kelpie",
        notice: {
          id: PROPOSAL,
          proposer: "sales",
          target: "sales-sub-a1b2c3",
          actingUserId: "u-owner",
          reason: "Long quotes need the medium tier.",
          expiresAt: 1_000 + 72 * 3_600_000,
          fields: ["model", "remit"],
        },
      },
    ]);
  });

  it("snapshots a specialist's chat from the Registry, and says when no notice went", async () => {
    const { commands, state } = fake();
    state.notify = false;

    const result = await commands.proposeAgentChange(master, {
      agentId: "sales",
      changes: { chat: true },
      reason: "The owner asked to talk to it.",
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        noticed: false,
        proposal: { changes: { chat: true }, before: { chat: false }, taskId: null },
      },
    });
    state.notify = "throws";
    const again = await commands.proposeAgentChange(master, {
      agentId: "sales",
      changes: { spawn: true },
      reason: "It needs helpers.",
    });
    expect(again).toMatchObject({ ok: true, value: { noticed: false } });
  });

  it("is only the owner's turn through an agent, about an agent it owns", async () => {
    const { commands, proposals } = fake();
    const change = { agentId: "sales", changes: { spawn: true }, reason: "Helpers." };

    expect(await commands.proposeAgentChange(page, change)).toEqual({
      ok: false,
      reason: "forbidden",
    });
    expect(await commands.proposeAgentChange({ ...master, role: "member" }, change)).toEqual({
      ok: false,
      reason: "forbidden",
    });
    // sales doesn't own itself, nor Master; nobody owns an agent that isn't listed.
    expect(await commands.proposeAgentChange(sales, change)).toEqual({
      ok: false,
      reason: "not_allowed",
    });
    expect(await commands.proposeAgentChange(sales, { ...change, agentId: "kelpie" })).toEqual({
      ok: false,
      reason: "not_allowed",
    });
    expect(await commands.proposeAgentChange(master, { ...change, agentId: "gone" })).toEqual({
      ok: false,
      reason: "unknown_agent",
    });
    expect(proposals.size).toBe(0);
  });

  it("refuses a change the target doesn't take, one that changes nothing, a bad reason or a keyless provider", async () => {
    const { commands, proposals } = fake();
    const invalid = { ok: false, reason: "invalid_input" };
    for (const input of [
      { agentId: "sales", changes: { systemPrompt: "Be terse." }, reason: "Tone." },
      { agentId: "sales", changes: { chat: true, spawn: true }, reason: "Both." },
      { agentId: "sales", changes: { spawn: false }, reason: "Already off." },
      { agentId: "sales", changes: { spawn: true }, reason: "" },
      { agentId: "sales", changes: { spawn: true }, reason: "a".repeat(501) },
      { agentId: "sales", changes: { spawn: true }, reason: "Ok.", taskId: "7" },
      { agentId: "sales", changes: { spawn: true }, reason: "Ok.", extra: 1 },
      {
        agentId: "sales",
        changes: { model: { memory: { provider: "claude-code" } } },
        reason: "x",
      },
      null,
    ]) {
      expect(await commands.proposeAgentChange(master, input), JSON.stringify(input)).toEqual(
        invalid,
      );
    }
    expect(
      await commands.proposeAgentChange(master, {
        agentId: "sales",
        changes: { model: { provider: "openai" } },
        reason: "Cheaper.",
      }),
    ).toEqual({ ok: false, reason: "no_key" });
    expect(proposals.size).toBe(0);
  });
});

describe("the owner's decision (#302)", () => {
  async function proposed(changes: object, by = master, agentId = "sales") {
    const made = fake();
    const result = await made.commands.proposeAgentChange(by, { agentId, changes, reason: "Why." });
    if (!result.ok) throw new Error(result.reason);
    made.calls.length = 0;
    return made;
  }

  it("applies an approved change with the stale check, as the proposal, and finishes it", async () => {
    const { commands, calls, settings } = await proposed({ spawn: true, remit: "Sales." });

    const result = await commands.decideProposal(page, { id: PROPOSAL, decision: "approve" });

    expect(result).toMatchObject({ ok: true, value: { status: "applied", decidedBy: "u-owner" } });
    expect(calls).toEqual([
      `claim ${PROPOSAL} admin-api`,
      `configure sales {"spawn":true,"remit":"Sales."} proposal:${PROPOSAL}`,
      `finish ${PROPOSAL} applied`,
    ]);
    expect(settings.get("sales")).toMatchObject({ spawn: true, remit: "Sales." });
  });

  it("applies a chat change through the Registry, and marks a target that changed as a conflict", async () => {
    const chat = await proposed({ chat: true });
    expect(
      await chat.commands.decideProposal(page, { id: PROPOSAL, decision: "approve" }),
    ).toMatchObject({ ok: true, value: { status: "applied" } });
    expect(chat.calls).toContain(`setChat sales true proposal:${PROPOSAL} expect=false`);

    const stale = await proposed({ remit: "Sales." });
    (stale.settings.get("sales") as AgentSettings).remit = "Changed by the owner.";
    expect(
      await stale.commands.decideProposal(page, { id: PROPOSAL, decision: "approve" }),
    ).toMatchObject({ ok: true, value: { status: "conflict" } });
    expect(stale.settings.get("sales")?.remit).toBe("Changed by the owner.");
  });

  it("voids a proposal whose target went, and leaves an approval whose change didn't answer to the Registry", async () => {
    const gone = await proposed({ chat: true });
    gone.agents.delete("sales");
    expect(
      await gone.commands.decideProposal(page, { id: PROPOSAL, decision: "approve" }),
    ).toMatchObject({ ok: true, value: { status: "void" } });

    // It may have applied before its answer was lost: the Registry's alarm reads the target.
    const down = await proposed({ spawn: true });
    down.state.failApply = true;
    expect(
      await down.commands.decideProposal(page, { id: PROPOSAL, decision: "approve" }),
    ).toMatchObject({ ok: true, value: { status: "applying" } });
    expect(down.calls.filter((call) => call.startsWith("finish"))).toEqual([]);
    expect(down.proposals.get(PROPOSAL)?.status).toBe("applying");
  });

  it("answers the approval as taken when it can't be finished, and leaves it to the Registry", async () => {
    const { commands, state, settings, proposals } = await proposed({ remit: "Sales." });
    state.failFinish = true;

    expect(
      await commands.decideProposal(page, { id: PROPOSAL, decision: "approve" }),
    ).toMatchObject({
      ok: true,
      value: { status: "applying" },
    });
    // The change applied; the claim waits for the Registry's alarm to settle it.
    expect(settings.get("sales")?.remit).toBe("Sales.");
    expect(proposals.get(PROPOSAL)?.status).toBe("applying");
  });

  it("refuses in one step, and a repeat changes nothing", async () => {
    const { commands, calls } = await proposed({ spawn: true });

    expect(await commands.decideProposal(page, { id: PROPOSAL, decision: "refuse" })).toMatchObject(
      { ok: true, value: { status: "refused" } },
    );
    expect(await commands.decideProposal(page, { id: PROPOSAL, decision: "refuse" })).toEqual({
      ok: false,
      reason: "not_pending",
    });
    expect(await commands.decideProposal(page, { id: PROPOSAL, decision: "approve" })).toEqual({
      ok: false,
      reason: "not_pending",
    });
    expect(calls.filter((call) => call.startsWith("configure"))).toEqual([]);
  });

  it("is the owner's alone, for a proposal's id and a decision", async () => {
    const { commands } = await proposed({ spawn: true });

    expect(
      await commands.decideProposal(
        { ...page, role: "member" },
        { id: PROPOSAL, decision: "refuse" },
      ),
    ).toEqual({ ok: false, reason: "forbidden" });
    for (const input of [
      { id: PROPOSAL, decision: "maybe" },
      { id: "nope", decision: "refuse" },
      { id: PROPOSAL, decision: "refuse", extra: true },
      null,
    ]) {
      expect(await commands.decideProposal(page, input), JSON.stringify(input)).toEqual({
        ok: false,
        reason: "invalid_input",
      });
    }
  });
});

describe("reading proposals (#302)", () => {
  it("shows a proposal with its target's values now, and whether it changed since", async () => {
    const made = fake();
    await made.commands.proposeAgentChange(master, {
      agentId: "sales",
      changes: { remit: "Sales." },
      reason: "Why.",
    });

    expect(await made.commands.getProposal(page, { id: PROPOSAL })).toMatchObject({
      ok: true,
      value: { current: { remit: "" }, stale: false, status: "pending" },
    });
    (made.settings.get("sales") as AgentSettings).remit = "Edited.";
    expect(await made.commands.getProposal(page, { id: PROPOSAL })).toMatchObject({
      ok: true,
      value: { current: { remit: "Edited." }, stale: true },
    });
    // A target that left its proposer's hands, or is gone, can't take it either.
    (made.settings.get("sales") as AgentSettings).remit = "";
    (made.agents.get("sales") as AgentEntry).owner = "other";
    expect(await made.commands.getProposal(page, { id: PROPOSAL })).toMatchObject({
      ok: true,
      value: { stale: true },
    });
    made.agents.delete("sales");
    expect(await made.commands.getProposal(page, { id: PROPOSAL })).toMatchObject({
      ok: true,
      value: { current: null, stale: true },
    });
  });

  it("shows a chat proposal's chat now, and lists proposals, for the owner only", async () => {
    const made = fake();
    await made.commands.proposeAgentChange(master, {
      agentId: "sales",
      changes: { chat: true },
      reason: "Why.",
    });

    expect(await made.commands.getProposal(page, { id: PROPOSAL })).toMatchObject({
      ok: true,
      value: { current: { chat: false }, stale: false },
    });
    expect(await made.commands.listProposals(page, { status: "pending" })).toMatchObject({
      ok: true,
      value: [{ id: PROPOSAL }],
    });
    expect(await made.commands.listProposals(page, undefined)).toMatchObject({
      ok: true,
      value: [{ id: PROPOSAL }],
    });
    expect(
      await made.commands.getProposal(page, { id: "1a2b3c4d-1111-4222-8333-000000000000" }),
    ).toEqual({
      ok: false,
      reason: "unknown_proposal",
    });
    for (const [command, input] of [
      ["getProposal", { id: "nope" }],
      ["listProposals", { status: "maybe" }],
      ["listProposals", { status: "pending", extra: 1 }],
    ] as const) {
      expect(await made.commands[command](page, input), command).toEqual({
        ok: false,
        reason: "invalid_input",
      });
    }
    const member = { ...page, role: "member" } as const;
    expect(await made.commands.getProposal(member, { id: PROPOSAL })).toEqual({
      ok: false,
      reason: "forbidden",
    });
    expect(await made.commands.listProposals(member, undefined)).toEqual({
      ok: false,
      reason: "forbidden",
    });
  });
});
