import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Locale, RunnerState } from "@kelpie/channels";
import {
  type Actor,
  type AgentRole,
  type AgentSettings,
  DEFAULT_SETTINGS,
  KELPIE_MASCOT,
  MASCOT_HEADS,
  RETIRED_AGENT_ID,
} from "@kelpie/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Announcement, keyOf } from "../src/announcements.ts";
import {
  CONFIGURE_KELPIE_SKILL,
  type ConfigurationCommands,
  configurationTools,
  heldTools,
  MASTER_TOOLS,
} from "../src/configuration.ts";
import type { ConversationAgent } from "../src/conversation-agent.ts";
import { MASCOT_SCHEMA } from "../src/mascot-schema.ts";
import { replacePortsForTesting } from "../src/ports.ts";
import {
  type ConfirmationRequest,
  canonicalJson,
  confirmationNotice,
  confirmsCode,
  type HostLink,
  type Tool,
  type ToolContext,
  type ToolProvider,
} from "../src/tools.ts";
import { type FakeWorld, fakeWorld, held, refuse, reply, toolCalls } from "./fakes.ts";

// Master's configuration tools (Story 3.11, ADR-0048): the configuration commands, owner-only, and
// the changes to access, cost or external accounts only after the owner's confirmation (ADR-0013),
// which the host gates in code.

const ADMIN = "https://admin.example.com";
/** Master, the agent whose tools these are (ADR-0048). */
const MASTER = "kelpie";
const owner: Actor = { userId: "u-owner", role: "owner", via: `agent:${MASTER}` };

/** The Registry's answer for an agent's role (ADR-0036 §1): Master for kelpie, else specialist. */
const roleOf = (id: string) =>
  id === MASTER
    ? ({ role: "master", owner: null, chat: true } as const)
    : id === "scout"
      ? ({ role: "subagent", owner: "ana", chat: false } as const)
      : ({ role: "specialist", owner: MASTER, chat: false } as const);
/** The role the tools read, as the Registry gives it; null for an agent it doesn't list. */
const roleIn = async (id: string): Promise<AgentRole | null> =>
  id === "ghost" ? null : roleOf(id).role;

/** Commands over an in-memory registry; every call is logged. */
function fakeCommands() {
  const agents = new Map<string, string>([[MASTER, "Kelpie"]]);
  /** The agents whose settings name their tools; the others have all they are given. */
  const allowlists = new Map<string, string[]>();
  const calls: string[] = [];
  /** The VPS runner as channel-egress would see it (#294); a test changes it. */
  const runner: { configured: boolean; state: RunnerState } = {
    configured: true,
    state: { state: "ready", version: "0.1.0", protocol: 1 },
  };
  const forbidden = { ok: false, reason: "forbidden" } as const;
  /** The instance's claude-code switch, as llm-gateway holds it (#421). */
  const models = { claudeCode: false };
  const commands: ConfigurationCommands = {
    async listAgents(actor) {
      if (actor.role !== "owner") return forbidden;
      return { ok: true, value: [...agents].map(([id, name]) => ({ id, name, ...roleOf(id) })) };
    },
    async getAgent(actor, input) {
      if (actor.role !== "owner") return forbidden;
      const { id } = input as { id: string };
      const name = agents.get(id);
      if (name === undefined) return { ok: false, reason: "unknown_agent" };
      return {
        ok: true,
        value: {
          id,
          name,
          ...roleOf(id),
          settings: { ...DEFAULT_SETTINGS, tools: allowlists.get(id) ?? null },
          promptVersion: 0,
          mascot: KELPIE_MASCOT,
        },
      };
    },
    async createAgent(actor, input) {
      calls.push(`createAgent ${JSON.stringify(input)}`);
      if (actor.role !== "owner") return forbidden;
      const { id, name } = input as { id: string; name: string };
      if (id === RETIRED_AGENT_ID) return { ok: false, reason: "invalid_input" };
      const created = !agents.has(id);
      agents.set(id, name);
      return { ok: true, value: { id, name, created } };
    },
    async renameAgent(actor, input) {
      calls.push(`renameAgent ${JSON.stringify(input)}`);
      if (actor.role !== "owner") return forbidden;
      const { id, name } = input as { id: string; name: string };
      if (!agents.has(id)) return { ok: false, reason: "unknown_agent" };
      agents.set(id, name);
      return { ok: true, value: { id, name } };
    },
    async configureAgent(actor, input) {
      calls.push(`configureAgent ${JSON.stringify(input)}`);
      if (actor.role !== "owner") return forbidden;
      const { settings } = input as { settings: Partial<AgentSettings> };
      if (settings.model?.provider === "openai") return { ok: false, reason: "no_key" };
      return {
        ok: true,
        value: { settings: { ...DEFAULT_SETTINGS, ...settings }, promptVersion: 1 },
      };
    },
    async getModels(actor) {
      if (actor.role !== "owner") return forbidden;
      return {
        ok: true,
        value: {
          settings: { memory: { tier: "cheap" } },
          pinned: "anthropic",
          providers: ["anthropic"],
          claudeCode: models.claudeCode,
        },
      };
    },
    async configureModels(actor, input) {
      calls.push(`configureModels ${JSON.stringify(input)}`);
      if (actor.role !== "owner") return forbidden;
      const { settings } = input as { settings: { provider?: string } };
      return settings.provider === "openai"
        ? { ok: false, reason: "no_key" }
        : { ok: true, value: {} };
    },
    async setClaudeCode(actor, input) {
      calls.push(`setClaudeCode ${JSON.stringify(input)}`);
      if (actor.role !== "owner") return forbidden;
      models.claudeCode = (input as { on: boolean }).on;
      return { ok: true, value: {} };
    },
    async setMaster(actor, input) {
      calls.push(`setMaster ${JSON.stringify(input)}`);
      if (actor.role !== "owner") return forbidden;
      const { id } = input as { id: string };
      if (roleOf(id).role === "subagent") return { ok: false, reason: "not_allowed" };
      return agents.has(id) ? { ok: true, value: {} } : { ok: false, reason: "unknown_agent" };
    },
    async setAgentChat(actor, input) {
      calls.push(`setAgentChat ${JSON.stringify(input)}`);
      if (actor.role !== "owner") return forbidden;
      const { id } = input as { id: string };
      if (roleOf(id).role !== "specialist") return { ok: false, reason: "not_allowed" };
      return agents.has(id) ? { ok: true, value: {} } : { ok: false, reason: "unknown_agent" };
    },
    async deleteAgent(actor, input) {
      calls.push(`deleteAgent ${JSON.stringify(input)}`);
      if (actor.role !== "owner") return forbidden;
      const { id, ids } = input as { id: string; ids?: string[] };
      if (id === "stuck") return { ok: false, reason: "unavailable" };
      if (!agents.has(id)) return { ok: false, reason: "unknown_agent" };
      if (roleOf(id).role === "master") return { ok: false, reason: "not_allowed" };
      const below = [...agents.keys()].filter((other) => roleOf(other).owner === id);
      const deleted = [...below, id];
      if (ids && [...ids].sort().join() !== [...deleted].sort().join()) {
        return { ok: false, reason: "not_allowed" };
      }
      for (const gone of deleted) agents.delete(gone);
      // The tools' Worker binds no Directory, so only the webchat's thread is named.
      const webhooksLeft = id === "revoked" ? [id] : [];
      return { ok: true, value: { deleted, webhooksLeft, everyThread: false } };
    },
    async connectTelegram(actor, input) {
      calls.push(`connectTelegram ${JSON.stringify(input)}`);
      if (actor.role !== "owner") return forbidden;
      return { ok: true, value: { path: "/forms/tok123", expiresAt: Date.UTC(2026, 9, 6, 20) } };
    },
    async connectRunner(actor) {
      calls.push("connectRunner");
      if (actor.role !== "owner") return forbidden;
      return runner.configured
        ? { ok: true, value: { path: "/forms/run456", expiresAt: Date.UTC(2026, 9, 6, 20) } }
        : { ok: false, reason: "not_configured" };
    },
    async describeRunner(actor) {
      calls.push("describeRunner");
      if (actor.role !== "owner") return forbidden;
      return { ok: true, value: runner.state };
    },
    // The model keys' tools have tests of their own (model-keys.test.ts).
    async connectModelKey(actor) {
      calls.push("connectModelKey");
      if (actor.role !== "owner") return forbidden;
      return {
        ok: true,
        value: { provider: "openai", path: "/forms/key789", expiresAt: Date.UTC(2026, 9, 6, 20) },
      };
    },
    async removeModelKey(actor) {
      calls.push("removeModelKey");
      if (actor.role !== "owner") return forbidden;
      return { ok: true, value: { provider: "openai", removed: true } };
    },
  };
  return { commands, agents, calls, runner, allowlists, models };
}

/**
 * A context whose `confirm` answers `confirmed`, and logs what it was asked, the links sent and
 * what it had Kelpie announce.
 */
function contextOf(confirmed: boolean, actor: Actor = owner, locale: Locale = "en") {
  const asked: ConfirmationRequest[] = [];
  const links: HostLink[] = [];
  const announced: Announcement[] = [];
  const context: ToolContext = {
    locale,
    actor,
    agentId: MASTER,
    scopes: "all",
    trigger: "person",
    qualifier: "clef",
    turn: "1",
    source: "webchat:u-owner, 2026-10-06",
    signal: new AbortController().signal,
    async confirm(request) {
      asked.push(request);
      return confirmed;
    },
    sendLink(link) {
      links.push(link);
    },
    announce(announcement) {
      announced.push(announcement);
    },
  };
  return { context, asked, links, announced };
}

async function toolsOf(provider: ToolProvider, agentId = MASTER) {
  const tools = await provider.tools(agentId);
  return new Map(tools.map((tool) => [tool.spec.name, tool]));
}

