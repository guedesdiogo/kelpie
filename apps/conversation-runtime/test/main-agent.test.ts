import type { Actor, AgentRole } from "@kelpie/config";
import { DEFAULT_SETTINGS } from "@kelpie/config";
import { describe, expect, it } from "vitest";
import { type MainAgentCommands, mainAgentTools } from "../src/main-agent.ts";
import type { ConfirmationRequest, Tool, ToolContext } from "../src/tools.ts";

const owner: Actor = { userId: "u-owner", role: "owner", via: "agent:kelpie" };
const ROLES: Record<string, AgentRole> = { kelpie: "main", setup: "admin", ana: "specialist" };
const ANA_MODEL = { memory: { tier: "medium" } } as const;

function fakeCommands() {
  const calls: string[] = [];
  const forbidden = { ok: false, reason: "forbidden" } as const;
  const commands: MainAgentCommands = {
    async getAgent(actor, input) {
      if (actor.role !== "owner") return forbidden;
      const { id } = input as { id: string };
      const role = ROLES[id];
      if (!role) return { ok: false, reason: "unknown_agent" };
      return {
        ok: true,
        value: {
          id,
          name: id.toUpperCase(),
          role,
          owner: null,
          chat: true,
          // Ana keeps a memory tier of her own, which a conversation change must leave alone.
          settings: id === "ana" ? { ...DEFAULT_SETTINGS, model: ANA_MODEL } : DEFAULT_SETTINGS,
          promptVersion: 0,
        },
      };
    },
    async configureAgent(actor, input) {
      calls.push(`configureAgent ${JSON.stringify(input)}`);
      if (actor.role !== "owner") return forbidden;
      const { settings } = input as { settings: { model: { provider?: string } } };
      if (settings.model.provider === "openai") return { ok: false, reason: "no_key" };
      return { ok: true, value: { settings: DEFAULT_SETTINGS, promptVersion: 0 } };
    },
  };
  return { commands, calls };
}

function contextOf(confirmed: boolean, actor: Actor = owner) {
  const asked: ConfirmationRequest[] = [];
  const context: ToolContext = {
    locale: "en",
    actor,
    agentId: "kelpie",
    scopes: "all",
    qualifier: "clef",
    turn: "1",
    source: "webchat:u-owner, 2026-10-14",
    signal: new AbortController().signal,
    async confirm(request) {
      asked.push(request);
      return confirmed;
    },
    sendLink() {},
  };
  return { context, asked };
}

async function setAgentModel(commands: MainAgentCommands, agentId = "kelpie") {
  const provider = mainAgentTools(commands, async (id) => ROLES[id] ?? null);
  const tools = await provider.tools(agentId);
  return tools.find((tool) => tool.spec.name === "set_agent_model") as Tool | undefined;
}

describe("the main agent's tools (#289)", () => {
  it("are the main agent's only", async () => {
    const { commands } = fakeCommands();
    expect(await setAgentModel(commands)).toBeDefined();
    for (const id of ["ana", "setup", "ghost"]) {
      expect(
        await mainAgentTools(commands, async (agent) => ROLES[agent] ?? null).tools(id),
      ).toEqual([]);
    }
  });

  it("changes only what the owner asked of another agent's trio, once they confirm, and only then", async () => {
    const { commands, calls } = fakeCommands();
    const tool = (await setAgentModel(commands)) as Tool;
    const model = { conversation: { tier: "frontier", effort: "high" } };
    const merged = {
      conversation: { tier: "frontier", effort: "high" },
      memory: { tier: "medium" },
    };

    const waiting = contextOf(false);
    expect((await tool.run({ id: "ana", model }, waiting.context)).output).toContain(
      "Not done yet",
    );
    // The owner sees what the agent had and what it gets; what wasn't asked stays.
    expect(waiting.asked).toEqual([
      {
        command: "configureAgent",
        input: { id: "ana", settings: { model: merged } },
        summary: `change the model of the agent "ANA" (ana) from ${JSON.stringify(ANA_MODEL)} to ${JSON.stringify(merged)}.`,
      },
    ]);
    expect(calls).toEqual([]);

    const confirmed = contextOf(true);
    expect(await tool.run({ id: "ana", model }, confirmed.context)).toEqual({
      output: "Changed the model of the agent ana.",
    });
    expect(calls).toEqual([
      `configureAgent ${JSON.stringify({ id: "ana", settings: { model: merged } })}`,
    ]);
  });

  it("checks it is still the main agent when it runs, not only when listed", async () => {
    const { commands, calls } = fakeCommands();
    let role: AgentRole = "main";
    const tools = await mainAgentTools(commands, async () => role).tools("kelpie");
    const tool = tools[0] as Tool;
    role = "specialist";
    const refused = await tool.run({ id: "ana", model: {} }, contextOf(true).context);
    expect(refused).toMatchObject({ isError: true });
    expect(refused.output).toContain("isn't the main agent");
    expect(calls).toEqual([]);
  });

  it("never changes its own trio, and refuses what it can't do before asking", async () => {
    const { commands, calls } = fakeCommands();
    const tool = (await setAgentModel(commands)) as Tool;
    const { context, asked } = contextOf(true);

    const own = await tool.run({ id: "kelpie", model: { memory: { tier: "cheap" } } }, context);
    expect(own).toMatchObject({ isError: true });
    expect(own.output).toContain("Only Admin changes your own model");
    expect(
      await tool.run({ id: "ana", model: { conversation: { tier: "huge" } } }, context),
    ).toMatchObject({
      isError: true,
    });
    expect(await tool.run({ id: "ghost", model: {} }, context)).toEqual({
      output: "There is no agent with the id ghost.",
      isError: true,
    });
    expect(asked).toEqual([]);
    expect(calls).toEqual([]);

    const noKey = await tool.run({ id: "ana", model: { provider: "openai" } }, context);
    expect(noKey).toMatchObject({ isError: true });
    expect(noKey.output).toContain("has no key");
    const stranger = contextOf(true, { ...owner, role: "member" });
    expect(await tool.run({ id: "ana", model: {} }, stranger.context)).toMatchObject({
      isError: true,
    });
  });
});
