import type { AgentEntry, AgentRole, CommandResult, Proposal } from "@kelpie/config";
import type { ModelDescription } from "@kelpie/llm/models";
import { describe, expect, it } from "vitest";
import { type ProposalToolPorts, proposalTools } from "../src/proposal-tools.ts";
import type { Tool, ToolContext } from "../src/tools.ts";

// The proposal tool (ADR-0061, #302): an owner agent asks for a change to an agent it owns, where it
// has no configure_agent, within what it holds itself. It applies nothing.

const ID = "1a2b3c4d-1111-4222-8333-444455556666";
const TASK = "0f8b7c1e-6a2d-4c3b-9e5f-1a2b3c4d5e6f";

const sub: AgentEntry = {
  id: "sales-sub-a1b2c3",
  name: "Quotes",
  role: "subagent",
  owner: "sales",
  chat: false,
};
const books: AgentEntry = {
  id: "books",
  name: "Books",
  role: "specialist",
  owner: "kelpie",
  chat: false,
};

function world({
  roles = { kelpie: "master", sales: "specialist", "sales-sub-a1b2c3": "subagent" } as Record<
    string,
    AgentRole
  >,
  owned = { kelpie: [books], sales: [sub] } as Record<string, AgentEntry[]>,
  described = { provider: "anthropic", tier: "medium", effort: "high", route: [] } as
    | ModelDescription
    | undefined,
  tools = null as string[] | null,
  answer = undefined as CommandResult<{ proposal: Proposal; noticed: boolean }> | undefined,
} = {}) {
  const proposed: { via: string; input: unknown }[] = [];
  const ports: ProposalToolPorts = {
    roleOf: async (id) => roles[id] ?? null,
    owned: async (id) => owned[id] ?? [],
    holds: async () => ({
      described: described as ModelDescription,
      tools,
    }),
    async propose(actor, input) {
      proposed.push({ via: actor.via, input });
      return (
        answer ?? {
          ok: true,
          value: {
            proposal: { id: ID } as Proposal,
            noticed: true,
          },
        }
      );
    },
  };
  return { provider: proposalTools(ports), proposed };
}

const context = (fields: Partial<ToolContext> = {}): ToolContext => ({
  locale: "en",
  actor: { userId: "u-owner", role: "owner", via: "agent:sales" },
  agentId: "sales",
  scopes: "all",
  trigger: "person",
  qualifier: "clef",
  turn: "1",
  source: "webchat:u-owner, 2026-10-18",
  signal: new AbortController().signal,
  confirm: async () => false,
  sendLink: () => undefined,
  announce: () => undefined,
  ...fields,
});

const inTask = {
  task: { id: TASK, finish: async () => true, comment: async () => true },
} as const;

async function propose(
  provider: ReturnType<typeof world>["provider"],
  agentId: string,
  place?: { channel: "task" },
): Promise<Tool> {
  const [found] = await provider.tools(agentId, place);
  if (!found) throw new Error("no tool");
  return found;
}

describe("where the proposal tool is offered (#302)", () => {
  it("is a specialist's that owns a subagent, in any turn, and Master's only in a task's run", async () => {
    const { provider } = world();
    const names = async (agentId: string, place?: { channel: "task" }) =>
      (await provider.tools(agentId, place)).map((one) => one.spec.name);

    expect(await names("sales")).toEqual(["propose_agent_change"]);
    expect(await names("sales", { channel: "task" })).toEqual(["propose_agent_change"]);
    // In its conversations Master has configure_agent, with the owner's confirmation.
    expect(await names("kelpie")).toEqual([]);
    expect(await names("kelpie", { channel: "task" })).toEqual(["propose_agent_change"]);
    // A subagent owns nothing, and an agent that owns nothing has nothing to propose about.
    expect(await names("sales-sub-a1b2c3")).toEqual([]);
    expect(await world({ owned: {} }).provider.tools("sales")).toEqual([]);
  });
});

