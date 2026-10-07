import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type Actor, DEFAULT_SETTINGS, SETUP_AGENT_ID } from "@kelpie/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationAgent } from "../src/conversation-agent.ts";
import { replacePortsForTesting } from "../src/ports.ts";
import { type SetupCommands, setupTools } from "../src/setup-agent.ts";
import type { ConfirmationRequest, Tool, ToolContext, ToolProvider } from "../src/tools.ts";
import { type FakeWorld, fakeWorld, reply, toolCalls } from "./fakes.ts";

// The setup agent's tools (Story 3.11): the configuration commands, owner-only, and the changes to
// access, cost or external accounts only after the owner's confirmation (ADR-0013), which the host
// gates in code.

const ADMIN = "https://admin.example.com";
const owner: Actor = { userId: "u-owner", role: "owner", via: `agent:${SETUP_AGENT_ID}` };

/** Commands over an in-memory registry; every call is logged. */
function fakeCommands() {
  const agents = new Map<string, string>([[SETUP_AGENT_ID, "Setup"]]);
  const calls: string[] = [];
  const forbidden = { ok: false, reason: "forbidden" } as const;
  const commands: SetupCommands = {
    async listAgents(actor) {
      if (actor.role !== "owner") return forbidden;
      return { ok: true, value: [...agents].map(([id, name]) => ({ id, name })) };
    },
    async getAgent(actor, input) {
      if (actor.role !== "owner") return forbidden;
      const { id } = input as { id: string };
      const name = agents.get(id);
      if (name === undefined) return { ok: false, reason: "unknown_agent" };
      return { ok: true, value: { id, name, settings: DEFAULT_SETTINGS, promptVersion: 0 } };
    },
    async createAgent(actor, input) {
      calls.push(`createAgent ${JSON.stringify(input)}`);
      if (actor.role !== "owner") return forbidden;
      const { id, name } = input as { id: string; name: string };
      if (id === SETUP_AGENT_ID) return { ok: false, reason: "invalid_input" };
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
      const { settings } = input as { settings: object };
      return {
        ok: true,
        value: { settings: { ...DEFAULT_SETTINGS, ...settings }, promptVersion: 1 },
      };
    },
    async connectTelegram(actor, input) {
      calls.push(`connectTelegram ${JSON.stringify(input)}`);
      if (actor.role !== "owner") return forbidden;
      return { ok: true, value: { path: "/forms/tok123", expiresAt: Date.UTC(2026, 9, 6, 20) } };
    },
  };
  return { commands, agents, calls };
}

/** A context whose `confirm` answers `confirmed`, and logs what it was asked. */
function contextOf(confirmed: boolean, actor: Actor = owner) {
  const asked: ConfirmationRequest[] = [];
  const context: ToolContext = {
    actor,
    agentId: SETUP_AGENT_ID,
    scopes: "all",
    qualifier: "clef",
    turn: "1",
    source: "webchat:u-owner, 2026-10-06",
    signal: new AbortController().signal,
    async confirm(request) {
      asked.push(request);
      return confirmed;
    },
  };
  return { context, asked };
}