const run = async (
  tools: Map<string, Tool>,
  name: string,
  input: unknown,
  context: ToolContext,
) => {
  const tool = tools.get(name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool.run(input, context);
};

describe("Master's configuration tools (ADR-0048)", () => {
  it("are Master's only, with plain labels and no identity or vault commands", async () => {
    const provider = configurationTools(fakeCommands().commands, {
      roleOf: roleIn,
      adminOrigin: ADMIN,
    });
    // Neither a specialist, a subagent nor an agent the Registry doesn't list gets them.
    for (const id of ["assistant", "scout", "ghost", RETIRED_AGENT_ID]) {
      expect(await provider.tools(id), id).toEqual([]);
    }
    // A task's run has no owner to confirm anything (#335).
    expect(await provider.tools(MASTER, { channel: "task" })).toEqual([]);
    expect(await provider.tools(MASTER, { channel: "telegram" })).toHaveLength(17);

    const tools = await toolsOf(provider);
    expect([...tools.keys()]).toEqual([
      "list_agents",
      "get_agent",
      "create_agent",
      "rename_agent",
      "configure_agent",
      "get_models",
      "configure_models",
      "set_claude_code",
      "set_master",
      "set_agent_chat",
      "delete_agent",
      "connect_telegram",
      "pair_telegram",
      "connect_runner",
      "connect_model_key",
      "remove_model_key",
      "runner_status",
    ]);
    for (const tool of tools.values()) {
      // In each language Kelpie speaks (#187).
      expect(Object.keys(tool.label)).toEqual(["en", "pt-BR", "es"]);
      for (const label of Object.values(tool.label)) expect(label).toMatch(/^[A-Z][a-z]/);
      expect(tool.spec.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    }
  });

  it("follow the role: the agent that stops being Master can't run them any more", async () => {
    const { commands, calls } = fakeCommands();
    let role: AgentRole = "master";
    const provider = configurationTools(commands, { roleOf: async () => role, adminOrigin: ADMIN });
    const tools = await toolsOf(provider);
    role = "specialist";
    const { context, asked } = contextOf(true);
    for (const [name, input] of [
      ["list_agents", {}],
      ["create_agent", { id: "ana", name: "Ana" }],
      ["configure_agent", { id: "ana", settings: { tier: "frontier" } }],
      ["connect_runner", {}],
    ] as const) {
      expect(await run(tools, name, input, context), name).toEqual({
        output:
          "This agent isn't Master any more, so it can't configure Kelpie: the owner asks Master.",
        isError: true,
      });
    }
    expect(asked).toEqual([]);
    expect(calls).toEqual([]);
    expect(await provider.tools(MASTER)).toEqual([]);
  });

  it("take any tools list for Master or a new Master: its orchestration tools are never narrowed (#391)", async () => {
    const { commands, agents, allowlists } = fakeCommands();
    agents.set("ana", "Ana");
    allowlists.set("ana", ["memory_search"]);
    const tools = await toolsOf(
      configurationTools(commands, { roleOf: roleIn, adminOrigin: ADMIN }),
    );
    for (const [name, input] of [
      ["configure_agent", { id: MASTER, settings: { tools: ["memory_search"] } }],
      ["configure_agent", { id: MASTER, settings: { tools: [] } }],
      ["set_master", { id: "ana" }],
    ] as const) {
      expect((await run(tools, name, input, contextOf(false).context)).output, name).toContain(
        "Not done yet",
      );
    }
    // Every configuration tool is one of Master's orchestration tools.
    for (const name of tools.keys()) expect(MASTER_TOOLS.has(name), name).toBe(true);
    // The owner and the model are told the list doesn't hold them back.
    const shown = contextOf(false, owner, "pt-BR");
    await run(
      tools,
      "configure_agent",
      { id: MASTER, settings: { tools: ["memory_search"] } },
      shown.context,
    );
    expect(shown.asked[0]?.summary).toContain(
      "O Master mantém as tools de configuração, de subagentes e de tarefas, qualquer que seja a lista.",
    );
    const forAna = contextOf(false);
    await run(tools, "configure_agent", { id: "ana", settings: { tools: [] } }, forAna.context);
    expect(forAna.asked[0]?.summary).not.toContain("Master keeps");
    allowlists.set(MASTER, ["memory_search"]);
    expect(
      (await run(tools, "get_agent", { id: MASTER }, contextOf(false).context)).output,
    ).toContain(
      "As Master, it also always holds its orchestration tools, whatever this list says:",
    );
    // What an agent holds: Master's list gains them; anyone else's, or no list, stays as it is.
    expect(new Set(heldTools("master", ["memory_search"]))).toEqual(
      new Set([...MASTER_TOOLS, "memory_search"]),
    );
    expect(heldTools("master", null)).toBeNull();
    expect(heldTools("specialist", ["memory_search"])).toEqual(["memory_search"]);
    expect(heldTools(null, ["memory_search"])).toEqual(["memory_search"]);
  });

  it("calls the role Master everywhere: its skill, tools and texts (#343, ADR-0060)", async () => {
    // list_agents shows the Registry's value, so the skill ties the two.
    expect(CONFIGURE_KELPIE_SKILL).toContain("You are Master, the role `master` in list_agents.");
    const { commands, agents } = fakeCommands();
    agents.set("ana", "Ana");
    const tools = await toolsOf(
      configurationTools(commands, { roleOf: roleIn, adminOrigin: ADMIN }),
    );
    for (const text of [
      CONFIGURE_KELPIE_SKILL,
      ...[...tools.values()].flatMap((tool) => [
        JSON.stringify(tool.spec),
        ...Object.values(tool.label),
      ]),
    ]) {
      expect(text).not.toMatch(/main agent|agente principal|\bmain\b|setup agent/i);
    }
    expect(tools.get("set_master")?.label).toEqual({
      en: "Choosing Master",
      "pt-BR": "Escolhendo o Master",
      es: "Eligiendo el Master",
    });
    const { context, asked } = contextOf(false, owner, "es");
    await run(tools, "set_master", { id: "ana" }, context);
    expect(asked.map((request) => request.summary)).toEqual([
      'convertir el agente "Ana" (ana) en el Master, el que conversa contigo y configura Kelpie.',
    ]);
  });

  it("lists, creates and renames agents directly", async () => {
    const { commands, calls } = fakeCommands();
    const tools = await toolsOf(
      configurationTools(commands, { roleOf: roleIn, adminOrigin: ADMIN }),
    );
    const { context, asked } = contextOf(false);

    expect(
      (await run(tools, "create_agent", { id: "ana", name: "Ana" }, context)).output,
    ).toContain("ana");
    expect(
      (await run(tools, "rename_agent", { id: "ana", name: "Ana Souza" }, context)).isError,
    ).toBe(undefined);
    const listed = await run(tools, "list_agents", {}, context);
    // With each agent's role, and whether the owner can chat with it (#288).
    expect(listed.output).toContain("ana: Ana Souza (specialist, chat off)");
    expect(listed.output).toContain(`${MASTER}: Kelpie (master)`);
    expect(asked).toEqual([]);
    expect(calls).toEqual([
      'createAgent {"id":"ana","name":"Ana"}',
      'renameAgent {"id":"ana","name":"Ana Souza"}',
    ]);
  });

  it("has Kelpie announce each agent it creates or renames, as the command did it (#387)", async () => {
    const { commands } = fakeCommands();
    // The commands trim a name, as the admin API's do.
    const trimmed: ConfigurationCommands = {
      ...commands,
      createAgent: (actor, input) =>
        commands.createAgent(actor, { ...(input as object), name: "Ana" }),
      renameAgent: (actor, input) =>
        commands.renameAgent(actor, { ...(input as object), name: "Ana Souza" }),
    };
    const tools = await toolsOf(
      configurationTools(trimmed, { roleOf: roleIn, adminOrigin: ADMIN }),
    );
    const { context, announced } = contextOf(false);

    await run(tools, "create_agent", { id: "ana", name: "  Ana " }, context);
    await run(tools, "rename_agent", { id: "ana", name: " Ana Souza  " }, context);
    expect(announced).toEqual([
      { kind: "agentCreated", agentId: "ana", name: "Ana" },
      { kind: "agentRenamed", agentId: "ana", name: "Ana Souza" },
    ]);

    // Nothing to announce when nothing changed, or the command refused.
    announced.length = 0;
    expect((await run(tools, "create_agent", { id: "ana", name: "Ana" }, context)).output).toBe(
      "The agent ana already exists; nothing changed.",
    );
    const stranger = contextOf(false, { ...owner, role: "member" });
    const refused = [
      await run(tools, "create_agent", { id: RETIRED_AGENT_ID, name: "Mine" }, context),
      await run(tools, "rename_agent", { id: "ghost", name: "Ghost" }, context),
      await run(tools, "create_agent", { id: "bob", name: "Bob" }, stranger.context),
      await run(tools, "rename_agent", { id: "ana", name: "Bob" }, stranger.context),
    ];
    expect(refused.map((outcome) => outcome.isError)).toEqual([true, true, true, true]);
    expect([...announced, ...stranger.announced]).toEqual([]);
  });

  it("answers what went wrong in words the model can act on", async () => {
    const tools = await toolsOf(
      configurationTools(fakeCommands().commands, { roleOf: roleIn, adminOrigin: ADMIN }),
    );
    const { context } = contextOf(true);

    const reserved = await run(
      tools,
      "create_agent",
      { id: RETIRED_AGENT_ID, name: "Mine" },
      context,
    );
    expect(reserved).toMatchObject({ isError: true });
    expect(reserved.output).toContain("isn't valid");
    const unknown = await run(tools, "get_agent", { id: "ghost" }, context);
    expect(unknown).toEqual({ output: "There is no agent with the id ghost.", isError: true });
    expect(await run(tools, "get_agent", { id: "Not An Id" }, context)).toMatchObject({
      isError: true,
    });
  });

  it("refuses everyone but the owner, before asking for any confirmation", async () => {
    const { commands, calls } = fakeCommands();
    const tools = await toolsOf(
      configurationTools(commands, { roleOf: roleIn, adminOrigin: ADMIN }),
    );
    const { context, asked } = contextOf(true, { ...owner, role: "member" });

    for (const [name, input] of [
      ["configure_agent", { id: MASTER, settings: { tier: "frontier" } }],
      ["connect_telegram", { agentId: MASTER }],
      ["pair_telegram", { agentId: MASTER }],
      ["connect_runner", {}],
      ["runner_status", {}],
      ["create_agent", { id: "ana", name: "Ana" }],
      ["set_master", { id: MASTER }],
      ["set_agent_chat", { id: MASTER, chat: true }],
      ["delete_agent", { id: "ana" }],
    ] as const) {
      expect(await run(tools, name, input, context), name).toEqual({
        output: "Only the owner can change Kelpie's configuration.",
        isError: true,
      });
    }
    expect(asked).toEqual([]);
    expect(calls.filter((call) => !call.startsWith("createAgent"))).toEqual([]);
  });

  it("asks the owner to confirm a new Master or a chat change, and runs it only then (#288)", async () => {
    const { commands, agents, calls } = fakeCommands();
    agents.set("ana", "Ana");
    const tools = await toolsOf(
      configurationTools(commands, { roleOf: roleIn, adminOrigin: ADMIN }),
    );

    const waiting = contextOf(false, owner, "pt-BR");
    expect((await run(tools, "set_master", { id: "ana" }, waiting.context)).output).toContain(
      "Not done yet",
    );
    expect(
      (await run(tools, "set_agent_chat", { id: "ana", chat: true }, waiting.context)).output,
    ).toContain("Not done yet");
    expect(waiting.asked).toEqual([
      {
        command: "setMaster",
        input: { id: "ana" },
        summary:
          'tornar o agente "Ana" (ana) o Master, o que conversa com você e configura o Kelpie.',
      },
      {
        command: "setAgentChat",
        input: { id: "ana", chat: true },
        summary: 'permitir que você converse com o agente "Ana" (ana).',
      },
    ]);
    expect(calls).toEqual([]);

    const confirmed = contextOf(true);
    expect(await run(tools, "set_master", { id: "ana" }, confirmed.context)).toEqual({
      output:
        "The agent ana is now Master: the one the owner talks to. Your configuration tools went with the role: from now on, ana configures Kelpie.",
    });
    expect(
      await run(tools, "set_agent_chat", { id: "ana", chat: true }, confirmed.context),
    ).toEqual({
      output: "The owner can now chat with the agent ana.",
    });
    expect(confirmed.asked.map((request) => request.summary)).toEqual([
      'make the agent "Ana" (ana) Master, the one you talk to, which also configures Kelpie.',
      'let you chat with the agent "Ana" (ana).',
    ]);
    expect(calls).toEqual(['setMaster {"id":"ana"}', 'setAgentChat {"id":"ana","chat":true}']);
  });

  it("shows and sets the instance's models, behind the owner's confirmation (#289)", async () => {
    const { commands, calls } = fakeCommands();
    const tools = await toolsOf(
      configurationTools(commands, { roleOf: roleIn, adminOrigin: ADMIN }),
    );

    const shown = await run(tools, "get_models", {}, contextOf(false).context);
    expect(JSON.parse(String(shown.output))).toEqual({
      settings: { memory: { tier: "cheap" } },
      pinned: "anthropic",
      providers: ["anthropic"],
      claudeCode: false,
    });

    const settings = { conversation: { tier: "medium", effort: "high" } };
    const waiting = contextOf(false);
    expect((await run(tools, "configure_models", { settings }, waiting.context)).output).toContain(
      "Not done yet",
    );
    expect(waiting.asked).toEqual([
      {
        command: "configureModels",
        input: { settings },
        summary: `set the models every agent uses unless it has its own, from ${JSON.stringify({ memory: { tier: "cheap" } })} to ${JSON.stringify(settings)}.`,
      },
    ]);
    expect(calls).toEqual([]);

    const confirmed = contextOf(true);
    expect(await run(tools, "configure_models", { settings }, confirmed.context)).toEqual({
      output: "Changed the models every agent uses unless it has its own.",
    });
    const noKey = await run(
      tools,
      "configure_models",
      { settings: { provider: "openai" } },
      confirmed.context,
    );
    expect(noKey).toMatchObject({ isError: true });
    expect(noKey.output).toContain("doesn't serve in llm-gateway: a provider needs its key");
    expect(
      await run(tools, "configure_models", { settings: { tier: "x" } }, confirmed.context),
    ).toMatchObject({
      isError: true,
    });
  });

  it("turns the claude-code route on and off behind the owner's confirmation, never in a task's run (#421)", async () => {
    const { commands, calls, models } = fakeCommands();
    const provider = configurationTools(commands, { roleOf: roleIn, adminOrigin: ADMIN });
    const tools = await toolsOf(provider);
    // No one confirms anything in a task's run (#335), so the switch isn't there either.
    expect(await provider.tools(MASTER, { channel: "task" })).toEqual([]);

    const waiting = contextOf(false);
    expect((await run(tools, "set_claude_code", { on: true }, waiting.context)).output).toContain(
      "Not done yet",
    );
    expect(waiting.asked).toEqual([
      {
        command: "setClaudeCode",
        input: { on: true },
        summary:
          "turn on the claude-code route: your conversations may reach Claude through Claude Code on your VPS runner, on your Claude subscription, when the Anthropic API route fails or where the model settings name claude-code. Each such turn spends the subscription's weekly usage limit, which your own coding with Claude Code shares, and may also draw extra usage if the account has it on.",
      },
    ]);
    expect(calls).toEqual([]);

    const confirmed = contextOf(true);
    expect((await run(tools, "set_claude_code", { on: true }, confirmed.context)).output).toMatch(
      /^The claude-code route is on/,
    );
    expect(models.claudeCode).toBe(true);
    // Checked before the owner is asked: a yes that changes nothing isn't asked for.
    const again = contextOf(true);
    expect(await run(tools, "set_claude_code", { on: true }, again.context)).toEqual({
      output: "The claude-code route is already on; nothing changed.",
    });
    expect(again.asked).toEqual([]);
    expect(await run(tools, "set_claude_code", { on: false }, confirmed.context)).toEqual({
      output:
        "The claude-code route is off: the owner's conversations no longer reach Claude through Claude Code.",
    });
    expect(calls).toEqual(['setClaudeCode {"on":true}', 'setClaudeCode {"on":false}']);

    const member: Actor = { userId: "u-member", role: "member", via: `agent:${MASTER}` };
    expect(
      await run(tools, "set_claude_code", { on: true }, contextOf(true, member).context),
    ).toEqual({
      output: "Only the owner can change Kelpie's configuration.",
      isError: true,
    });
    expect(await run(tools, "set_claude_code", { on: "yes" }, confirmed.context)).toMatchObject({
      isError: true,
    });
    expect(calls).toHaveLength(2);
  });

  it("says, in each of Kelpie's languages, that the claude-code route spends the subscription's weekly limit (#421)", async () => {
    const { commands, models } = fakeCommands();
    const tools = await toolsOf(
      configurationTools(commands, { roleOf: roleIn, adminOrigin: ADMIN }),
    );
    expect(tools.get("set_claude_code")?.spec.description).toContain(
      "It spends the subscription's weekly usage limit, which the owner's own coding with Claude Code shares.",
    );
    const weekly: Record<Locale, string> = {
      en: "weekly usage limit",
      "pt-BR": "limite de uso semanal",
      es: "límite de uso semanal",
    };
    const extra: Record<Locale, string> = {
      en: "may also draw extra usage if the account has it on",
      "pt-BR": "também pode consumir uso extra se a conta o tiver ativado",
      es: "también puede consumir uso adicional si la cuenta lo tiene activado",
    };
    for (const [locale, words] of Object.entries(weekly) as [Locale, string][]) {
      for (const on of [true, false]) {
        models.claudeCode = !on;
        const waiting = contextOf(false, owner, locale);
        await run(tools, "set_claude_code", { on }, waiting.context);
        expect(waiting.asked[0]?.summary, `${locale} ${on}`).toContain(words);
        expect(waiting.asked[0]?.summary, `${locale} ${on}`).toContain("claude-code");
        // Turning it on also says a turn may draw extra usage, where the account has it on (#431).
        if (on) expect(waiting.asked[0]?.summary, locale).toContain(extra[locale]);
      }
    }
  });

  it("keeps claude-code out of memory before the owner is asked, and out of memory's schema (#421)", async () => {
    const { commands, calls } = fakeCommands();
    const tools = await toolsOf(
      configurationTools(commands, { roleOf: roleIn, adminOrigin: ADMIN }),
    );
    const memory = { memory: { provider: "claude-code" } };
    const refused = {
      output:
        "claude-code serves only conversations, never memory: name another provider for memory, or none.",
      isError: true,
    };
    const asked = contextOf(true);
    expect(await run(tools, "configure_models", { settings: memory }, asked.context)).toEqual(
      refused,
    );
    expect(
      await run(
        tools,
        "configure_agent",
        { id: "ana", settings: { model: memory } },
        asked.context,
      ),
    ).toEqual(refused);
    expect(asked.asked).toEqual([]);
    expect(calls).toEqual([]);

    const schema = JSON.parse(JSON.stringify(tools.get("configure_models")?.spec.inputSchema));
    const { properties } = schema.properties.settings;
    expect(properties.provider.enum).toContain("claude-code");
    expect(properties.conversation.properties.provider.enum).toContain("claude-code");
    expect(properties.memory.properties.provider.enum).toEqual(["anthropic", "openai"]);
  });

  it("says configure_agent's model replaces the agent's whole model settings (ADR-0048)", async () => {
    const tools = await toolsOf(
      configurationTools(fakeCommands().commands, { roleOf: roleIn, adminOrigin: ADMIN }),
    );
    expect(JSON.stringify(tools.get("configure_agent")?.spec)).toContain(
      "It replaces the agent's whole model settings: pass them whole, as get_agent shows them",
    );
  });

  it("changes an agent's model, Master's own included, showing the owner what it had (#289)", async () => {
    const { commands, calls } = fakeCommands();
    const tools = await toolsOf(
      configurationTools(commands, { roleOf: roleIn, adminOrigin: ADMIN }),
    );
    const model = { conversation: { tier: "frontier" } };

    const waiting = contextOf(false);
    await run(tools, "configure_agent", { id: MASTER, settings: { model } }, waiting.context);
    expect(waiting.asked).toEqual([
      {
        command: "configureAgent",
        input: { id: MASTER, settings: { model } },
        summary: `change the settings of the agent "Kelpie" (${MASTER}): model from {} to ${JSON.stringify(model)}.`,
      },
    ]);
    const confirmed = contextOf(true);
    expect(
      await run(tools, "configure_agent", { id: MASTER, settings: { model } }, confirmed.context),
    ).toEqual({ output: `Changed the settings of the agent ${MASTER}.` });
    const noKey = await run(
      tools,
      "configure_agent",
      { id: MASTER, settings: { model: { provider: "openai" } } },
      confirmed.context,
    );
    expect(noKey).toMatchObject({ isError: true });
    expect(noKey.output).toContain("doesn't serve in llm-gateway: a provider needs its key");
    expect(calls.filter((call) => call.startsWith("configureAgent"))).toHaveLength(2);
  });

  it("refuses a role that can't take the change, or says it's done, before asking anything", async () => {
    const { commands, agents, calls } = fakeCommands();
    agents.set("ana", "Ana");
    agents.set("kelpie", "Kelpie");
    const tools = await toolsOf(
      configurationTools(commands, { roleOf: roleIn, adminOrigin: ADMIN }),
    );
    const { context, asked } = contextOf(true);

    agents.set("scout", "Scout");
    const subagent = await run(tools, "set_master", { id: "scout" }, context);
    expect(subagent).toEqual({ output: "A subagent can't be Master.", isError: true });
    for (const id of [MASTER, "scout"]) {
      const refused = await run(tools, "set_agent_chat", { id, chat: false }, context);
      expect(refused).toEqual({
        output:
          "Only a specialist's chat can change: Master always chats, and a subagent never does.",
        isError: true,
      });
    }
    expect(await run(tools, "set_master", { id: "kelpie" }, context)).toEqual({
      output: "The agent kelpie is already Master; nothing changed.",
    });
    expect(await run(tools, "set_agent_chat", { id: "ana", chat: false }, context)).toEqual({
      output: "The agent ana's chat is already off; nothing changed.",
    });
    expect(await run(tools, "set_agent_chat", { id: "ana", chat: "yes" }, context)).toMatchObject({
      isError: true,
    });
    expect(asked).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("asks the owner to confirm a deletion, naming its subagents and what stays, and runs it only then (#303)", async () => {
    const { commands, agents, calls } = fakeCommands();
    agents.set("ana", "Ana");
    agents.set("scout", "Scout");
    agents.set("bia", "Bia");
    const tools = await toolsOf(
      configurationTools(commands, { roleOf: roleIn, adminOrigin: ADMIN }),
    );

    const waiting = contextOf(false);
    expect((await run(tools, "delete_agent", { id: "ana" }, waiting.context)).output).toContain(
      "Not done yet",
    );
    // The input names every agent the owner sees, so the yes deletes that set and no other.
    expect(waiting.asked).toEqual([
      {
        command: "deleteAgent",
        input: { id: "ana", ids: ["ana", "scout"] },
        summary:
          'delete, for good, the agent "Ana" (ana) and its subagent "Scout" (scout): their settings, their conversations with all their history, and Kelpie\'s connection to their Telegram bots. A bot itself stays yours: revoke its token with BotFather if you no longer want it. The files under agents/ana/ in your vault stay.',
      },
    ]);
    const summaries = async (locale: Locale, id: string) => {
      const { context, asked } = contextOf(false, owner, locale);
      await run(tools, "delete_agent", { id }, context);
      return asked[0]?.summary;
    };
    expect(await summaries("en", "bia")).toBe(
      'delete, for good, the agent "Bia" (bia): its settings, its conversations with all their history, and Kelpie\'s connection to its Telegram bot. The bot itself stays yours: revoke its token with BotFather if you no longer want it. The files under agents/bia/ in your vault stay.',
    );
    expect(await summaries("pt-BR", "bia")).toBe(
      'excluir de vez o agente "Bia" (bia): as configurações, as conversas com todo o histórico e a conexão do Kelpie com o bot do Telegram dele. O bot continua seu: revogue o token no BotFather se não quiser mais ele. Os arquivos em agents/bia/ no seu vault ficam.',
    );
    expect(await summaries("pt-BR", "ana")).toBe(
      'excluir de vez o agente "Ana" (ana) e o subagente dele "Scout" (scout): as configurações, as conversas com todo o histórico e a conexão do Kelpie com os bots do Telegram deles. Cada bot continua seu: revogue o token no BotFather se não quiser mais ele. Os arquivos em agents/ana/ no seu vault ficam.',
    );
    expect(await summaries("es", "bia")).toBe(
      'eliminar para siempre el agente "Bia" (bia): su configuración, sus conversaciones con todo su historial y la conexión de Kelpie con su bot de Telegram. El bot sigue siendo tuyo: revoca su token con BotFather si ya no lo quieres. Los archivos en agents/bia/ de tu vault se quedan.',
    );
    expect(await summaries("es", "ana")).toBe(
      'eliminar para siempre el agente "Ana" (ana) y su subagente "Scout" (scout): su configuración, sus conversaciones con todo su historial y la conexión de Kelpie con sus bots de Telegram. Cada bot sigue siendo tuyo: revoca su token con BotFather si ya no lo quieres. Los archivos en agents/ana/ de tu vault se quedan.',
    );
    expect(calls).toEqual([]);

    const confirmed = contextOf(true);
    const done = await run(tools, "delete_agent", { id: "ana" }, confirmed.context);
    expect(done.output).toMatch(
      /^Deleted the agent ana and its subagent scout: their settings, conversations and Kelpie's connection to their Telegram bots are gone\. /,
    );
    // Through this Worker only the webchat's thread is named, and the model is told what may stay.
    expect(done.output).toContain("an agent created again with the id ana would get it back");
    expect(done.output).toContain("Its files in the vault, under agents/ana/, stay");
    expect(calls).toEqual(['deleteAgent {"id":"ana","ids":["ana","scout"]}']);
    expect([...agents.keys()]).toEqual([MASTER, "bia"]);
  });

  it("never deletes Master, and says what to do when a deletion stops", async () => {
    const { commands, agents, calls } = fakeCommands();
    agents.set("kelpie", "Kelpie");
    agents.set("stuck", "Stuck");
    agents.set("revoked", "Revoked");
    const tools = await toolsOf(
      configurationTools(commands, { roleOf: roleIn, adminOrigin: ADMIN }),
    );
    const { context, asked } = contextOf(true);

    expect(await run(tools, "delete_agent", { id: MASTER }, context)).toEqual({
      output: "Master can't be deleted.",
      isError: true,
    });
    expect(await run(tools, "delete_agent", { id: "ghost" }, context)).toEqual({
      output: "There is no agent with the id ghost.",
      isError: true,
    });
    expect(asked).toEqual([]);
    expect(calls).toEqual([]);

    const cut = await run(tools, "delete_agent", { id: "stuck" }, context);
    expect(cut).toMatchObject({ isError: true });
    expect(cut.output).toContain("still listed, with its chat off");
    expect(cut.output).toContain("Call delete_agent again");

    const revoked = await run(tools, "delete_agent", { id: "revoked" }, context);
    expect(revoked.output).toContain("Telegram refused to take down the webhook of revoked's bot");
  });

  it("asks again when what a deletion would delete changed since the owner was shown it", async () => {
    const { commands, agents } = fakeCommands();
    agents.set("ana", "Ana");
    const tools = await toolsOf(
      configurationTools(commands, { roleOf: roleIn, adminOrigin: ADMIN }),
    );
    const shown = contextOf(false);
    await run(tools, "delete_agent", { id: "ana" }, shown.context);
    expect(shown.asked[0]?.input).toEqual({ id: "ana", ids: ["ana"] });

    // Scout appears under Ana before the owner's yes: the confirmed set no longer matches.
    agents.set("scout", "Scout");
    const stale = await commands.deleteAgent(owner, shown.asked[0]?.input);
    expect(stale).toEqual({ ok: false, reason: "not_allowed" });
    expect([...agents.keys()]).toContain("ana");

    const changed = await run(tools, "delete_agent", { id: "ana" }, contextOf(true).context);
    expect(changed.output).toMatch(/^Deleted the agent ana and its subagent scout/);
  });

  it("tells the model a new agent's chat is off, and when a bot is connected to it (#288)", async () => {
    const { commands } = fakeCommands();
    const tools = await toolsOf(
      configurationTools(commands, { roleOf: roleIn, adminOrigin: ADMIN }),
    );
    const { context } = contextOf(true);

    const created = await run(tools, "create_agent", { id: "ana", name: "Ana" }, context);
    expect(created.output).toContain("It is a specialist, owned by Master, and its chat is off");
    const connected = await run(tools, "connect_telegram", { agentId: "ana" }, context);
    expect(connected.output).toContain("Its chat is off");
    const paired = await run(tools, "pair_telegram", { agentId: "ana" }, context);
    expect(paired.output).toContain("Its chat is off");
    expect(
      (await run(tools, "connect_telegram", { agentId: MASTER }, context)).output,
    ).not.toContain("chat is off");
  });

  it("sends the runner's secure form as a link of Kelpie's own, in the owner's language (#294)", async () => {
    const { commands } = fakeCommands();
    const now = () => Date.UTC(2026, 9, 6, 19, 45);
    const tools = await toolsOf(
      configurationTools(commands, { roleOf: roleIn, adminOrigin: ADMIN, now }),
    );
    const { context, links } = contextOf(true, owner, "pt-BR");

    const sent = await run(tools, "connect_runner", {}, context);
    expect(sent.isError).toBeUndefined();
    // Kelpie tells the conversation when the form is used: the model doesn't wait for "done" (#328).
    expect(sent.output).toContain("don't ask them to say when they're done");
    expect(sent.output).not.toContain("runner_status");
    // The model never sees the link, nor the form's one-time token (ADR-0026).
    expect(sent.output).not.toContain("/forms/");
    expect(sent.output).not.toContain("run456");
    expect(links).toEqual([
      {
        href: `${ADMIN}/forms/run456?lang=pt-BR`,
        text: `O formulário seguro para conectar o runner: ${ADMIN}/forms/run456?lang=pt-BR\nFunciona uma vez, nos próximos 15 minutos. Cole lá o segredo de ~/.config/kelpie-runner/secret do seu servidor, uma linha só, nunca no chat.`,
        // Master's own AgentHost keeps the wait, until the form expires (#328, ADR-0060).
        awaits: {
          agentId: MASTER,
          step: "runner_connected",
          until: Date.UTC(2026, 9, 6, 20),
        },
      },
    ]);
  });

  it("says a Kelpie service didn't answer when the runner's state can't be read", async () => {
    const { commands } = fakeCommands();
    commands.describeRunner = async () => ({ ok: false, reason: "unavailable" });
    const tools = await toolsOf(
      configurationTools(commands, { roleOf: roleIn, adminOrigin: ADMIN }),
    );
    const { context } = contextOf(true);
    expect(await run(tools, "runner_status", {}, context)).toMatchObject({ isError: true });
  });

  it("says what to set up when Kelpie was deployed without the runner's VPC Service", async () => {
    const { commands, runner } = fakeCommands();
    runner.configured = false;
    const tools = await toolsOf(
      configurationTools(commands, { roleOf: roleIn, adminOrigin: ADMIN }),
    );
    const { context, links } = contextOf(true);
    const refused = await run(tools, "connect_runner", {}, context);
    expect(refused).toMatchObject({ isError: true });
    expect(refused.output).toContain("docs/runner.md");
    expect(links).toEqual([]);
  });

  it.each([
    [{ state: "ready", version: "0.1.0", protocol: 1 }, "is ready, version 0.1.0"],
    [{ state: "outdated", version: "0.0.9", protocol: 2 }, "update it on the server"],
    [{ state: "refused" }, "no longer takes the secret"],
    [{ state: "unreachable" }, "cloudflared"],
    [{ state: "not_connected" }, "has no secret for the runner yet"],
    [{ state: "not_configured" }, "docs/runner.md"],
  ] as const)("tells the model the runner's state: %o", async (state, words) => {
    const { commands, runner } = fakeCommands();
    runner.state = state;
    const tools = await toolsOf(
      configurationTools(commands, { roleOf: roleIn, adminOrigin: ADMIN }),
    );
    const { context } = contextOf(true);
    expect((await run(tools, "runner_status", {}, context)).output).toContain(words);
  });

  it("changes an agent's mascot whole, after the owner's confirmation (ADR-0045 §2)", async () => {
    const { commands, calls } = fakeCommands();
    const tools = await toolsOf(
      configurationTools(commands, { roleOf: roleIn, adminOrigin: ADMIN }),
    );
    const schema = tools.get("configure_agent")?.spec.inputSchema as unknown as {
      properties: { settings: { properties: Record<string, unknown> } };
    };
    expect(schema.properties.settings.properties.mascot).toBe(MASCOT_SCHEMA);
    expect(MASCOT_SCHEMA.properties.head.properties.type.enum).toEqual(Object.keys(MASCOT_HEADS));
    expect(MASCOT_SCHEMA.properties.head.description).toContain("ears: pointed, floppy, round");

    const mascot = {
      ...KELPIE_MASCOT,
      color: "pink",
      accessory: { type: "hat", variation: "top" },
    };
    const input = { id: MASTER, settings: { mascot } };
    const waiting = contextOf(false);
    await run(tools, "configure_agent", input, waiting.context);
    expect(waiting.asked[0]?.summary).toContain(`mascot to ${JSON.stringify(mascot)}`);
    expect(calls).toEqual([]);

    const confirmed = contextOf(true);
    expect((await run(tools, "configure_agent", input, confirmed.context)).isError).toBe(undefined);
    expect(calls).toEqual([`configureAgent ${JSON.stringify(input)}`]);
    // A variation that isn't its type's is refused before the owner is asked.
    const wrong = { ...mascot, head: { type: "ears", variation: "mohawk" } };
    const refused = contextOf(false);
    expect(
      (
        await run(
          tools,
          "configure_agent",
          { ...input, settings: { mascot: wrong } },
          refused.context,
        )
      ).isError,
    ).toBe(true);
    expect(refused.asked).toEqual([]);
  });

  it("asks the owner to confirm a settings change, for its parsed input, and runs it only then", async () => {
    const { commands, calls } = fakeCommands();
    const tools = await toolsOf(
      configurationTools(commands, { roleOf: roleIn, adminOrigin: ADMIN }),
    );
    const input = { id: MASTER, settings: { tier: "frontier", quietMs: 2_000 } };

    const waiting = contextOf(false);
    const asked = await run(tools, "configure_agent", input, waiting.context);
    expect(asked.output).toMatch(/^Not done yet: Kelpie showed the owner this change/);
    expect(waiting.asked).toEqual([
      {
        command: "configureAgent",
        input: { id: MASTER, settings: { tier: "frontier", quietMs: 2_000 } },
        summary: `change the settings of the agent "Kelpie" (${MASTER}): tier to "frontier", quietMs to 2000.`,
      },
    ]);
    expect(calls).toEqual([]);
    // The summary is in the conversation's language; the keys and values stay as they are (#187).
    for (const [locale, summary] of [
      [
        "pt-BR",
        `alterar as configurações do agente "Kelpie" (${MASTER}): tier para "frontier", quietMs para 2000.`,
      ],
      [
        "es",
        `cambiar la configuración del agente "Kelpie" (${MASTER}): tier a "frontier", quietMs a 2000.`,
      ],
    ] as const) {
      const spoken = contextOf(false, owner, locale);
      await run(tools, "configure_agent", input, spoken.context);
      expect(spoken.asked.map((request) => request.summary)).toEqual([summary]);
    }

    const confirmed = contextOf(true);
    expect((await run(tools, "configure_agent", input, confirmed.context)).isError).toBe(undefined);
    expect(calls).toEqual([
      `configureAgent {"id":"${MASTER}","settings":{"tier":"frontier","quietMs":2000}}`,
    ]);
  });

  it("asks the owner before the agent runs more tasks at once, as for any setting (#54)", async () => {
    const { commands, calls } = fakeCommands();
    const tools = await toolsOf(
      configurationTools(commands, { roleOf: roleIn, adminOrigin: ADMIN }),
    );
    const schema = tools.get("configure_agent")?.spec.inputSchema as unknown as {
      properties: { settings: { properties: object } };
    };
    expect(schema.properties.settings.properties).toHaveProperty("maxConcurrentTasks", {
      type: "integer",
      minimum: 0,
      maximum: 10,
      description:
        "How many of its tasks the agent runs at once; 0 runs none, and more costs more.",
    });
    const input = { id: MASTER, settings: { maxConcurrentTasks: 5 } };
    const waiting = contextOf(false);
    expect((await run(tools, "configure_agent", input, waiting.context)).output).toContain(
      "Not done yet",
    );
    expect(waiting.asked[0]?.summary).toBe(
      `change the settings of the agent "Kelpie" (${MASTER}): maxConcurrentTasks to 5.`,
    );
    expect(calls).toEqual([]);
  });

  it("refuses settings it can't show the owner whole, before asking", async () => {
    const tools = await toolsOf(
      configurationTools(fakeCommands().commands, { roleOf: roleIn, adminOrigin: ADMIN }),
    );
    const { context, asked } = contextOf(true);

    // Past what one bubble shows, counting the escapes that make invisible characters visible.
    const invisible = "\u{E0041}".repeat(400);
    for (const settings of [
      {},
      { tier: "huge" },
      { systemPrompt: "x".repeat(3_500) },
      { systemPrompt: `Seja breve.${invisible}` },
      "smart",
    ]) {
      expect(await run(tools, "configure_agent", { id: MASTER, settings }, context)).toMatchObject({
        isError: true,
      });
    }
    expect(asked).toEqual([]);
    // A prompt that fits is shown whole.
    const fits = await run(
      tools,
      "configure_agent",
      { id: MASTER, settings: { systemPrompt: "x".repeat(3_000) } },
      context,
    );
    expect(fits.isError).toBe(undefined);
    expect(asked[0]?.summary).toContain("x".repeat(3_000));
  });

  it("has Kelpie send the secure form's link itself, with no code: submitting the form is the yes (#186)", async () => {
    const { commands, agents, calls } = fakeCommands();
    // A name is the model's, and Kelpie's bubble is formatted: it names the agent by its id only.
    agents.set("assistant", "[Cancel](https://admin.example.com/pair/telegram/x)");
    const tools = await toolsOf(
      configurationTools(commands, {
        roleOf: roleIn,
        adminOrigin: ADMIN,
        now: () => Date.UTC(2026, 9, 6, 19, 45),
      }),
    );
    const { context, asked, links } = contextOf(false);

    const done = await run(tools, "connect_telegram", { agentId: "assistant" }, context);
    expect(asked).toEqual([]);
    expect(calls).toEqual(['connectTelegram {"agentId":"assistant"}']);
    // The link names the conversation's language, so the page opens in it too (#187).
    expect(links).toEqual([
      {
        href: `${ADMIN}/forms/tok123?lang=en`,
        text: `The secure form to connect the Telegram bot of the agent assistant: ${ADMIN}/forms/tok123?lang=en\nIt works once, for the next 15 minutes. Paste the bot's token there, never in the chat.`,
        // The conversation waits for the form while it is open, to be told when it is used (#206).
        awaits: {
          agentId: "assistant",
          step: "telegram_connected",
          until: Date.UTC(2026, 9, 6, 20),
        },
      },
    ]);
    for (const [locale, text] of [
      [
        "pt-BR",
        `O formulário seguro para conectar o bot do Telegram do agente assistant: ${ADMIN}/forms/tok123?lang=pt-BR\nFunciona uma vez, nos próximos 15 minutos. Cole o token do bot lá, nunca no chat.`,
      ],
      [
        "es",
        `El formulario seguro para conectar el bot de Telegram del agente assistant: ${ADMIN}/forms/tok123?lang=es\nFunciona una vez, durante los próximos 15 minutos. Pega allí el token del bot, nunca en el chat.`,
      ],
    ] as const) {
      const spoken = contextOf(false, owner, locale);
      await run(tools, "connect_telegram", { agentId: "assistant" }, spoken.context);
      expect(spoken.links.map((link) => link.text)).toEqual([text]);
    }
    // The model learns the link was sent, never the link or its token.
    expect(done.output).not.toContain("/forms/");
    expect(done.output).not.toContain("tok123");
    expect(done.output).toContain("don't write a link yourself");
    // How long, not until when: the model would otherwise turn a UTC time into the owner's zone.
    expect(done.output).toContain("works once, for the next 15 minutes.");
    expect(done.output).not.toContain("2026");
  });

  it("has Kelpie send the link to the admin page that pairs the owner's Telegram account (#186)", async () => {
    const sentAt = Date.UTC(2026, 9, 6, 19);
    const tools = await toolsOf(
      configurationTools(fakeCommands().commands, {
        roleOf: roleIn,
        adminOrigin: ADMIN,
        now: () => sentAt,
      }),
    );
    const { context, asked, links } = contextOf(false);

    const linked = await run(tools, "pair_telegram", { agentId: MASTER }, context);
    expect(links).toEqual([
      {
        href: `${ADMIN}/pair/telegram/${MASTER}?lang=en`,
        text: `To pair your own Telegram account with the bot of the agent ${MASTER}, open ${ADMIN}/pair/telegram/${MASTER}?lang=en and press its button.`,
        // The page doesn't expire, so the conversation waits a day for the pairing (#206).
        awaits: {
          agentId: MASTER,
          step: "telegram_paired",
          until: sentAt + 24 * 60 * 60_000,
        },
      },
    ]);
    const spoken = contextOf(false, owner, "pt-BR");
    await run(tools, "pair_telegram", { agentId: MASTER }, spoken.context);
    expect(spoken.links.map((link) => link.text)).toEqual([
      `Para parear sua própria conta do Telegram com o bot do agente ${MASTER}, abra ${ADMIN}/pair/telegram/${MASTER}?lang=pt-BR e toque no botão da página.`,
    ]);
    expect(linked.output).not.toContain("/pair/");
    expect(asked).toEqual([]);
    expect(await run(tools, "pair_telegram", { agentId: "ghost" }, context)).toMatchObject({
      isError: true,
    });
    expect(links).toHaveLength(1);
  });

  it("says so, before asking anything, when the admin API's address isn't a bare https origin", async () => {
    for (const adminOrigin of ["", "http://admin.example.com", `${ADMIN}/x`, "admin.example.com"]) {
      const { commands, calls } = fakeCommands();
      const tools = await toolsOf(configurationTools(commands, { roleOf: roleIn, adminOrigin }));
      const { context, asked, links } = contextOf(true);

      for (const name of [
        "connect_telegram",
        "pair_telegram",
        "connect_runner",
        "connect_model_key",
      ]) {
        const answer = await run(tools, name, { agentId: MASTER, provider: "openai" }, context);
        expect(answer.isError, `${name} ${adminOrigin}`).toBe(true);
        expect(answer.output, name).toContain("ADMIN_ORIGIN");
      }
      expect(asked).toEqual([]);
      expect(links).toEqual([]);
      expect(calls).toEqual([]);
    }
  });

  it("never passes on or repeats a token the model sends", async () => {
    const { commands, calls } = fakeCommands();
    const tools = await toolsOf(
      configurationTools(commands, { roleOf: roleIn, adminOrigin: `${ADMIN}/` }),
    );
    const token = "123456789:AAH-secret-token";
    const { context, asked, links } = contextOf(false);
    const input = { agentId: MASTER, botToken: token };

    const done = await run(tools, "connect_telegram", input, context);
    expect(JSON.stringify([done, asked, links, calls])).not.toContain("secret");
    expect(links.map((link) => link.href)).toEqual([`${ADMIN}/forms/tok123?lang=en`]);
  });
});

// The host's side of the gate (ADR-0013): the code reaches only the owner, and only their own
// later message with it confirms exactly the change it was shown for, once.

const agent = (name: string) => env.CONVERSATION_AGENT.getByName(name);
// The gate is the same on every channel; Telegram sends through the egress port the fakes record.
const destination = { channel: "telegram", threadId: "chat-1" } as const;

function message(id: string, text: string, userId = "u-owner") {
  return {
    agentId: MASTER,
    providerMessageId: id,
    userId,
    text,
    destination,
    sentAt: Date.UTC(2026, 9, 6, 18),
    timeZone: null,
  };
}

/** A provider with one tool, `change`, gated on its input: it logs what ran. */
function gated(world: FakeWorld) {
  const ran: unknown[] = [];
  world.tools = [
    {
      async tools() {
        return [
          {
            spec: {
              name: "change",
              description: "Change.",
              inputSchema: { type: "object" as const },
            },
            label: "Changing",
            async run(input: unknown, context: ToolContext) {
              const confirmed = await context.confirm({
                command: "change",
                input,
                summary: `change the thing to ${JSON.stringify(input)}.`,
              });
              if (!confirmed) return { output: "Not done yet." };
              ran.push(input);
              return { output: "Done." };
            },
          },
          {
            spec: { name: "echo", description: "Echo.", inputSchema: { type: "object" as const } },
            label: "Echoing",
            async run(input: unknown) {
              return { output: JSON.stringify(input) };
            },
          },
        ];
      },
    },
  ];
  return ran;
}

/** A provider with one tool, `form`, that has Kelpie send `link` (#186). */
function linking(link: HostLink): ToolProvider {
  return {
    async tools() {
      return [
        {
          spec: { name: "form", description: "Form.", inputSchema: { type: "object" as const } },
          label: "Opening a form",
          async run(_input: unknown, context: ToolContext) {
            context.sendLink(link);
            return { output: "Kelpie sends the link." };
          },
        },
      ];
    },
  };
}

function use(world: FakeWorld): FakeWorld {
  replacePortsForTesting(world.ports);
  return world;
}

/** The owner's own message in a direct chat, which Master's configuration tools need. */
const FROM_OWNER = { role: "owner", chatType: "direct" } as const;

async function turn(
  stub: ReturnType<typeof agent>,
  world: FakeWorld,
  id: string,
  text: string,
  from: Partial<typeof FROM_OWNER> = {},
) {
  const before = (await stub.turns()).length;
  await stub.ingest({ ...message(id, text), ...from });
  await stub.flush();
  await vi.waitFor(async () => {
    const turns = await stub.turns();
    expect(turns).toHaveLength(before + 1);
    expect(turns.at(-1)?.status).not.toBe("running");
  });
  return world;
}

/** A confirmation's notice, in any of Kelpie's languages (#187): its summary, then its code. */
const NOTICE = /^(?:Confirm|Confirme|Confirma): (.+)\n.*\b(?:code|código) ([A-Z0-9]{6})\. [^\n]*$/s;

/** The codes shown so far, in order. */
const codes = (world: FakeWorld) =>
  world.sent.flatMap((text) => {
    const code = NOTICE.exec(text)?.[2];
    return code === undefined ? [] : [code];
  });

const historyOf = (stub: ReturnType<typeof agent>) =>
  runInDurableObject(stub, (instance: ConversationAgent) => instance.history());

afterEach(() => {
  replacePortsForTesting(undefined);
  vi.restoreAllMocks();
});

describe("confirmation helpers", () => {
  it("compares inputs whatever their keys' order", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { f: 1, e: 0 }], c: 2 } })).toBe(
      '{"a":{"c":2,"d":[2,{"e":0,"f":1}]},"b":1}',
    );
    expect(canonicalJson(undefined)).toBe("null");
  });

  it("shows every invisible or control character in a notice", () => {
    const [rlo, tag, separator] = [0x202e, 0xe0041, 0x2028].map((point) =>
      String.fromCodePoint(point),
    );
    const notice = confirmationNotice(`rename "A${rlo}b" to "c${tag}d${separator}e"`, "K7MPRX");
    expect(notice).toContain("A\\u{202E}b");
    expect(notice).toContain("c\\u{E0041}d\\u{2028}e");
    for (const hidden of [rlo, tag, separator]) expect(notice).not.toContain(hidden);

    // Default-ignorable characters that aren't controls: variation selectors, a Hangul filler.
    const ignorable = [0xfe0f, 0xe0100, 0x3164].map((point) => String.fromCodePoint(point));
    const shown = confirmationNotice(`prompt "ok${ignorable.join("")}"`, "K7MPRX");
    expect(shown).toContain("ok\\u{FE0F}\\u{E0100}\\u{3164}");
    for (const hidden of ignorable) expect(shown).not.toContain(hidden);
  });

  it("takes only the code alone on a line, in plain letters and digits", () => {
    expect(confirmsCode("ok\n  k7mprx. ", "K7MPRX")).toBe(true);
    expect(confirmsCode("[Tue 6 Oct 2026, 18:00, UTC] K7MPRX", "K7MPRX")).toBe(true);
    // "ﬀ" uppercases to "FF", which the code's letters could spell.
    const ligature = String.fromCodePoint(0xfb00);
    for (const text of [
      "não faça K7MPRX",
      "K7MPRX?",
      `A${ligature}C34`,
      `${"!".repeat(20_000)}x K7MPRX`,
    ]) {
      expect(
        confirmsCode(text, text.includes(ligature) ? "AFFC34" : "K7MPRX"),
        text.slice(0, 20),
      ).toBe(false);
    }
  });
});

