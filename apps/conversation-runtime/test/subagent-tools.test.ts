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
  failBind = false,
  failAdd = false,
  failRemove = false,
  creatorTools = null as string[] | null,
}: {
  spawn?: boolean;
  described?: ModelDescription;
  live?: AgentEntry[];
  failConfigure?: boolean;
  failBind?: boolean;
  failAdd?: boolean;
  failRemove?: boolean;
  creatorTools?: string[] | null;
} = {}) {
  const calls: string[] = [];
  const configured: Partial<AgentSettings>[] = [];
  const ports: SubagentPorts = {
    async canSpawn() {
      return spawn;
    },
    async creator() {
      return { model: { memory: { tier: "cheap" } }, described, tools: creatorTools };
    },
    async bindCreator(id, creator) {
      calls.push(`bind ${id.startsWith(`${creator}-sub-`) ? "sub" : id} to ${creator}`);
      return { ok: !failBind };
    },
    async add(id, name, creator) {
      calls.push(`add ${name} by ${creator}`);
      if (live.length >= 3 || failAdd) return { ok: false, reason: "not_allowed" };
      return id.startsWith(`${creator}-sub-`)
        ? { ok: true }
        : { ok: false, reason: "invalid_input" };
    },
    async discard(id) {
      calls.push(`discard ${id.startsWith("kelpie-sub-") ? "sub" : id}`);
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
      if (failRemove) return { ok: false, reason: "unavailable" };
      return { ok: true, value: { deleted: [id], webhooksLeft: [], everyThread: false } };
    },
  };
  return { provider: subagentTools(ports), calls, configured };
}

/** What the tools had Kelpie announce, as `kind id name` (#342). */
const announced: string[] = [];