async function toolsOf(provider: ToolProvider, agentId = SETUP_AGENT_ID) {
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

describe("the setup agent's tools", () => {
  it("are the setup agent's only, with plain labels and no identity or vault commands", async () => {
    const provider = setupTools(fakeCommands().commands, { adminOrigin: ADMIN });
    expect(await provider.tools("assistant")).toEqual([]);

    const tools = await toolsOf(provider);
    expect([...tools.keys()]).toEqual([
      "list_agents",
      "get_agent",
      "create_agent",
      "rename_agent",
      "configure_agent",
      "connect_telegram",
      "pair_telegram",
    ]);
    for (const tool of tools.values()) {
      expect(tool.label).toMatch(/^[A-Z][a-z]/);
      expect(tool.spec.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    }
  });

  it("lists, creates and renames agents directly", async () => {
    const { commands, calls } = fakeCommands();
    const tools = await toolsOf(setupTools(commands, { adminOrigin: ADMIN }));
    const { context, asked } = contextOf(false);

    expect(
      (await run(tools, "create_agent", { id: "ana", name: "Ana" }, context)).output,
    ).toContain("ana");
    expect(
      (await run(tools, "rename_agent", { id: "ana", name: "Ana Souza" }, context)).isError,
    ).toBe(undefined);
    const listed = await run(tools, "list_agents", {}, context);
    expect(listed.output).toContain("ana: Ana Souza");
    expect(listed.output).toContain(`${SETUP_AGENT_ID}: Setup`);
    expect(asked).toEqual([]);
    expect(calls).toEqual([
      'createAgent {"id":"ana","name":"Ana"}',
      'renameAgent {"id":"ana","name":"Ana Souza"}',
    ]);
  });

  it("answers what went wrong in words the model can act on", async () => {
    const tools = await toolsOf(setupTools(fakeCommands().commands, { adminOrigin: ADMIN }));
    const { context } = contextOf(true);

    const reserved = await run(
      tools,
      "create_agent",
      { id: SETUP_AGENT_ID, name: "Mine" },
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
    const tools = await toolsOf(setupTools(commands, { adminOrigin: ADMIN }));
    const { context, asked } = contextOf(true, { ...owner, role: "member" });

    for (const [name, input] of [
      ["configure_agent", { id: SETUP_AGENT_ID, settings: { tier: "frontier" } }],
      ["connect_telegram", { agentId: SETUP_AGENT_ID }],
      ["pair_telegram", { agentId: SETUP_AGENT_ID }],
      ["create_agent", { id: "ana", name: "Ana" }],
    ] as const) {
      expect(await run(tools, name, input, context), name).toEqual({
        output: "Only the owner can change Kelpie's configuration.",
        isError: true,
      });
    }
    expect(asked).toEqual([]);
    expect(calls.filter((call) => !call.startsWith("createAgent"))).toEqual([]);
  });

  it("asks the owner to confirm a settings change, for its parsed input, and runs it only then", async () => {
    const { commands, calls } = fakeCommands();
    const tools = await toolsOf(setupTools(commands, { adminOrigin: ADMIN }));
    const input = { id: SETUP_AGENT_ID, settings: { tier: "frontier", quietMs: 2_000 } };

    const waiting = contextOf(false);
    const asked = await run(tools, "configure_agent", input, waiting.context);
    expect(asked.output).toMatch(/^Not done yet: Kelpie showed the owner this change/);
    expect(waiting.asked).toEqual([
      {
        command: "configureAgent",
        input: { id: SETUP_AGENT_ID, settings: { tier: "frontier", quietMs: 2_000 } },
        summary: `change the settings of the agent "Setup" (${SETUP_AGENT_ID}): tier to "frontier", quietMs to 2000.`,
      },
    ]);
    expect(calls).toEqual([]);

    const confirmed = contextOf(true);
    expect((await run(tools, "configure_agent", input, confirmed.context)).isError).toBe(undefined);
    expect(calls).toEqual([
      `configureAgent {"id":"${SETUP_AGENT_ID}","settings":{"tier":"frontier","quietMs":2000}}`,
    ]);
  });

  it("refuses settings it can't show the owner whole, before asking", async () => {
    const tools = await toolsOf(setupTools(fakeCommands().commands, { adminOrigin: ADMIN }));
    const { context, asked } = contextOf(true);

    for (const settings of [{}, { tier: "huge" }, { systemPrompt: "x".repeat(4_001) }, "smart"]) {
      expect(
        await run(tools, "configure_agent", { id: SETUP_AGENT_ID, settings }, context),
      ).toMatchObject({ isError: true });
    }
    expect(asked).toEqual([]);
  });

  it("gives the secure form's link only once the owner confirmed connecting a bot", async () => {
    const { commands, calls } = fakeCommands();
    const tools = await toolsOf(setupTools(commands, { adminOrigin: ADMIN }));

    const waiting = contextOf(false);
    const asked = await run(
      tools,
      "connect_telegram",
      { agentId: SETUP_AGENT_ID },
      waiting.context,
    );
    expect(asked.output).not.toContain("/forms/");
    expect(waiting.asked).toEqual([
      {
        command: "connectTelegram",
        input: { agentId: SETUP_AGENT_ID },
        summary: `connect a Telegram bot to the agent "Setup" (${SETUP_AGENT_ID}), through a one-time form for its token.`,
      },
    ]);
    expect(calls).toEqual([]);

    const done = await run(
      tools,
      "connect_telegram",
      { agentId: SETUP_AGENT_ID },
      contextOf(true).context,
    );
    expect(done.output).toContain(`${ADMIN}/forms/tok123`);
    expect(done.output).toContain("2026-10-06T20:00:00.000Z");
    expect(calls).toEqual([`connectTelegram {"agentId":"${SETUP_AGENT_ID}"}`]);
  });

  it("links to the admin page that pairs the owner's Telegram account", async () => {
    const tools = await toolsOf(setupTools(fakeCommands().commands, { adminOrigin: ADMIN }));
    const { context, asked } = contextOf(false);

    const linked = await run(tools, "pair_telegram", { agentId: SETUP_AGENT_ID }, context);
    expect(linked.output).toContain(`${ADMIN}/pair/telegram/${SETUP_AGENT_ID}`);
    expect(asked).toEqual([]);
    expect(await run(tools, "pair_telegram", { agentId: "ghost" }, context)).toMatchObject({
      isError: true,
    });
  });

  it("says so, before asking anything, when the admin API's address isn't a bare https origin", async () => {
    for (const adminOrigin of ["", "http://admin.example.com", `${ADMIN}/x`, "admin.example.com"]) {
      const { commands, calls } = fakeCommands();
      const tools = await toolsOf(setupTools(commands, { adminOrigin }));
      const { context, asked } = contextOf(true);

      for (const name of ["connect_telegram", "pair_telegram"]) {
        const answer = await run(tools, name, { agentId: SETUP_AGENT_ID }, context);
        expect(answer.isError, `${name} ${adminOrigin}`).toBe(true);
        expect(answer.output, name).toContain("ADMIN_ORIGIN");
      }
      expect(asked).toEqual([]);
      expect(calls).toEqual([]);
    }
  });

  it("never passes on or repeats a token the model sends", async () => {
    const { commands, calls } = fakeCommands();
    const tools = await toolsOf(setupTools(commands, { adminOrigin: `${ADMIN}/` }));
    const token = "123456789:AAH-secret-token";
    const waiting = contextOf(false);
    const input = { agentId: SETUP_AGENT_ID, botToken: token };

    const asked = await run(tools, "connect_telegram", input, waiting.context);
    const done = await run(tools, "connect_telegram", input, contextOf(true).context);
    expect(JSON.stringify([asked, done, waiting.asked, calls])).not.toContain("secret");
    expect(done.output).toContain(`${ADMIN}/forms/tok123`);
  });
});

// The host's side of the gate (ADR-0013): the code reaches only the owner, and only their own
// later message with it confirms exactly the change it was shown for, once.

const agent = (name: string) => env.CONVERSATION_AGENT.getByName(name);
// The gate is the same on every channel; Telegram sends through the egress port the fakes record.
const destination = { channel: "telegram", threadId: "chat-1" } as const;

function message(id: string, text: string, userId = "u-owner") {
  return {
    agentId: SETUP_AGENT_ID,
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

function use(world: FakeWorld): FakeWorld {
  replacePortsForTesting(world.ports);
  return world;
}

async function turn(stub: ReturnType<typeof agent>, world: FakeWorld, id: string, text: string) {
  const before = (await stub.turns()).length;
  await stub.ingest(message(id, text));
  await stub.flush();
  await vi.waitFor(async () => {
    const turns = await stub.turns();
    expect(turns).toHaveLength(before + 1);
    expect(turns.at(-1)?.status).not.toBe("running");
  });
  return world;
}

const NOTICE =
  /^Confirm: (.+)\nTo go ahead, reply with the code ([A-Z0-9]{6})\. It expires in 10 minutes\.$/s;

/** The codes shown so far, in order. */
const codes = (world: FakeWorld) =>
  world.sent.flatMap((text) => {
    const code = NOTICE.exec(text)?.[2];
    return code === undefined ? [] : [code];
  });

afterEach(() => {
  replacePortsForTesting(undefined);
  vi.restoreAllMocks();
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
    expect(world.sent[1]).toMatch(NOTICE);
    expect(NOTICE.exec(world.sent[1] ?? "")?.[1]).toBe('change the thing to {"to":"smart"}.');
    expect(ran).toEqual([]);
    const [code] = codes(world);
    // Neither a request nor history holds the code: the model can't ask for it in words of its own.
    expect(JSON.stringify(world.requests)).not.toContain(code);
    const history = await runInDurableObject(stub, (instance: ConversationAgent) =>
      instance.history(),
    );
    expect(JSON.stringify(history)).not.toContain(code);
    // The reply is kept whole, and the turn counts as delivered.
    expect((await stub.turns()).at(-1)?.status).toBe("delivered");
  });

  it("runs the change once the owner replies with its code, and only once", async () => {
    const world = use(
      fakeWorld([
        toolCalls({ name: "change", input: { to: "smart" } }),
        reply("Confirme."),
        toolCalls({ name: "change", input: { to: "smart" } }),
        reply("Feito."),
        toolCalls({ name: "change", input: { to: "smart" } }),
        reply("Confirme de novo."),
      ]),
    );
    const ran = gated(world);
    const stub = agent("gate-confirms");
    await turn(stub, world, "m1", "mude para smart");
    const [code] = codes(world);
    await turn(stub, world, "m2", `confirmo ${code?.toLowerCase()}`);
    expect(ran).toEqual([{ to: "smart" }]);
    expect(world.sent.at(-1)).toBe("Feito.");

    // The code is spent: the same change asks again, with a new code.
    await turn(stub, world, "m3", "de novo");
    expect(ran).toEqual([{ to: "smart" }]);
    const [, second] = codes(world);
    expect(second).toMatch(/^[A-Z0-9]{6}$/);
    expect(second).not.toBe(code);
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
      reply(`O código é ${code}.`),
      toolCalls({ name: "change", input: { to: "smart" } }),
      reply("Hm."),
      // The owner's code confirms its own input, not another.
      toolCalls({ name: "change", input: { to: "frontier" } }),
      reply("Confirme."),
    );
    await turn(stub, world, "m2", "ok?");
    await turn(stub, world, "m3", "e agora?");
    await turn(stub, world, "m4", `confirmo ${code}`);

    expect(ran).toEqual([]);
    const shown = codes(world);
    expect(shown.slice(0, 3)).toEqual([code, code, code]);
    expect(shown[3]).not.toBe(code);
  });

  it("counts only the requester's own messages, before the code expires", async () => {
    const scripts = [toolCalls({ name: "change", input: { to: "smart" } }), reply("Confirme.")];
    const world = use(fakeWorld(scripts));
    const ran = gated(world);
    const stub = agent("gate-requester");
    await turn(stub, world, "m1", "mude para smart");
    const [code] = codes(world);

    // Someone else's message with the code, in a turn the owner wrote last, doesn't count.
    scripts.push(toolCalls({ name: "change", input: { to: "smart" } }), reply("Hm."));
    const before = (await stub.turns()).length;
    await stub.ingest(message("m2", `confirmo ${code}`, "u-other"));
    await stub.ingest(message("m3", "ok"));
    await stub.flush();
    await vi.waitFor(async () => {
      const turns = await stub.turns();
      expect(turns).toHaveLength(before + 1);
      expect(turns.at(-1)?.status).not.toBe("running");
    });
    expect(ran).toEqual([]);

    // Past its 10 minutes, the owner's own code doesn't either.
    scripts.push(toolCalls({ name: "change", input: { to: "smart" } }), reply("Expirou."));
    world.clock += 10 * 60_000 + 1;
    await turn(stub, world, "m4", `confirmo ${code}`);
    expect(ran).toEqual([]);
  });
});
