import type { AgentEntry, AgentSettings } from "@kelpie/config";
import type { ModelDescription } from "@kelpie/llm/models";
import { describe, expect, it } from "vitest";
import { SUBAGENT_TOOLS } from "../src/subagent-limits.ts";
import { type SubagentPorts, subagentTools } from "../src/subagent-tools.ts";
import type { Tool, ToolContext } from "../src/tools.ts";

// Temporary subagents (ADR-0036 §5, #290): an agent with spawn creates them, never above itself,
// with only a subagent's tools, at most three live, and deletes only its own.

function world({
  spawn = true,
  described = { provider: "anthropic", tier: "medium", effort: "high", route: [] },
  live = [] as AgentEntry[],
  failConfigure = false,
}: {
  spawn?: boolean;
  described?: ModelDescription;
  live?: AgentEntry[];
  failConfigure?: boolean;
} = {}) {
  const calls: string[] = [];
  const configured: Partial<AgentSettings>[] = [];
  const ports: SubagentPorts = {
    async canSpawn() {
      return spawn;
    },
    async ceiling() {
      return { model: { memory: { tier: "cheap" } }, described };
    },
    async add(id, name, creator) {
      calls.push(`add ${name} by ${creator}`);
      if (live.length >= 3) return { ok: false, reason: "not_allowed" };
      return id.startsWith(`${creator}-sub-`) ? { ok: true } : { ok: false, reason: "invalid_input" };
    },
    async configure(_id, settings) {
      configured.push(settings);
      return failConfigure
        ? { ok: false, reason: "invalid_input" }
        : { ok: true, value: { settings: settings as AgentSettings, promptVersion: 1 } };
    },
    async owned() {
      return live;
    },
    async remove(_actor, id) {
      calls.push(`remove ${id}`);
      return { ok: true, value: { deleted: [id], webhooksLeft: [], everyThread: false } };
    },
  };
  return { provider: subagentTools(ports), calls, configured };
}

const context = (fields: Partial<ToolContext> = {}): ToolContext => ({
  locale: "en",
  actor: { userId: "u-owner", role: "owner", via: "agent:kelpie" },
  agentId: "kelpie",
  scopes: "all",
  qualifier: "clef",
  turn: "1",
  source: "telegram:1, 2026-10-15",
  signal: new AbortController().signal,
  confirm: async () => false,
  sendLink: () => undefined,
  ...fields,
});

async function tool(provider: ReturnType<typeof world>["provider"], name: string): Promise<Tool> {
  const found = (await provider.tools("kelpie")).find((one) => one.spec.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

const brief = { name: "Scout", soul: "You find flights.", remit: "Flights to Lisbon." };

describe("the subagent tools (#290)", () => {
  it("are given only to an agent with spawn", async () => {
    expect(await world({ spawn: false }).provider.tools("kelpie")).toEqual([]);
    expect((await world().provider.tools("kelpie")).map((one) => one.spec.name)).toEqual([
      "create_subagent",
      "delete_subagent",
    ]);
  });

  it("create a subagent on its creator's route and limits, with only a subagent's tools", async () => {
    const { provider, calls, configured } = world();
    const created = await (await tool(provider, "create_subagent")).run(
      { ...brief, skills: [{ name: "Fares", instructions: "Compare three." }], tier: "cheap" },
      context(),
    );
    expect(created.output).toMatch(/^Created the subagent kelpie-sub-[0-9a-f]{6}, named "Scout"\./);
    expect(calls).toEqual(["add Scout by kelpie"]);
    expect(configured).toEqual([
      {
        systemPrompt: "You find flights.",
        remit: "Flights to Lisbon.",
        skills: [{ name: "Fares", instructions: "Compare three." }],
        tools: [...SUBAGENT_TOOLS],
        model: {
          provider: "anthropic",
          memory: { tier: "cheap" },
          conversation: { tier: "cheap", effort: "high" },
        },
        maxConcurrentTasks: 1,
      },
    ]);
  });

  it("never let a subagent above its creator, or give it tools a subagent can't have", async () => {
    const { provider, calls } = world();
    const create = await tool(provider, "create_subagent");
    for (const [input, says] of [
      [{ ...brief, tier: "frontier" }, "Its tier can't be above yours, medium."],
      [{ ...brief, effort: "max" }, "Its effort can't be above yours, high."],
      [{ ...brief, tools: ["memory_write"] }, "A subagent's tools are only these"],
      [{ ...brief, tools: ["create_task"] }, "A subagent's tools are only these"],
      [{ ...brief, name: "" }, "Give it a name"],
      [{ ...brief, remit: "Two\nlines" }, "That subagent isn't valid"],
    ] as const) {
      const refused = await create.run(input, context());
      expect(refused, JSON.stringify(input)).toMatchObject({ isError: true });
      expect(refused.output).toContain(says);
    }
    expect(calls).toEqual([]);
    // A creator with no effort set can't give one.
    const plain = world({ described: { provider: null, tier: "cheap", route: [] } });
    expect(
      await (await tool(plain.provider, "create_subagent")).run(
        { ...brief, effort: "low" },
        context(),
      ),
    ).toMatchObject({ isError: true, output: expect.stringContaining("no effort set") });
  });

  it("refuses a fourth live subagent, a turn that isn't the owner's, and undoes a half-made one", async () => {
    const live = ["a", "b", "c"].map((id) => ({
      id: `kelpie-sub-${id}`,
      name: id,
      role: "subagent" as const,
      owner: "kelpie",
      chat: false,
    }));
    const full = world({ live });
    expect(
      await (await tool(full.provider, "create_subagent")).run(brief, context()),
    ).toMatchObject({
      isError: true,
      output: expect.stringContaining("three live subagents"),
    });
    const member = context({ actor: { userId: "u-x", role: "member", via: "x" } });
    expect(
      await (await tool(world().provider, "create_subagent")).run(brief, member),
    ).toMatchObject({
      isError: true,
    });
    const broken = world({ failConfigure: true });
    expect(
      await (await tool(broken.provider, "create_subagent")).run(brief, context()),
    ).toMatchObject({
      isError: true,
    });
    expect(broken.calls.at(-1)).toMatch(/^remove kelpie-sub-/);
  });

  it("delete only the creator's own subagents", async () => {
    const live: AgentEntry[] = [
      { id: "kelpie-sub-aaaaaa", name: "Scout", role: "subagent", owner: "kelpie", chat: false },
      { id: "sales", name: "Sales", role: "specialist", owner: "kelpie", chat: true },
    ];
    const { provider, calls } = world({ live });
    const remove = await tool(provider, "delete_subagent");
    expect(await remove.run({ id: "kelpie-sub-aaaaaa" }, context())).toEqual({
      output: "Deleted the subagent kelpie-sub-aaaaaa. Its results stay on your tasks.",
    });
    for (const id of ["sales", "someone-else", 7]) {
      expect(await remove.run({ id }, context()), String(id)).toMatchObject({ isError: true });
    }
    expect(calls).toEqual(["remove kelpie-sub-aaaaaa"]);
  });
});
