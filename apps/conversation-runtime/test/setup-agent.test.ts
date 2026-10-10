import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Locale } from "@kelpie/channels";
import { type Actor, DEFAULT_SETTINGS, SETUP_AGENT_ID } from "@kelpie/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationAgent } from "../src/conversation-agent.ts";
import { replacePortsForTesting } from "../src/ports.ts";
import { type SetupCommands, setupTools } from "../src/setup-agent.ts";
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
import { type FakeWorld, fakeWorld, held, reply, toolCalls } from "./fakes.ts";

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

/** A context whose `confirm` answers `confirmed`, and logs what it was asked and the links sent. */
function contextOf(confirmed: boolean, actor: Actor = owner, locale: Locale = "en") {
  const asked: ConfirmationRequest[] = [];
  const links: HostLink[] = [];
  const context: ToolContext = {
    locale,
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
    sendLink(link) {
      links.push(link);
    },
  };
  return { context, asked, links };
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
      // In each language Kelpie speaks (#187).
      expect(Object.keys(tool.label)).toEqual(["en", "pt-BR", "es"]);
      for (const label of Object.values(tool.label)) expect(label).toMatch(/^[A-Z][a-z]/);
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
    // The summary is in the conversation's language; the keys and values stay as they are (#187).
    for (const [locale, summary] of [
      [
        "pt-BR",
        `alterar as configurações do agente "Setup" (${SETUP_AGENT_ID}): tier para "frontier", quietMs para 2000.`,
      ],
      [
        "es",
        `cambiar la configuración del agente "Setup" (${SETUP_AGENT_ID}): tier a "frontier", quietMs a 2000.`,
      ],
    ] as const) {
      const spoken = contextOf(false, owner, locale);
      await run(tools, "configure_agent", input, spoken.context);
      expect(spoken.asked.map((request) => request.summary)).toEqual([summary]);
    }

    const confirmed = contextOf(true);
    expect((await run(tools, "configure_agent", input, confirmed.context)).isError).toBe(undefined);
    expect(calls).toEqual([
      `configureAgent {"id":"${SETUP_AGENT_ID}","settings":{"tier":"frontier","quietMs":2000}}`,
    ]);
  });

  it("refuses settings it can't show the owner whole, before asking", async () => {
    const tools = await toolsOf(setupTools(fakeCommands().commands, { adminOrigin: ADMIN }));
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
      expect(
        await run(tools, "configure_agent", { id: SETUP_AGENT_ID, settings }, context),
      ).toMatchObject({ isError: true });
    }
    expect(asked).toEqual([]);
    // A prompt that fits is shown whole.
    const fits = await run(
      tools,
      "configure_agent",
      { id: SETUP_AGENT_ID, settings: { systemPrompt: "x".repeat(3_000) } },
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
      setupTools(commands, { adminOrigin: ADMIN, now: () => Date.UTC(2026, 9, 6, 19, 45) }),
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
    const tools = await toolsOf(setupTools(fakeCommands().commands, { adminOrigin: ADMIN }));
    const { context, asked, links } = contextOf(false);

    const linked = await run(tools, "pair_telegram", { agentId: SETUP_AGENT_ID }, context);
    expect(links).toEqual([
      {
        href: `${ADMIN}/pair/telegram/${SETUP_AGENT_ID}?lang=en`,
        text: `To pair your own Telegram account with the bot of the agent ${SETUP_AGENT_ID}, open ${ADMIN}/pair/telegram/${SETUP_AGENT_ID}?lang=en and press its button.`,
      },
    ]);
    const spoken = contextOf(false, owner, "pt-BR");
    await run(tools, "pair_telegram", { agentId: SETUP_AGENT_ID }, spoken.context);
    expect(spoken.links.map((link) => link.text)).toEqual([
      `Para parear sua própria conta do Telegram com o bot do agente ${SETUP_AGENT_ID}, abra ${ADMIN}/pair/telegram/${SETUP_AGENT_ID}?lang=pt-BR e toque no botão da página.`,
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
      const tools = await toolsOf(setupTools(commands, { adminOrigin }));
      const { context, asked, links } = contextOf(true);

      for (const name of ["connect_telegram", "pair_telegram"]) {
        const answer = await run(tools, name, { agentId: SETUP_AGENT_ID }, context);
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
    const tools = await toolsOf(setupTools(commands, { adminOrigin: `${ADMIN}/` }));
    const token = "123456789:AAH-secret-token";
    const { context, asked, links } = contextOf(false);
    const input = { agentId: SETUP_AGENT_ID, botToken: token };

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
