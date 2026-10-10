import { env } from "cloudflare:workers";
import type { SetupStep } from "@kelpie/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { replacePortsForTesting } from "../src/ports.ts";
import { setupNote } from "../src/setup-agent.ts";
import type { ToolContext, ToolProvider } from "../src/tools.ts";
import { type FakeWorld, fakeWorld, held, reply, toolCalls } from "./fakes.ts";

// The owner finishing a setup step behind a link Kelpie sent (#206): the agent's AgentHost tells the
// conversations waiting for it, and Kelpie writes a note of its own there, which the agent answers.

const agent = (name: string) => env.CONVERSATION_AGENT.getByName(name);
const host = (agentId: string) => env.AGENT_HOST.getByName(agentId);
const destination = { channel: "telegram", threadId: "chat-1" } as const;
const connected = {
  step: "telegram_connected",
  userId: "u-owner",
  bot: "LumeBot",
  webhookRegistered: true,
} as const;
const NOTE =
  "Kelpie, automatically (the owner didn't write this): the owner submitted the secure form, and the Telegram bot @LumeBot now answers for the agent lume.";
/** Long enough for a test to finish, unlike a real form's 15 minutes. */
const OPEN = () => Date.now() + 60 * 60_000;

function message(id: string, text: string) {
  return {
    agentId: "setup",
    providerMessageId: id,
    userId: "u-owner",
    role: "owner",
    chatType: "direct",
    text,
    destination,
    sentAt: Date.UTC(2026, 9, 10, 15),
    timeZone: null,
  } as const;
}

/**
 * Tools for the setup conversation: `form` has Kelpie send a link waiting for `step` of `agentId`
 * until `until`, and `whoami` logs who a turn acts for. The agents' AgentHosts outlive a test, so a
 * test that only waits names an agent of its own.
 */
function tools(
  step: SetupStep,
  until: number,
  actors: string[] = [],
  agentId = "lume",
): ToolProvider[] {
  return [
    {
      async tools() {
        return [
          {
            spec: { name: "form", description: "Form.", inputSchema: { type: "object" } },
            label: "Opening a form",
            async run(_input: unknown, context: ToolContext) {
              const href = "https://admin.example/forms/tok-1";
              context.sendLink({
                href,
                text: `The secure form: ${href}`,
                awaits: { agentId, step, until },
              });
              return { output: "Kelpie sends the link." };
            },
          },
          {
            spec: { name: "whoami", description: "Who.", inputSchema: { type: "object" } },
            label: "Checking",
            async run(_input: unknown, context: ToolContext) {
              actors.push(`${context.actor.userId}:${context.actor.role}`);
              return { output: "ok" };
            },
          },
        ];
      },
    },
  ];
}

/** The fake ports, whose waits the agent's real AgentHost keeps, so its reports come back. */
function use(world: FakeWorld): FakeWorld {
  world.onAwait = ({ agentId, conversation, step, until }) =>
    host(agentId).awaitSetup(conversation, step, until);
  replacePortsForTesting(world.ports);
  return world;
}

/** Turns that aren't running any more, once `count` exist. */
async function settled(stub: ReturnType<typeof agent>, count: number) {
  await vi.waitFor(
    async () => {
      const turns = await stub.turns();
      expect(turns).toHaveLength(count);
      expect(turns.at(-1)?.status).not.toBe("running");
    },
    { timeout: 5_000 },
  );
}

/** A conversation whose first turn sent the link: it now waits for the step. */
async function waiting(name: string, text = "vamos conectar o bot") {
  const stub = agent(name);
  await stub.ingest(message("m1", text));
  await stub.flush();
  await settled(stub, 1);
  return stub;
}

/** The text of the latest request's last user message. */
function lastUserText(world: FakeWorld): string {
  const messages = world.requests.at(-1)?.messages ?? [];
  const user = [...messages].reverse().find((entry) => entry.role === "user");
  return JSON.stringify(user ?? null);
}

/** Lets a report's schedule, and any turn it would start, run. */
const moment = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  replacePortsForTesting(undefined);
});