const context = (fields: Partial<ToolContext> = {}): ToolContext => ({
  locale: "en",
  actor: { userId: "u-owner", role: "owner", via: "agent:kelpie" },
  agentId: "kelpie",
  scopes: "all",
  trigger: "person",
  qualifier: "clef",
  turn: "1",
  source: "telegram:1, 2026-10-15",
  signal: new AbortController().signal,
  confirm: async () => false,
  sendLink: () => undefined,
  announce: (one) => {
    announced.push(
      `${one.kind} ${one.agentId.startsWith("kelpie-sub-") && one.kind === "created" ? "sub" : one.agentId} ${one.name}`,
    );
  },
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
    announced.length = 0;
    const created = await (await tool(provider, "create_subagent")).run(
      { ...brief, skills: [{ name: "Fares", instructions: "Compare three." }], tier: "cheap" },
      context(),
    );
    expect(created.output).toMatch(/^Created the subagent kelpie-sub-[0-9a-f]{6}, named "Scout"\./);
    // Pinned first, so the Registry never lists it without its limits (#344).
    expect(calls).toEqual(["bind sub to kelpie", "add Scout by kelpie"]);
    // Kelpie, not the model, tells the owner it exists (#342).
    expect(announced).toEqual(["created sub Scout"]);
    expect(configured).toEqual([
      {
        systemPrompt: "You find flights.",
        remit: "Flights to Lisbon.",
        skills: [{ name: "Fares", instructions: "Compare three." }],
        tools: [...SUBAGENT_TOOLS],
        model: {
          provider: "anthropic",
          memory: { tier: "cheap" },
          conversation: { tier: "cheap", effort: "low" },
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
      [{ ...brief, tools: ["memory_write"] }, "A subagent's tools can only be these"],
      [{ ...brief, tools: ["create_task"] }, "A subagent's tools can only be these"],
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
    announced.length = 0;
    const full = world({ live });
    expect(
      await (await tool(full.provider, "create_subagent")).run(brief, context()),
    ).toMatchObject({
      isError: true,
      // Named, so a creator that lost their ids can still delete one (#344).
      output: expect.stringContaining(
        "three live subagents, kelpie-sub-a, kelpie-sub-b, kelpie-sub-c",
      ),
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
    // One that can't be pinned is never added.
    const unpinned = world({ failBind: true });
    expect(
      await (await tool(unpinned.provider, "create_subagent")).run(brief, context()),
    ).toMatchObject({ isError: true });
    expect(unpinned.calls).toEqual(["bind sub to kelpie"]);
    // One the Registry refuses leaves no pinned object behind (#344).
    const unlisted = world({ failAdd: true });
    expect(
      await (await tool(unlisted.provider, "create_subagent")).run(brief, context()),
    ).toMatchObject({ isError: true, output: expect.stringContaining("most subagents a day") });
    expect(unlisted.calls).toEqual(["bind sub to kelpie", "add Scout by kelpie", "discard sub"]);
    // None of these exists, so Kelpie announces none (#342).
    expect(announced).toEqual([]);
    // One whose undo failed is still listed: Kelpie announces it, as it would any other.
    const stuck = world({ failConfigure: true, failRemove: true });
    expect(
      await (await tool(stuck.provider, "create_subagent")).run(brief, context()),
    ).toMatchObject({ isError: true, output: expect.stringContaining("half-made subagent") });
    expect(announced).toEqual(["created sub Scout"]);
  });

  it("delete only the creator's own subagents", async () => {
    const live: AgentEntry[] = [
      { id: "kelpie-sub-aaaaaa", name: "Scout", role: "subagent", owner: "kelpie", chat: false },
      { id: "sales", name: "Sales", role: "specialist", owner: "kelpie", chat: true },
    ];
    const { provider, calls } = world({ live });
    announced.length = 0;
    const remove = await tool(provider, "delete_subagent");
    expect(await remove.run({ id: "kelpie-sub-aaaaaa" }, context())).toEqual({
      output:
        "Deleted the subagent kelpie-sub-aaaaaa. What it reported reached you already; a task it hadn't finished went with it.",
    });
    for (const id of ["sales", "someone-else", 7]) {
      expect(await remove.run({ id }, context()), String(id)).toMatchObject({ isError: true });
    }
    expect(calls).toEqual(["remove kelpie-sub-aaaaaa"]);
    // Only the deletion that happened is announced (#342).
    expect(announced).toEqual(["deleted kelpie-sub-aaaaaa Scout"]);
    // One that didn't finish isn't.
    const unfinished = world({ live, failRemove: true });
    expect(
      await (await tool(unfinished.provider, "delete_subagent")).run(
        { id: "kelpie-sub-aaaaaa" },
        context(),
      ),
    ).toMatchObject({ isError: true });
    expect(announced).toEqual(["deleted kelpie-sub-aaaaaa Scout"]);
  });

  it("default a subagent to the cheapest tier and a low effort, and cap its brief", async () => {
    const { provider, configured } = world();
    const create = await tool(provider, "create_subagent");
    await create.run({ ...brief, skills: null, tier: null, effort: null, tools: null }, context());
    expect(configured[0]?.model).toEqual({
      provider: "anthropic",
      memory: { tier: "cheap" },
      conversation: { tier: "cheap", effort: "low" },
    });
    expect(
      await create.run(
        {
          ...brief,
          soul: "a".repeat(20_000),
          skills: [{ name: "x", instructions: "b".repeat(4_000) }],
        },
        context(),
      ),
    ).toMatchObject({ isError: true, output: expect.stringContaining("at most 24000 characters") });
  });

  it("keep a subagent's tools within its creator's allowlist", async () => {
    const { provider, configured } = world({ creatorTools: ["create_subagent", "complete_task"] });
    const create = await tool(provider, "create_subagent");
    expect(await create.run({ ...brief, tools: ["memory_search"] }, context())).toMatchObject({
      isError: true,
      output: expect.stringContaining("can only be these: complete_task"),
    });
    await create.run(brief, context());
    expect(configured.at(-1)?.tools).toEqual(["complete_task"]);
  });

  it("refuse a subagent that could never finish a task (#344)", async () => {
    // A creator that may not use complete_task makes none.
    const without = world({ creatorTools: ["create_subagent", "memory_search"] });
    expect(
      await (await tool(without.provider, "create_subagent")).run(brief, context()),
    ).toMatchObject({
      isError: true,
      output: expect.stringContaining("could never finish a task"),
    });
    expect(without.calls).toEqual([]);
    // Nor does a model that leaves it out of the subagent's tools.
    const { provider, calls } = world();
    expect(
      await (await tool(provider, "create_subagent")).run(
        { ...brief, tools: ["memory_search"] },
        context(),
      ),
    ).toMatchObject({
      isError: true,
      output: expect.stringContaining("must include complete_task"),
    });
    expect(calls).toEqual([]);
  });

  it("work in a task's run and after Kelpie's note as in the owner's message, within their limits (#345)", async () => {
    const live: AgentEntry[] = [
      { id: "kelpie-sub-aaaaaa", name: "Scout", role: "subagent", owner: "kelpie", chat: false },
    ];
    const { provider, calls } = world({ live });
    for (const trigger of ["task", "note"] as const) {
      expect(
        await (await tool(provider, "create_subagent")).run(brief, context({ trigger })),
        trigger,
      ).not.toHaveProperty("isError");
    }
    expect(
      await (await tool(provider, "delete_subagent")).run(
        { id: "kelpie-sub-aaaaaa" },
        context({ trigger: "note" }),
      ),
    ).not.toHaveProperty("isError");
    expect(calls.filter((call) => !call.startsWith("bind"))).toEqual([
      "add Scout by kelpie",
      "add Scout by kelpie",
      "remove kelpie-sub-aaaaaa",
    ]);
  });

  it("are refused to a turn that doesn't read all the owner's memory", async () => {
    const { provider, calls } = world();
    const narrow = context({ scopes: ["conversation/telegram-group"] });
    expect(await (await tool(provider, "create_subagent")).run(brief, narrow)).toMatchObject({
      isError: true,
      output: expect.stringContaining("direct conversation"),
    });
    const member = context({ actor: { userId: "u-x", role: "member", via: "x" } });
    expect(
      await (await tool(provider, "delete_subagent")).run({ id: "kelpie-sub-aaaaaa" }, member),
    ).toMatchObject({ isError: true });
    // Nor deleted from one (#344).
    expect(
      await (await tool(provider, "delete_subagent")).run({ id: "kelpie-sub-aaaaaa" }, narrow),
    ).toMatchObject({ isError: true, output: expect.stringContaining("direct conversation") });
    expect(calls).toEqual([]);
  });
});