describe("the confirmation gate", () => {
  it("shows the owner the change and a code after the reply, and keeps the code from the model", async () => {
    const world = use(
      fakeWorld([
        toolCalls({ name: "change", input: { to: "smart" } }),
        reply("Confirme, por favor."),
      ]),
    );
    const ran = gated(world);
    const stub = agent("gate-notice");
    await turn(stub, world, "m1", "mude para smart");

    expect(world.sent).toHaveLength(2);
    expect(world.sent[0]).toBe("Confirme, por favor.");
    expect(NOTICE.exec(world.sent[1] ?? "")?.[1]).toBe('change the thing to {"to":"smart"}.');
    // In the conversation's language, Portuguese here (#187).
    expect(world.sent[1]).toBe(
      `Confirme: change the thing to {"to":"smart"}.\nPara seguir, responda só com o código ${codes(world)[0]}. Expira em 10 minutos.`,
    );
    // The notice comes last, and it is the bubble that notifies. The reply is formatted (#188);
    // the notice, Kelpie's own text, goes as written.
    expect(world.sends.map((send) => send.silent)).toEqual([true, false]);
    expect(world.sends.map((send) => send.links)).toEqual([[], undefined]);
    expect(ran).toEqual([]);
    const [code = ""] = codes(world);
    // Neither a request, history nor the outbox's inspection holds the code.
    expect(JSON.stringify(world.requests)).not.toContain(code);
    expect(JSON.stringify(await historyOf(stub))).not.toContain(code);
    expect(JSON.stringify(await stub.outbox())).not.toContain(code);
    // The reply is kept whole, and the turn counts as delivered.
    expect((await stub.turns()).at(-1)?.status).toBe("delivered");
  });

  it("runs the change once the owner replies with just its code, and only once", async () => {
    const scripts = [toolCalls({ name: "change", input: { to: "smart" } }), reply("Confirme.")];
    const world = use(fakeWorld(scripts));
    const ran = gated(world);
    const stub = agent("gate-confirms");
    await turn(stub, world, "m1", "mude para smart");
    const [code = ""] = codes(world);

    // A message that mentions the code without being it is no yes.
    scripts.push(toolCalls({ name: "change", input: { to: "smart" } }), reply("Hm."));
    await turn(stub, world, "m2", `não, não faça ${code}`);
    expect(ran).toEqual([]);

    scripts.push(
      toolCalls({ name: "change", input: { to: "smart" } }),
      reply("Feito."),
      toolCalls({ name: "change", input: { to: "smart" } }),
      reply("Confirme de novo."),
    );
    await turn(stub, world, "m3", `ok\n  ${code.toLowerCase()}.`);
    expect(ran).toEqual([{ to: "smart" }]);
    expect(world.sent.at(-1)).toBe("Feito.");

    // The code is spent: the same change asks again, with a new code.
    await turn(stub, world, "m4", "de novo");
    expect(ran).toEqual([{ to: "smart" }]);
    const shown = codes(world);
    expect(shown.slice(0, 2)).toEqual([code, code]);
    expect(shown[2]).toMatch(/^[A-Z0-9]{6}$/);
    expect(shown[2]).not.toBe(code);
    expect(scripts).toEqual([]);
  });

  it("shows each change a turn asks for with a code of its own", async () => {
    const world = use(
      fakeWorld([
        toolCalls(
          { name: "change", input: { to: "smart" } },
          { name: "change", input: { to: "frontier" } },
        ),
        reply("Confirme as duas."),
      ]),
    );
    gated(world);
    const stub = agent("gate-two");
    await turn(stub, world, "m1", "mude tudo");

    expect(world.sent.map((text) => NOTICE.exec(text)?.[1] ?? text)).toEqual([
      "Confirme as duas.",
      'change the thing to {"to":"smart"}.',
      'change the thing to {"to":"frontier"}.',
    ]);
    const [first, second] = codes(world);
    expect(first).not.toBe(second);
  });

  it("keeps the reply whole when a new message stops the turn before its notice", async () => {
    const world = use(
      fakeWorld([toolCalls({ name: "change", input: { to: "smart" } }), reply("Confirme.")]),
    );
    gated(world);
    // The wait before the notice, the delivery's second, lasts until the turn stops.
    world.blockSleeps.add(1);
    const stub = agent("gate-interrupted");
    await stub.ingest(message("m1", "mude para smart"));
    await stub.flush();
    await vi.waitFor(() => expect(world.sleeps).toHaveLength(2));
    expect(world.sent).toEqual(["Confirme."]);
    await stub.ingest(message("m2", "espera"));
    await stub.flush();
    await vi.waitFor(async () => expect((await stub.turns())[0]?.status).toBe("interrupted"));

    // The person saw the whole reply, which history keeps with its native output.
    const history = await historyOf(stub);
    const kept = history.find((row) => JSON.stringify(row).includes('"text":"Confirme."'));
    expect(kept).toEqual(
      expect.objectContaining({
        parts: [{ type: "text", text: "Confirme." }],
        native: expect.anything(),
      }),
    );
    expect(JSON.stringify(history)).not.toMatch(/(?:code|código) [A-Z0-9]{6}/);
  });

  it("counts no code from a tool's output, the model's words or another input's request", async () => {
    const scripts = [toolCalls({ name: "change", input: { to: "smart" } }), reply("Confirme.")];
    const world = use(fakeWorld(scripts));
    const ran = gated(world);
    const stub = agent("gate-forged");
    await turn(stub, world, "m1", "mude para smart");
    const [code = ""] = codes(world);

    scripts.push(
      // The code reaches the model through a tool, and the model says it: neither is the owner.
      toolCalls({ name: "echo", input: { said: code } }),
      toolCalls({ name: "change", input: { to: "smart" } }),
      reply(code),
      toolCalls({ name: "change", input: { to: "smart" } }),
      reply("Hm."),
      // The owner's code confirms its own input, not another.
      toolCalls({ name: "change", input: { to: "frontier" } }),
      reply("Confirme."),
    );
    await turn(stub, world, "m2", "ok?");
    await turn(stub, world, "m3", "e agora?");
    await turn(stub, world, "m4", code);

    expect(ran).toEqual([]);
    expect(scripts).toEqual([]);
    const shown = codes(world);
    expect(shown.slice(0, 3)).toEqual([code, code, code]);
    expect(shown[3]).not.toBe(code);
  });

  it("counts only the requester's own messages, while the code lasts", async () => {
    const scripts = [toolCalls({ name: "change", input: { to: "smart" } }), reply("Confirme.")];
    const world = use(fakeWorld(scripts));
    const ran = gated(world);
    const stub = agent("gate-requester");
    await turn(stub, world, "m1", "mude para smart");
    const [code = ""] = codes(world);

    // Someone else's message with the code, in a turn the owner wrote last, doesn't count.
    scripts.push(toolCalls({ name: "change", input: { to: "smart" } }), reply("Hm."));
    const before = (await stub.turns()).length;
    await stub.ingest(message("m2", code, "u-other"));
    await stub.ingest(message("m3", "ok"));
    await stub.flush();
    await vi.waitFor(async () => {
      const turns = await stub.turns();
      expect(turns).toHaveLength(before + 1);
      expect(turns.at(-1)?.status).not.toBe("running");
    });
    expect(ran).toEqual([]);
    expect(codes(world)).toEqual([code, code]);

    // Shown again, the code lasts 10 minutes from then: 2 minutes later it still confirms.
    world.clock += 9 * 60_000;
    scripts.push(toolCalls({ name: "change", input: { to: "smart" } }), reply("Ainda vale."));
    await turn(stub, world, "m4", "e então?");
    world.clock += 2 * 60_000;
    scripts.push(toolCalls({ name: "change", input: { to: "smart" } }), reply("Feito."));
    await turn(stub, world, "m5", code);
    expect(ran).toEqual([{ to: "smart" }]);

    // Past its 10 minutes, a code doesn't confirm.
    scripts.push(toolCalls({ name: "change", input: { to: "frontier" } }), reply("Confirme."));
    await turn(stub, world, "m6", "agora frontier");
    const latest = codes(world).at(-1) ?? "";
    world.clock += 10 * 60_000 + 1;
    scripts.push(toolCalls({ name: "change", input: { to: "frontier" } }), reply("Expirou."));
    await turn(stub, world, "m7", latest);
    expect(ran).toEqual([{ to: "smart" }]);
    expect(scripts).toEqual([]);
  });
  it("sends a tool's link after the reply, as Kelpie's own bubble with only that link, kept from the model (#186)", async () => {
    const href = "https://admin.example/forms/tok-9";
    // Asked twice in a turn, the same link goes once.
    const world = use(
      fakeWorld([toolCalls({ name: "form" }, { name: "form" }), reply("Abra o link abaixo.")]),
    );
    world.tools = [linking({ href, text: `The secure form: ${href}\nIt works once.` })];
    const stub = agent("link-sent");
    await turn(stub, world, "m1", "conecta o bot");

    expect(world.sends).toEqual([
      { text: "Abra o link abaixo.", silent: true, links: [] },
      { text: `The secure form: ${href}\nIt works once.`, silent: false, links: [href] },
    ]);
    expect((await stub.turns()).at(-1)?.status).toBe("delivered");
    // Neither a request, history nor the outbox's inspection holds the link.
    expect(JSON.stringify(world.requests)).not.toContain("tok-9");
    expect(JSON.stringify(await historyOf(stub))).not.toContain("tok-9");
    expect(JSON.stringify(await stub.outbox())).not.toContain("tok-9");
  });

  it("lets a tool fail rather than send a link that isn't an admin page in its text (#186)", async () => {
    for (const link of [
      { href: "https://evil.example/forms/x", text: "Form: https://evil.example/forms/x" },
      { href: "https://admin.example/forms/x", text: "Form: https://admin.example/forms/y" },
    ]) {
      const world = use(fakeWorld([toolCalls({ name: "form" }), reply("Não deu.")]));
      world.tools = [linking(link)];
      const stub = agent(`link-refused-${link.text.at(-1)}`);
      await turn(stub, world, "m1", "conecta o bot");

      expect(world.sent).toEqual(["Não deu."]);
      expect(JSON.stringify(world.requests.at(-1)?.messages)).toContain("The tool failed.");
    }
  });

  it("lets a tool fail rather than show the owner a notice too long for one message", async () => {
    const world = use(fakeWorld([toolCalls({ name: "huge" }), reply("Não deu.")]));
    world.tools = [
      {
        async tools() {
          return [
            {
              spec: {
                name: "huge",
                description: "Huge.",
                inputSchema: { type: "object" as const },
              },
              label: "Changing",
              async run(input: unknown, context: ToolContext) {
                await context.confirm({ command: "huge", input, summary: "x".repeat(3_501) });
                return { output: "Not done yet." };
              },
            },
          ];
        },
      },
    ];
    const stub = agent("gate-too-long");
    await turn(stub, world, "m1", "faça");

    expect(world.sent).toEqual(["Não deu."]);
    expect(JSON.stringify(world.requests.at(-1)?.messages)).toContain("The tool failed.");
  });

  it("sends no link from a call that ran out of the turn's time (#186)", async () => {
    const href = "https://admin.example/forms/late";
    const world = use(fakeWorld([toolCalls({ name: "form" }), held("Acabou o tempo.")]));
    world.tools = [
      {
        async tools() {
          return [
            {
              spec: {
                name: "form",
                description: "Form.",
                inputSchema: { type: "object" as const },
              },
              label: "Opening a form",
              async run(_input: unknown, context: ToolContext) {
                // A tool that ignores its signal, and sends its link only after its time is up.
                await new Promise((resolve) => setTimeout(resolve, 50));
                context.sendLink({ href, text: `The secure form: ${href}` });
                return { output: "Kelpie sends the link." };
              },
            },
          ];
        },
      },
    ];
    // The turn's last call waits meanwhile, so the turn is still running when the tool sends.
    world.expireDeadlines = true;
    world.modelHeld = true;
    const stub = agent("link-timed-out");
    await stub.ingest(message("m1", "conecta o bot"));
    await stub.flush();
    await new Promise((resolve) => setTimeout(resolve, 200));
    world.modelHeld = false;
    await vi.waitFor(async () => expect((await stub.turns()).at(-1)?.status).not.toBe("running"));

    expect(world.sent).toEqual(["Acabou o tempo."]);
  });

  it("keeps a code unspent when the call that would use it ran out of the turn's time", async () => {
    const scripts = [toolCalls({ name: "slow", input: { to: "smart" } }), reply("Confirme.")];
    const world = use(fakeWorld(scripts));
    const ran: unknown[] = [];
    world.tools = [
      {
        async tools() {
          return [
            {
              spec: {
                name: "slow",
                description: "Slow.",
                inputSchema: { type: "object" as const },
              },
              label: "Changing",
              async run(input: unknown, context: ToolContext) {
                // A tool that ignores its signal, and asks only after its time is up.
                if (world.expireDeadlines) await new Promise((resolve) => setTimeout(resolve, 50));
                const summary = `change the thing to ${JSON.stringify(input)}.`;
                if (!(await context.confirm({ command: "slow", input, summary }))) {
                  return { output: "Not done yet." };
                }
                ran.push(input);
                return { output: "Done." };
              },
            },
          ];
        },
      },
    ];
    const stub = agent("gate-timed-out");
    await turn(stub, world, "m1", "mude para smart");
    const [code = ""] = codes(world);

    // The owner confirms, but the call that would use the code times out; the turn's last call
    // waits meanwhile, so the turn is still running when the abandoned tool asks.
    world.expireDeadlines = true;
    world.modelHeld = true;
    scripts.push(toolCalls({ name: "slow", input: { to: "smart" } }), held("Acabou o tempo."));
    await stub.ingest(message("m2", code));
    await stub.flush();
    await new Promise((resolve) => setTimeout(resolve, 200));
    world.modelHeld = false;
    await vi.waitFor(async () => expect((await stub.turns()).at(-1)?.status).not.toBe("running"));
    expect(ran).toEqual([]);

    // The code is still the owner's yes for the next call.
    world.expireDeadlines = false;
    scripts.push(toolCalls({ name: "slow", input: { to: "smart" } }), reply("Feito."));
    await turn(stub, world, "m3", "tenta de novo");
    expect(ran).toEqual([{ to: "smart" }]);
  });
});