describe("the setup note", () => {
  it("says Kelpie wrote it, from the event's checked fields only", () => {
    expect(setupNote("lume", connected)).toBe(NOTE);
    expect(setupNote("lume", { step: "telegram_paired", userId: "u-owner" })).toBe(
      "Kelpie, automatically (the owner didn't write this): the owner's pairing link was used: a Telegram account is now paired, as the owner's, with the bot of the agent lume.",
    );
    // The model can't register a webhook: it tells the owner how.
    expect(setupNote("lume", { ...connected, webhookRegistered: false })).toContain(
      "tell the owner to run the registerTelegramWebhook command on the admin API for lume",
    );
    for (const [agentId, event] of [
      ["Not An Agent", connected],
      ["lume", { ...connected, bot: "evil.example/x" }],
      ["lume", { ...connected, bot: "abc" }],
      ["lume", { ...connected, userId: "" }],
      ["lume", { step: "telegram_forgotten", userId: "u-owner" }],
    ] as const) {
      expect(setupNote(agentId, event as never), JSON.stringify(event)).toBeNull();
    }
  });
});

describe("a finished setup step", () => {
  it("is waited for before the reply that sends its link goes out", async () => {
    const until = OPEN();
    const world = use(fakeWorld([toolCalls({ name: "form" }), reply("Abra o link.")]));
    world.tools = tools("telegram_connected", until, [], "lume-awaited");
    const seen: number[] = [];
    const send = world.ports.send;
    world.ports.send = async (...args) => {
      seen.push(world.awaits.length);
      return send(...args);
    };
    await waiting("setup:telegram:events-awaits");
    expect(world.awaits).toEqual([
      {
        agentId: "lume-awaited",
        conversation: "setup:telegram:events-awaits",
        step: "telegram_connected",
        until,
      },
    ]);
    // Noted before the reply's first bubble, the link's included.
    expect(seen).toEqual([1, 1]);
  });

  it("is told only to the conversations waiting for it, once", async () => {
    const world = use(
      fakeWorld([
        toolCalls({ name: "form" }),
        reply("Abra o link."),
        reply("Oi."),
        reply("Pronto!"),
      ]),
    );
    world.tools = tools("telegram_connected", OPEN());
    const told = await waiting("setup:telegram:events-told");
    // A conversation the AgentHost lists, but that sent no link itself, takes no report.
    const stranger = agent("setup:telegram:events-stranger");
    await stranger.ingest(message("m1", "oi"));
    await stranger.flush();
    await settled(stranger, 1);
    await host("lume").awaitSetup("setup:telegram:events-stranger", "telegram_connected", OPEN());

    await host("lume").setupDone(connected);
    await settled(told, 2);
    expect(lastUserText(world)).toContain(NOTE);
    expect(world.sent.at(-1)).toBe("Pronto!");
    await moment();
    expect(await stranger.turns()).toHaveLength(1);

    // Told once: a second report, as a double submit sends, finds no wait on either side.
    await host("lume").setupDone(connected);
    await told.setupDone("lume", connected);
    await moment();
    expect(await told.turns()).toHaveLength(2);
  });

  it("isn't told for another step, or once its wait ran out", async () => {
    const world = use(
      fakeWorld([
        toolCalls({ name: "form" }),
        reply("Abra o link."),
        toolCalls({ name: "form" }),
        reply("Abra o link."),
      ]),
    );
    world.tools = tools("telegram_paired", OPEN());
    const pairing = await waiting("setup:telegram:events-pairing");
    // Ended past the grace a late report still gets.
    world.tools = tools("telegram_connected", Date.now() - 10 * 60_000);
    const late = await waiting("setup:telegram:events-late");

    await host("lume").setupDone(connected);
    await late.setupDone("lume", connected);
    await moment();
    expect(await pairing.turns()).toHaveLength(1);
    expect(await late.turns()).toHaveLength(1);
  });

  it("starts a turn of its own that acts for the owner, so the next step's tools work", async () => {
    const actors: string[] = [];
    const world = use(
      fakeWorld([
        toolCalls({ name: "form" }),
        reply("Abra o link."),
        toolCalls({ name: "whoami" }),
        reply("Agora vamos parear."),
      ]),
    );
    world.tools = tools("telegram_connected", OPEN(), actors);
    const stub = await waiting("setup:telegram:events-owner");
    await stub.setupDone("lume", connected);
    await settled(stub, 2);
    // Nothing of the owner's was pending: the note's own row made the turn the owner's.
    expect(actors).toEqual(["u-owner:owner"]);
    expect(lastUserText(world)).toContain(NOTE);
  });

  it("waits for a running turn instead of interrupting it, then gets a turn of its own", async () => {
    const world = use(
      fakeWorld([
        toolCalls({ name: "form" }),
        reply("Abra o link."),
        held("Um momento."),
        reply("Bot conectado!"),
      ]),
    );
    world.tools = tools("telegram_connected", OPEN());
    const stub = await waiting("setup:telegram:events-running");
    world.modelHeld = true;
    await stub.ingest(message("m2", "e o nome do bot?"));
    await stub.flush();
    await vi.waitFor(() => expect(world.requests).toHaveLength(3));

    await stub.setupDone("lume", connected);
    await moment();
    world.modelHeld = false;
    await settled(stub, 3);
    expect((await stub.turns()).map((turn) => turn.status)).toEqual([
      "delivered",
      "delivered",
      "delivered",
    ]);
    expect(world.sent.slice(-2)).toEqual(["Um momento.", "Bot conectado!"]);
    expect(lastUserText(world)).toContain(NOTE);
  });

  it("joins the person's waiting message, in a row of its own, without bringing it forward", async () => {
    const world = use(
      fakeWorld([toolCalls({ name: "form" }), reply("Abra o link."), reply("Ok.")]),
    );
    world.tools = tools("telegram_connected", OPEN());
    const stub = await waiting("setup:telegram:events-joined");

    await stub.ingest(message("m2", "e agora?"));
    await stub.setupDone("lume", connected);
    // The person's message waits for its planned flush, which the test runs by hand.
    await moment();
    expect(await stub.turns()).toHaveLength(1);
    await stub.flush();
    await settled(stub, 2);
    const asked = lastUserText(world);
    expect(asked).toContain(NOTE);
    expect(asked).not.toContain("e agora?");
    expect(JSON.stringify(world.requests.at(-1)?.messages)).toContain("e agora?");
  });

  it("waits while the conversation is paused, for the owner's next message", async () => {
    const world = use(
      fakeWorld([toolCalls({ name: "form" }), reply("Abra o link."), reply("Ok.")]),
    );
    world.tools = tools("telegram_connected", OPEN());
    const stub = await waiting("setup:telegram:events-paused");
    await stub.pause({ agentId: "setup", destination });
    await stub.setupDone("lume", connected);
    await moment();
    expect(await stub.turns()).toHaveLength(1);

    await stub.ingest(message("m2", "voltei"));
    await stub.flush();
    await settled(stub, 2);
    expect(JSON.stringify(world.requests.at(-1)?.messages)).toContain(NOTE);
  });

  it("is never the owner's words: not their language, not their session page", async () => {
    const world = use(
      fakeWorld([toolCalls({ name: "form" }), reply("Abra o link."), reply("Conectado.")]),
    );
    world.tools = tools("telegram_connected", OPEN());
    const stub = await waiting(
      "setup:telegram:events-words",
      "vamos conectar o bot agora, por favor",
    );
    await stub.setupDone("lume", connected);
    await settled(stub, 2);

    // Kelpie's note is in English; the conversation stays Portuguese.
    await stub.pause({ agentId: "setup", destination });
    expect(world.sent.at(-1)).toBe("Pausado. Respondo depois da sua próxima mensagem.");

    await stub.closeSession();
    const page = world.remembered[0]?.changes[0]?.content ?? "";
    expect(page).toContain("vamos conectar o bot agora, por favor");
    expect(page).toContain("Conectado.");
    expect(page).not.toContain("Kelpie, automatically");
  });
});