describe("the proposal tool (#302)", () => {
  it("proposes a subagent's change within its creator's, and never holds the link", async () => {
    const { provider, proposed } = world();
    const tool = await propose(provider, "sales");

    const result = await tool.run(
      {
        agentId: "sales-sub-a1b2c3",
        changes: { model: { conversation: { tier: "medium" } }, tools: ["complete_task"] },
        reason: "Long quotes need it.",
      },
      context(),
    );

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain(`proposal ${ID}`);
    expect(result.output).toContain("Nothing changes unless the owner approves it");
    expect(result.output).not.toContain("http");
    expect(proposed).toEqual([
      {
        via: "agent:sales",
        input: {
          agentId: "sales-sub-a1b2c3",
          changes: { model: { conversation: { tier: "medium" } }, tools: ["complete_task"] },
          reason: "Long quotes need it.",
          taskId: null,
        },
      },
    ]);
  });

  it("in a task's run, names the task and says to wait on it", async () => {
    const { provider, proposed } = world();
    const tool = await propose(provider, "kelpie", { channel: "task" });

    const result = await tool.run(
      { agentId: "books", changes: { spawn: true }, reason: "It needs helpers." },
      context({ agentId: "kelpie", actor: { ...context().actor, via: "agent:kelpie" }, ...inTask }),
    );

    expect(result.output).toContain("wait_on_task with reason dependency");
    expect(proposed[0]?.input).toMatchObject({ taskId: TASK });
  });

  it("never lets a subagent's change exceed its creator, nor names its route", async () => {
    const { provider, proposed } = world({ tools: ["memory_search", "complete_task"] });
    const tool = await propose(provider, "sales");
    const run = (changes: object) =>
      tool.run({ agentId: "sales-sub-a1b2c3", changes, reason: "Why." }, context());

    for (const [changes, refusal] of [
      [{ model: { conversation: { tier: "frontier" } } }, "Its tier can't be above yours, medium."],
      [{ model: { conversation: { effort: "max" } } }, "Its effort can't be above yours, high."],
      [{ tools: ["memory_read", "complete_task"] }, "A subagent's tools can only be these"],
      [{ tools: ["memory_search"] }, "must include complete_task"],
      [{ tools: null }, "A subagent's tools are a list"],
      [{ model: { provider: "openai" } }, "runs on its creator's route"],
      [{ model: { memory: { tier: "cheap" } } }, "runs on its creator's route"],
      [
        {
          systemPrompt: "x".repeat(20_000),
          skills: [{ name: "a", instructions: "y".repeat(4_000) }],
        },
        "at most 24000 characters",
      ],
      [{ chat: true }, "can't change for the agent sales-sub-a1b2c3"],
    ] as const) {
      const result = await run(changes);
      expect(result.isError, JSON.stringify(changes)).toBe(true);
      expect(result.output, JSON.stringify(changes)).toContain(refusal);
    }
    expect(proposed).toEqual([]);
  });

  it("keeps a specialist's proposed tools within what Master holds", async () => {
    const { provider, proposed } = world({ tools: ["memory_search"] });
    const tool = await propose(provider, "kelpie", { channel: "task" });
    const ctx = context({ agentId: "kelpie", ...inTask });

    const beyond = await tool.run(
      { agentId: "books", changes: { tools: ["memory_write"] }, reason: "Why." },
      ctx,
    );
    expect(beyond).toEqual({
      output: "A tool you don't hold can't be proposed for another agent: memory_write.",
      isError: true,
    });
    const all = await tool.run({ agentId: "books", changes: { tools: null }, reason: "Why." }, ctx);
    expect(all.output).toContain("every tool");
    expect(
      (
        await tool.run(
          { agentId: "books", changes: { tools: ["memory_search"] }, reason: "Why." },
          ctx,
        )
      ).isError,
    ).toBeUndefined();
    expect(proposed).toHaveLength(1);
  });

  it("is only the owner's own turn, about an agent it owns, while it still may", async () => {
    const { provider, proposed } = world();
    const tool = await propose(provider, "sales");
    const change = { agentId: "sales-sub-a1b2c3", changes: { remit: "Quotes." }, reason: "Why." };

    expect((await tool.run(change, context({ scopes: ["webchat:x"] }))).output).toContain(
      "Only turns for the owner",
    );
    expect(
      (await tool.run(change, context({ actor: { ...context().actor, role: "member" } }))).output,
    ).toContain("Only turns for the owner");
    expect((await tool.run({ ...change, agentId: "books" }, context())).output).toBe(
      "You don't own an agent books. You can propose changes only to the agents you own: sales-sub-a1b2c3.",
    );
    // Master in a conversation with the owner, as when the role moved during the turn.
    const master = await propose(world().provider, "kelpie", { channel: "task" });
    expect(
      (await master.run({ ...change, agentId: "books" }, context({ agentId: "kelpie" }))).output,
    ).toContain("configure_agent");
    expect(proposed).toEqual([]);
  });

  it("says what the command refused, in words the model can act on", async () => {
    for (const [reason, words] of [
      ["too_many", "too many proposals waiting"],
      ["invalid_input", "isn't valid for it, or is what it has already"],
      ["no_key", "doesn't serve"],
      ["not_allowed", "You don't own"],
      ["unavailable", "didn't answer"],
    ] as const) {
      const { provider } = world({ answer: { ok: false, reason } });
      const tool = await propose(provider, "sales");
      const result = await tool.run(
        { agentId: "sales-sub-a1b2c3", changes: { remit: "Quotes." }, reason: "Why." },
        context(),
      );
      expect(result.isError, reason).toBe(true);
      expect(result.output, reason).toContain(words);
    }
    const { provider } = world({
      answer: { ok: true, value: { proposal: { id: ID } as Proposal, noticed: false } },
    });
    const result = await (await propose(provider, "sales")).run(
      { agentId: "sales-sub-a1b2c3", changes: { remit: "Quotes." }, reason: "Why." },
      context(),
    );
    expect(result.output).toContain("proposals page");
  });
});