// Kelpie's fixed texts follow the conversation (#187): what the person writes, else their device's
// language, else English.
describe("the conversation's language", () => {
  async function noticeFor(name: string, text: string, language?: string) {
    const world = use(
      fakeWorld([toolCalls({ name: "change", input: { to: "smart" } }), reply("…")]),
    );
    gated(world);
    const stub = agent(name);
    await stub.ingest({ ...message("m1", text), ...(language === undefined ? {} : { language }) });
    await stub.flush();
    await vi.waitFor(() => expect(world.sent).toHaveLength(2));
    return world.sent[1] ?? "";
  }

  it("follows what the person writes, else their device, else English", async () => {
    expect(await noticeFor("lang-es", "hola, cambia el modelo")).toMatch(
      /^Confirma: .+\nPara seguir, responde solo con el código [A-Z0-9]{6}\. Expira en 10 minutos\.$/s,
    );
    expect(await noticeFor("lang-device", "ok", "es-MX")).toMatch(/^Confirma: /);
    expect(await noticeFor("lang-text-first", "quero mudar o modelo", "en-US")).toMatch(
      /^Confirme: /,
    );
    for (const [name, language] of [
      ["lang-other", "fr-FR"],
      ["lang-none", undefined],
    ] as const) {
      expect(await noticeFor(name, "ok", language)).toMatch(
        /^Confirm: .+\nTo go ahead, reply with just the code [A-Z0-9]{6}\. It expires in 10 minutes\.$/s,
      );
    }
  });

  it("keeps the language while the person's messages say nothing clear", async () => {
    const scripts = [toolCalls({ name: "change", input: { to: "smart" } }), reply("Confirme.")];
    const world = use(fakeWorld(scripts));
    gated(world);
    const stub = agent("lang-kept");
    await turn(stub, world, "m1", "mude para smart");
    // More unclear messages than the window holds: the language read before stays.
    scripts.push(toolCalls({ name: "change", input: { to: "frontier" } }), reply("Ok."));
    const before = (await stub.turns()).length;
    for (const id of ["m2", "m3", "m4", "m5", "m6", "m7"]) await stub.ingest(message(id, "ok"));
    await stub.flush();
    await vi.waitFor(async () => {
      const turns = await stub.turns();
      expect(turns).toHaveLength(before + 1);
      expect(turns.at(-1)?.status).not.toBe("running");
    });
    expect(
      world.sent.filter((text) => NOTICE.test(text)).map((text) => text.split(":")[0]),
    ).toEqual(["Confirme", "Confirme"]);
  });

  it("switches at once when the person clearly writes in another language", async () => {
    const scripts = [toolCalls({ name: "change", input: { to: "smart" } }), reply("Confirme.")];
    const world = use(fakeWorld(scripts));
    gated(world);
    const stub = agent("lang-switch");
    await turn(stub, world, "m1", "mude para smart, por favor, eu quero isso agora");
    scripts.push(toolCalls({ name: "change", input: { to: "frontier" } }), reply("Sure."));
    await turn(stub, world, "m2", "please change it to frontier instead");
    expect(
      world.sent.filter((text) => NOTICE.test(text)).map((text) => text.split(":")[0]),
    ).toEqual(["Confirme", "Confirm"]);
  });
});

