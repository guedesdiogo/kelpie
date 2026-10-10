import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { replacePortsForTesting } from "../src/ports.ts";
import { setupNote } from "../src/setup-agent.ts";
import type { ToolContext } from "../src/tools.ts";
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

function use(world: FakeWorld): FakeWorld {
  replacePortsForTesting(world.ports);
  return world;
}

/** Turns that aren't running any more, once `count` exist. */
async function settled(stub: ReturnType<typeof agent>, count: number) {
  await vi.waitFor(async () => {
    const turns = await stub.turns();
    expect(turns).toHaveLength(count);
    expect(turns.at(-1)?.status).not.toBe("running");
  });
}

/** The text of the latest request's last user message. */
function lastUserText(world: FakeWorld): string {
  const messages = world.requests.at(-1)?.messages ?? [];
  const user = [...messages].reverse().find((entry) => entry.role === "user");
  return JSON.stringify(user ?? null);
}

afterEach(() => {
  replacePortsForTesting(undefined);
});

describe("the setup note", () => {
  it("says Kelpie wrote it, from the event's checked fields only", () => {
    expect(setupNote("lume", connected)).toBe(NOTE);
    expect(setupNote("lume", { step: "telegram_paired", userId: "u-owner" })).toBe(
      "Kelpie, automatically (the owner didn't write this): the owner paired their own Telegram account with the bot of the agent lume.",
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
  it("is waited for by the conversation whose reply sends its link", async () => {
    const until = Date.UTC(2026, 9, 10, 16);
    const world = use(fakeWorld([toolCalls({ name: "form" }), reply("Abra o link.")]));
    world.tools = [
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
                  awaits: { agentId: "lume", step: "telegram_connected", until },
                });
                return { output: "Kelpie sends the link." };
              },
            },
          ];
        },
      },
    ];
    const stub = agent("setup:telegram:events-awaits");
    await stub.ingest(message("m1", "vamos conectar o bot"));
    await stub.flush();
    await settled(stub, 1);
    expect(world.awaits).toEqual([
      {
        agentId: "lume",
        conversation: "setup:telegram:events-awaits",
        step: "telegram_connected",
        until,
      },
    ]);
  });

  it("is told only to the conversations waiting for it, once, while they wait", async () => {
    const world = use(fakeWorld([reply("Abra o link."), reply("Bot conectado!")]));
    const waiting = agent("setup:telegram:events-waiting");
    await waiting.ingest(message("m1", "vamos conectar o bot"));
    await waiting.flush();
    await settled(waiting, 1);

    const until = Date.now() + 60_000;
    await host("lume").awaitSetup("setup:telegram:events-waiting", "telegram_connected", until);
    // Waiting for another step, or past its wait, a conversation isn't told.
    await host("lume").awaitSetup("setup:telegram:events-paired", "telegram_paired", until);
    await host("lume").awaitSetup("setup:telegram:events-late", "telegram_connected", 1);

    await host("lume").setupDone(connected);
    await settled(waiting, 2);
    expect(lastUserText(world)).toContain(NOTE);
    expect(world.sent).toEqual(["Abra o link.", "Bot conectado!"]);
    expect(await agent("setup:telegram:events-paired").turns()).toEqual([]);
    expect(await agent("setup:telegram:events-late").turns()).toEqual([]);

    // Told once: a second report, as a double submit sends, finds no wait.
    await host("lume").setupDone(connected);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await waiting.turns()).toHaveLength(2);
  });

  it("starts a turn that acts for the owner, so the next step's tools work", async () => {
    const world = use(fakeWorld([toolCalls({ name: "whoami" }), reply("Agora vamos parear.")]));
    const actors: string[] = [];
    world.tools = [
      {
        async tools() {
          return [
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
    const stub = agent("setup:telegram:events-owner");
    // The conversation's first message binds it; the note follows.
    await stub.ingest(message("m1", "oi"));
    await stub.setupDone("lume", connected);
    await stub.flush();
    await settled(stub, 1);
    expect(actors).toEqual(["u-owner:owner"]);
  });

  it("waits for a running turn instead of interrupting it, then gets a turn of its own", async () => {
    const world = use(fakeWorld([held("Um momento."), reply("Bot conectado!")]));
    world.modelHeld = true;
    const stub = agent("setup:telegram:events-running");
    await stub.ingest(message("m1", "vamos conectar o bot"));
    await stub.flush();
    await vi.waitFor(() => expect(world.requests).toHaveLength(1));

    await stub.setupDone("lume", connected);
    world.modelHeld = false;
    await settled(stub, 2);
    const turns = await stub.turns();
    expect(turns.map((turn) => turn.status)).toEqual(["delivered", "delivered"]);
    expect(world.sent).toEqual(["Um momento.", "Bot conectado!"]);
    expect(lastUserText(world)).toContain(NOTE);
  });

  it("joins the person's waiting messages, answered in one turn after their usual wait", async () => {
    const world = use(fakeWorld([reply("Ok."), reply("Tudo certo.")]));
    const stub = agent("setup:telegram:events-joined");
    await stub.ingest(message("m1", "oi"));
    await stub.flush();
    await settled(stub, 1);

    await stub.ingest(message("m2", "e agora?"));
    await stub.setupDone("lume", connected);
    // The person's message waits for its flush; the note doesn't cut it short.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await stub.turns()).toHaveLength(1);
    await stub.flush();
    await settled(stub, 2);
    const asked = lastUserText(world);
    expect(asked).not.toContain("e agora?");
    expect(JSON.stringify(world.requests.at(-1)?.messages)).toContain("e agora?");
    expect(asked).toContain(NOTE);
  });

  it("is never the owner's words: not their language, not their session page", async () => {
    const world = use(fakeWorld([reply("Abra o link."), reply("Conectado.")]));
    const stub = agent("setup:telegram:events-words");
    await stub.ingest(message("m1", "vamos conectar o bot agora, por favor"));
    await stub.flush();
    await settled(stub, 1);
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