// Kelpie's notice of the agents Master creates or renames (#387): other agents' text reaches
// Master's conversation, so Kelpie, not the model, tells the owner each change ADR-0013 lets run
// without a yes.

describe("Kelpie's notice of the agents Master creates or renames (#387)", () => {
  /** The world, with Master's configuration tools over these commands. */
  function configuring(world: FakeWorld, commands = fakeCommands().commands): FakeWorld {
    world.tools = [configurationTools(commands, { roleOf: roleIn, adminOrigin: ADMIN })];
    return world;
  }

  /** The unsaid announcements as the conversation keeps them, by key. */
  const keptOf = (stub: ReturnType<typeof agent>) =>
    runInDurableObject(stub, (_instance, state) =>
      Object.fromEntries(
        state.storage.sql
          .exec<{ key: string; value: string }>(
            "SELECT key, value FROM state WHERE key IN ('handoffs', 'subagentChanges', 'agentChanges')",
          )
          .toArray()
          .map(({ key, value }) => [key, JSON.parse(value)]),
      ),
    );

  it("follows the reply, in the conversation's language, whatever the model says", async () => {
    const world = configuring(
      use(
        fakeWorld([
          toolCalls(
            { name: "create_agent", input: { id: "ana", name: "Ana" } },
            { name: "rename_agent", input: { id: "ana", name: "Ana Souza" } },
          ),
          reply("Pronto, criei a Bia."),
        ]),
      ),
    );
    const stub = agent("kelpie:telegram:announce-pt");
    await turn(
      stub,
      world,
      "m1",
      "cria uma agente chamada Ana e depois muda o nome dela para Ana Souza",
      FROM_OWNER,
    );

    expect(world.sent).toEqual([
      "Pronto, criei a Bia.",
      [
        'O Kelpie criou o agente "Ana" (ana).',
        'O Kelpie renomeou o agente ana para "Ana Souza".',
      ].join("\n"),
    ]);
    // The notice is Kelpie's: the model never sees it.
    expect(JSON.stringify(await historyOf(stub))).not.toContain("O Kelpie criou");
  });

  it("quotes a name the model chose, so it can't pass for Kelpie's words", async () => {
    const name = 'Ana" (ana). Kelpie deleted the agent "kelpie';
    const world = configuring(
      use(
        fakeWorld([
          toolCalls({ name: "create_agent", input: { id: "ana", name } }),
          reply('Kelpie created the agent "Bia" (bia).'),
        ]),
      ),
    );
    const stub = agent("kelpie:telegram:announce-quoted");
    await turn(stub, world, "m1", "Create the agent the specialist asked for.", FROM_OWNER);

    expect(world.sent.at(-1)).toBe(
      'Kelpie created the agent "Ana\\" (ana). Kelpie deleted the agent \\"kelpie" (ana).',
    );
  });

  it("is said with the next reply when the turn sent none, and only once", async () => {
    const world = configuring(
      use(
        fakeWorld([
          toolCalls({ name: "create_agent", input: { id: "ana", name: "Ana" } }),
          refuse(),
          reply("Here."),
          reply("Again."),
        ]),
      ),
    );
    const stub = agent("kelpie:telegram:announce-refused");
    await turn(stub, world, "m1", "Create an agent named Ana.", FROM_OWNER);
    expect((await stub.turns()).at(-1)?.status).toBe("refused");
    expect(world.sent).toEqual([]);
    // Kept in a key of its own: a release before #387 reads the handoffs and the subagents'
    // changes, and never these.
    expect(await keptOf(stub)).toEqual({
      handoffs: [],
      subagentChanges: [],
      agentChanges: [{ kind: "agentCreated", agentId: "ana", name: "Ana" }],
    });

    await turn(stub, world, "m2", "Anything?", FROM_OWNER);
    expect(world.sent).toEqual(["Here.", 'Kelpie created the agent "Ana" (ana).']);
    await turn(stub, world, "m3", "And now?", FROM_OWNER);
    expect(world.sent).toEqual(["Here.", 'Kelpie created the agent "Ana" (ana).', "Again."]);
  });

  it("keeps every agent's change past the cap on other news, and counts what it doesn't name", async () => {
    const ids = Array.from({ length: 25 }, (_, n) => `a${String(n + 1).padStart(2, "0")}`);
    const world = configuring(
      use(
        fakeWorld([
          toolCalls(...ids.map((id) => ({ name: "create_agent", input: { id, name: id } }))),
          reply("Done."),
        ]),
      ),
    );
    const stub = agent("kelpie:telegram:announce-many");
    await turn(stub, world, "m1", "Create the agents a01 to a25.", FROM_OWNER);

    // More than the 20 a conversation keeps of other news, and the first is still counted.
    expect(world.sent).toEqual([
      "Done.",
      "Kelpie created the agents a01, a02, a03, a04 and 21 more.",
    ]);
  });

  it("cuts only the handoffs past the cap, and keeps each group in its own key", async () => {
    const world = use(fakeWorld([toolCalls({ name: "burst" }), refuse(), reply("Here.")]));
    // A turn whose tools hand off more tasks than the cap, between an agent's creation and rename.
    world.tools = [
      {
        async tools() {
          return [
            {
              spec: { name: "burst", description: "x", inputSchema: { type: "object" as const } },
              label: "Bursting",
              async run(_input: unknown, context: ToolContext) {
                context.announce({ kind: "agentCreated", agentId: "ana", name: "Ana" });
                for (let n = 1; n <= 22; n++) {
                  const handoff = { taskId: `t${n}`, agentId: "sales", name: "Sales" };
                  context.announce({ kind: "handoff", ...handoff });
                }
                context.announce({ kind: "agentRenamed", agentId: "ana", name: "Ana Souza" });
                return { output: "ok" };
              },
            },
          ];
        },
      },
    ];
    const stub = agent("kelpie:telegram:announce-mixed");
    await turn(stub, world, "m1", "Go.", FROM_OWNER);

    const kept = await keptOf(stub);
    expect(kept.handoffs.map(({ taskId }: { taskId: string }) => taskId)).toEqual(
      Array.from({ length: 20 }, (_, n) => `t${n + 3}`),
    );
    expect(kept.subagentChanges).toEqual([]);
    expect(kept.agentChanges).toEqual([
      { kind: "agentCreated", agentId: "ana", name: "Ana" },
      { kind: "agentRenamed", agentId: "ana", name: "Ana Souza" },
    ]);

    await turn(stub, world, "m2", "Well?", FROM_OWNER);
    expect(world.sent).toEqual([
      "Here.",
      [
        'Kelpie created the agent "Ana" (ana).',
        'Kelpie renamed the agent ana to "Ana Souza".',
        'Kelpie handed tasks to "Sales" (sales).',
      ].join("\n"),
    ]);
  });

  it("names an agent's latest name, and a rename that came while a notice went out next", async () => {
    const { commands, agents } = fakeCommands();
    agents.set("ana", "Ana");
    const world = configuring(
      use(
        fakeWorld([
          toolCalls({ name: "rename_agent", input: { id: "ana", name: "Ana B" } }),
          toolCalls({ name: "rename_agent", input: { id: "ana", name: "Ana C" } }),
          reply("Done."),
          reply("Hi."),
        ]),
      ),
      commands,
    );
    const stub = agent("kelpie:telegram:announce-renamed");
    await turn(stub, world, "m1", "Rename Ana twice.", FROM_OWNER);
    expect(world.sent).toEqual(["Done.", 'Kelpie renamed the agent ana to "Ana C".']);

    // A late call renamed it again while that notice went out: its marker names "Ana C" only.
    const [first] = await stub.turns();
    await runInDurableObject(stub, (_instance, state) => {
      const put = (key: string, value: unknown) =>
        state.storage.sql.exec(
          "INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          key,
          JSON.stringify(value),
        );
      put("agentChanges", [{ kind: "agentRenamed", agentId: "ana", name: "Ana D" }]);
      // The marker as the notice wrote it, with the keys of what it named.
      const named: Announcement = { kind: "agentRenamed", agentId: "ana", name: "Ana C" };
      put("handoffNotice", { turnId: first?.id, seq: 1, taskIds: [keyOf(named)] });
    });
    await turn(stub, world, "m2", "Well?", FROM_OWNER);
    expect(world.sent.slice(-2)).toEqual(["Hi.", 'Kelpie renamed the agent ana to "Ana D".']);
  });
});
