import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { WEBCHAT_ADMISSION_HEADER } from "@kelpie/conversation/contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationAgent } from "../src/conversation-agent.ts";
import { replacePortsForTesting } from "../src/ports.ts";
import type { ToolContext } from "../src/tools.ts";
import { type FakeWorld, fakeWorld, refuse, reply, sayThenCall, toolCalls } from "./fakes.ts";

// The webchat's socket lives on the conversation's object (issue #40). Ingress admits the owner
// and passes the admission in a header the browser can't set; these tests open sockets the way
// ingress does.

const owner = {
  agentId: "assistant",
  userId: "u-owner",
  role: "owner",
  chatType: "direct",
  timeZone: null,
};
const agent = (name: string) => env.CONVERSATION_AGENT.getByName(name);

type Frame = { type: string } & Record<string, unknown>;

async function open(name: string, admission: unknown = owner) {
  const headers: Record<string, string> = { Upgrade: "websocket" };
  if (admission !== null) headers[WEBCHAT_ADMISSION_HEADER] = JSON.stringify(admission);
  const response = await agent(name).fetch("https://conversation/webchat", { headers });
  const socket = response.webSocket;
  if (!socket) throw new Error(`no socket: ${response.status}`);
  const frames: Frame[] = [];
  let closedWith: number | null = null;
  socket.addEventListener("message", (event) => frames.push(JSON.parse(String(event.data))));
  socket.addEventListener("close", (event) => {
    closedWith = event.code;
  });
  socket.accept();
  return {
    frames,
    closedWith: () => closedWith,
    send: (frame: unknown) =>
      socket.send(typeof frame === "string" ? frame : JSON.stringify(frame)),
    close: () => socket.close(1000),
  };
}

const ofType = (frames: Frame[], type: string) => frames.filter((frame) => frame.type === type);

/** The code in a confirmation's notice, as the webchat shows it (#186). */
const NOTICE_CODE = /\b(?:code|código) ([A-Z0-9]{6})\./;

/** Every link's href in a bubble's blocks, in order. */
function hrefsOf(blocks: unknown): string[] {
  if (Array.isArray(blocks)) return blocks.flatMap(hrefsOf);
  if (typeof blocks !== "object" || blocks === null) return [];
  const node = blocks as { type?: unknown; href?: unknown; children?: unknown; items?: unknown };
  return [
    ...(node.type === "link" && typeof node.href === "string" ? [node.href] : []),
    ...hrefsOf(node.children),
    ...hrefsOf(node.items),
  ];
}

/** A provider with one tool, `change`, gated on the owner's confirmation: it logs what ran. */
function changing(world: FakeWorld): unknown[] {
  const ran: unknown[] = [];
  world.tools = [
    {
      async tools() {
        return [
          {
            spec: { name: "change", description: "Changes.", inputSchema: { type: "object" } },
            label: "Changing",
            async run(input: unknown, context: ToolContext) {
              const summary = `change the tier to ${JSON.stringify(input)}.`;
              if (!(await context.confirm({ command: "change", input, summary }))) {
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
  return ran;
}

/** Opens a socket and asks for the change: the turn answers with a reply and the notice. */
async function asked(name: string) {
  const chat = await open(name);
  chat.send({ type: "message", id: "c1", text: "mude o tier" });
  await vi.waitFor(() => expect(ofType(chat.frames, "accepted")).toHaveLength(1));
  await agent(name).flush();
  await vi.waitFor(() => expect(ofType(chat.frames, "bubble")).toHaveLength(2));
  await vi.waitFor(async () =>
    expect((await agent(name).turns()).at(-1)?.status).toBe("delivered"),
  );
  return chat;
}

/** When the conversation's flush schedules are due, in the SDK's whole seconds. */
const flushTimes = (name: string) =>
  runInDurableObject(agent(name), (instance: ConversationAgent) =>
    instance
      .getSchedules()
      .filter((schedule) => schedule.callback === "flush")
      .map((schedule) => schedule.time),
  );
const seconds = (ms: number) => Math.floor(ms / 1_000);

function use(world: FakeWorld): FakeWorld {
  replacePortsForTesting(world.ports);
  return world;
}

afterEach(() => {
  replacePortsForTesting(undefined);
});

describe("webchat sockets", () => {
  it("accepts an admitted socket and sends only Kelpie's own frames", async () => {
    use(fakeWorld([]));
    const chat = await open("assistant:webchat:quiet");

    await vi.waitFor(() =>
      expect(chat.frames[0]).toEqual({
        type: "history",
        messages: [],
        received: [],
        paused: false,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(chat.frames.map((frame) => frame.type)).toEqual(["history"]);
  });

  it("keeps a socket whose admission has no role, and gives its turns only their own scope (#131)", async () => {
    const world = use(fakeWorld([reply("Oi."), reply("Oi de novo.")]));
    const name = "assistant:webchat:no-role";
    // As an ingress from before #131 sends it, while the runtime is deployed ahead of it.
    const before = await open(name, { agentId: "assistant", userId: "u-owner", timeZone: null });
    before.send({ type: "message", id: "c1", text: "onde a Ana mora?" });
    await vi.waitFor(() => expect(ofType(before.frames, "accepted")).toHaveLength(1));
    await agent(name).flush();
    await vi.waitFor(() => expect(world.recalls).toHaveLength(1));
    expect(world.recalls[0]?.options.scopes).toEqual(["conversation/webchat-u-owner"]);

    // The owner's next connection carries the role again, and every scope comes back.
    await vi.waitFor(async () =>
      expect((await agent(name).turns()).at(-1)?.status).toBe("delivered"),
    );
    const after = await open(name);
    after.send({ type: "message", id: "c2", text: "e o Bruno?" });
    await vi.waitFor(() => expect(ofType(after.frames, "accepted")).toHaveLength(1));
    await agent(name).flush();
    await vi.waitFor(() => expect(world.recalls).toHaveLength(2));
    expect(world.recalls[1]?.options.scopes).toBe("all");
  });

  it("closes a socket that ingress didn't admit", async () => {
    use(fakeWorld([]));
    const chat = await open("assistant:webchat:stranger", null);
    await vi.waitFor(() => expect(chat.closedWith()).toBe(1008));
    expect(chat.frames).toEqual([]);
  });

  it("buffers a message from the socket and answers with paced bubbles over it", async () => {
    const world = use(fakeWorld([reply("Um.\n\nDois.")]));
    const name = "assistant:webchat:turn";
    const chat = await open(name);
    chat.send({ type: "message", id: "c1", text: "pode me ajudar com o pedido?" });
    await vi.waitFor(() =>
      expect(ofType(chat.frames, "accepted")).toEqual([{ type: "accepted", id: "c1" }]),
    );

    await agent(name).flush();
    await vi.waitFor(() =>
      expect(ofType(chat.frames, "bubble").map((frame) => frame.text)).toEqual(["Um.", "Dois."]),
    );
    // "typing" shows before the bubbles, and nothing went through channel-egress.
    const types = chat.frames.map((frame) => frame.type);
    expect(types.indexOf("typing")).toBeLessThan(types.indexOf("bubble"));
    expect(world.sent).toEqual([]);
    expect(world.typing).toBe(0);
  });

  it("formats a reply, linking only what the owner sent and Kelpie's admin pages (#188)", async () => {
    use(
      fakeWorld([
        reply(
          "**Pronto**: [o guia](https://docs.example/guia), [o formulário](https://admin.example/forms/abc) e [outro](https://evil.example/x).",
        ),
      ]),
    );
    const name = "assistant:webchat:formatted";
    const chat = await open(name);
    chat.send({ type: "message", id: "c1", text: "segui https://docs.example/guia" });
    await vi.waitFor(() => expect(ofType(chat.frames, "accepted")).toHaveLength(1));
    await agent(name).flush();
    await vi.waitFor(() => expect(ofType(chat.frames, "bubble")).toHaveLength(1));

    const blocks = [
      {
        type: "paragraph",
        children: [
          { type: "bold", children: [{ type: "text", text: "Pronto" }] },
          { type: "text", text: ": " },
          {
            type: "link",
            href: "https://docs.example/guia",
            children: [{ type: "text", text: "o guia" }],
          },
          { type: "text", text: ", " },
          {
            type: "link",
            href: "https://admin.example/forms/abc",
            children: [{ type: "text", text: "o formulário" }],
          },
          { type: "text", text: " e " },
          { type: "text", text: "outro" },
          { type: "text", text: " (" },
          { type: "code", text: "https://evil.example/x" },
          { type: "text", text: ")" },
          { type: "text", text: "." },
        ],
      },
    ];
    expect(ofType(chat.frames, "bubble")[0]).toMatchObject({ blocks });

    // A new socket gets the reply formatted the same way.
    const later = await open(name);
    await vi.waitFor(() => expect(later.frames[0]).toMatchObject({ type: "history" }));
    const messages = (later.frames[0]?.messages ?? []) as { role: string; blocks?: unknown }[];
    const replayed = messages.find((message) => message.role === "assistant");
    expect(replayed?.blocks).toEqual(blocks);
  });

  it("links on replay only what the owner had sent before each reply, and the admin origin as written (#188)", async () => {
    use(
      fakeWorld([
        reply("Veja https://later.example/a e [admin](https://admin.example\\@evil.example/x)."),
        reply("Ok: **https://later.example/a**"),
      ]),
    );
    const name = "assistant:webchat:replay-order";
    const chat = await open(name);
    const delivered = (count: number) =>
      vi.waitFor(async () => {
        const turns = await agent(name).turns();
        expect(turns).toHaveLength(count);
        expect(turns.at(-1)?.status).toBe("delivered");
      });
    chat.send({ type: "message", id: "c1", text: "oi" });
    await vi.waitFor(() => expect(ofType(chat.frames, "accepted")).toHaveLength(1));
    await agent(name).flush();
    await delivered(1);
    chat.send({ type: "message", id: "c2", text: "achei https://later.example/a" });
    await vi.waitFor(() => expect(ofType(chat.frames, "accepted")).toHaveLength(2));
    await agent(name).flush();
    await delivered(2);

    const later = await open(name);
    await vi.waitFor(() => expect(later.frames[0]).toMatchObject({ type: "history" }));
    const messages = (later.frames[0]?.messages ?? []) as { role: string; blocks?: unknown }[];
    const [first, second] = messages
      .filter((message) => message.role === "assistant")
      .map((message) => JSON.stringify(message.blocks));
    // The owner sent the link after the first reply, which showed it as code live.
    expect(first).not.toContain('"type":"link"');
    expect(first).toContain('{"type":"code","text":"https://later.example/a"}');
    expect(first).toContain('{"type":"code","text":"https://admin.example\\\\@evil.example/x"}');
    expect(second).toContain('{"type":"link","href":"https://later.example/a"');
  });

  it("replays the conversation to a new socket, without the time stamps", async () => {
    use(fakeWorld([reply("Claro, qual o número?")]));
    const name = "assistant:webchat:replay";
    const first = await open(name);
    first.send({ type: "message", id: "c1", text: "pode me ajudar com o pedido?" });
    await vi.waitFor(() => expect(ofType(first.frames, "accepted")).toHaveLength(1));
    await agent(name).flush();
    await vi.waitFor(async () =>
      expect((await agent(name).turns()).at(-1)?.status).toBe("delivered"),
    );

    const second = await open(name);
    await vi.waitFor(() =>
      expect(second.frames[0]).toMatchObject({
        type: "history",
        messages: [
          { role: "user", text: "pode me ajudar com o pedido?" },
          { role: "assistant", text: "Claro, qual o número?" },
        ],
      }),
    );
  });

  it("keeps the reply for the next socket when none is open", async () => {
    use(fakeWorld([reply("Já vi, está a caminho.")]));
    const name = "assistant:webchat:offline";
    const chat = await open(name);
    chat.send({ type: "message", id: "c1", text: "e o meu pedido?" });
    await vi.waitFor(() => expect(ofType(chat.frames, "accepted")).toHaveLength(1));
    chat.close();

    await agent(name).flush();
    await vi.waitFor(async () =>
      expect((await agent(name).turns()).at(-1)?.status).toBe("delivered"),
    );
    const later = await open(name);
    await vi.waitFor(() =>
      expect(later.frames[0]).toMatchObject({
        type: "history",
        messages: [
          { role: "user", text: "e o meu pedido?" },
          { role: "assistant", text: "Já vi, está a caminho." },
        ],
      }),
    );
  });

  it("shows buffered messages that no turn has claimed yet", async () => {
    use(fakeWorld([]));
    const name = "assistant:webchat:buffered";
    const chat = await open(name);
    chat.send({ type: "message", id: "c1", text: "então" });
    await vi.waitFor(() => expect(ofType(chat.frames, "accepted")).toHaveLength(1));

    const other = await open(name);
    await vi.waitFor(() =>
      expect(other.frames[0]).toMatchObject({
        type: "history",
        messages: [{ role: "user", text: "então" }],
      }),
    );
  });

  it("tells a new socket which of the page's messages it already has", async () => {
    use(fakeWorld([reply("Ok.")]));
    const name = "assistant:webchat:received";
    const chat = await open(name);
    chat.send({ type: "message", id: "c1", text: "primeira" });
    chat.send({ type: "message", id: "c2", text: "segunda" });
    await vi.waitFor(() => expect(ofType(chat.frames, "accepted")).toHaveLength(2));
    await agent(name).flush();
    await vi.waitFor(async () =>
      expect((await agent(name).turns()).at(-1)?.status).toBe("delivered"),
    );

    const later = await open(name);
    await vi.waitFor(() => expect(later.frames[0]).toMatchObject({ received: ["c1", "c2"] }));
  });

  it("keeps the socket's admission after the object is evicted", async () => {
    use(fakeWorld([]));
    const name = "assistant:webchat:evicted";
    const chat = await open(name);
    await vi.waitFor(() => expect(chat.frames).toHaveLength(1));
    await evictDurableObject(agent(name));

    chat.send({ type: "message", id: "c1", text: "ainda aqui?" });
    await vi.waitFor(() =>
      expect(ofType(chat.frames, "accepted")).toEqual([{ type: "accepted", id: "c1" }]),
    );
  });

  it("refuses a webchat message in a conversation another channel owns, and leaves its replies alone", async () => {
    const world = use(fakeWorld([reply("Oi pelo Telegram.")]));
    const name = "assistant:telegram:chat-9";
    await agent(name).ingest({
      agentId: "assistant",
      providerMessageId: "t1",
      userId: "u-owner",
      text: "oi",
      destination: { channel: "telegram", threadId: "chat-9" },
      sentAt: world.clock,
      timeZone: null,
    });
    const chat = await open(name);
    chat.send({ type: "message", id: "c1", text: "oi pelo navegador" });
    await vi.waitFor(() =>
      expect(ofType(chat.frames, "rejected")).toEqual([
        { type: "rejected", id: "c1", reason: "destination_mismatch" },
      ]),
    );

    await agent(name).flush();
    await vi.waitFor(() => expect(world.sent).toEqual(["Oi pelo Telegram."]));
    expect(ofType(chat.frames, "bubble")).toEqual([]);
  });

  it("rejects a message the conversation refuses, and ignores frames it doesn't know", async () => {
    use(fakeWorld([]));
    const chat = await open("assistant:webchat:refused");
    chat.send({ type: "message", id: "c1", text: "   " });
    chat.send("not json");
    chat.send({ type: "message", id: "has spaces", text: "oi" });
    chat.send({ type: "surprise" });
    await vi.waitFor(() =>
      expect(ofType(chat.frames, "rejected")).toEqual([
        { type: "rejected", id: "c1", reason: "empty" },
      ]),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(ofType(chat.frames, "accepted")).toEqual([]);
  });
});

describe("the owner's typing in the webchat", () => {
  it("schedules nothing while no message is buffered", async () => {
    use(fakeWorld([]));
    const name = "assistant:webchat:typing-idle";
    const chat = await open(name);
    await vi.waitFor(() => expect(chat.frames).toHaveLength(1));
    chat.send({ type: "typing", active: true });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await flushTimes(name)).toEqual([]);
  });

  it("holds the buffered messages while the owner types, never past the wait cap", async () => {
    const world = use(fakeWorld([]));
    const name = "assistant:webchat:typing-hold";
    const start = world.clock;
    const chat = await open(name);
    // The flush waits the agent's fixed wait, 10 s (ADR-0024).
    chat.send({ type: "message", id: "c1", text: "então" });
    await vi.waitFor(() => expect(ofType(chat.frames, "accepted")).toHaveLength(1));
    expect(await flushTimes(name)).toEqual([seconds(start + 10_000)]);

    // Typing pushes the flush to 4 s from now...
    world.clock = start + 8_000;
    chat.send({ type: "typing", active: true });
    await vi.waitFor(async () => expect(await flushTimes(name)).toEqual([seconds(start + 12_000)]));

    // ...but never past the 60 s cap from the first message, and there is only ever one schedule.
    world.clock = start + 58_000;
    chat.send({ type: "typing", active: true });
    await vi.waitFor(async () => expect(await flushTimes(name)).toEqual([seconds(start + 60_000)]));

    // Stopping doesn't bring the flush forward.
    chat.send({ type: "typing", active: false });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await flushTimes(name)).toEqual([seconds(start + 60_000)]);
  });
});

describe("pausing from the webchat", () => {
  it("pauses on the Pause frame, tells every socket, and resumes with the next message", async () => {
    use(fakeWorld([]));
    const name = "assistant:webchat:pause";
    const chat = await open(name);
    chat.send({ type: "message", id: "c1", text: "so" });
    await vi.waitFor(() => expect(ofType(chat.frames, "accepted")).toHaveLength(1));
    expect(await flushTimes(name)).toHaveLength(1);

    chat.send({ type: "pause" });
    await vi.waitFor(() => expect(ofType(chat.frames, "paused")).toEqual([{ type: "paused" }]));
    expect(await flushTimes(name)).toEqual([]);
    // No bubble: the page shows the pause itself.
    expect(ofType(chat.frames, "bubble")).toEqual([]);

    const later = await open(name);
    await vi.waitFor(() =>
      expect(later.frames[0]).toMatchObject({ type: "history", paused: true }),
    );

    later.send({ type: "message", id: "c2", text: "and the rest" });
    await vi.waitFor(() => expect(ofType(later.frames, "accepted")).toHaveLength(1));
    // Every open socket learns the conversation is live again.
    await vi.waitFor(() => expect(ofType(chat.frames, "resumed")).toEqual([{ type: "resumed" }]));
    expect(await flushTimes(name)).toHaveLength(1);
    const again = await open(name);
    await vi.waitFor(() =>
      expect(again.frames[0]).toMatchObject({ type: "history", paused: false }),
    );
  });
});

describe("a turn's steps in the webchat", () => {
  it("shows reading memory, thinking and each tool by name, then typing before the bubbles", async () => {
    const world = use(fakeWorld([sayThenCall("Vou ver.", { name: "lookup" }), reply("Pronto.")]));
    world.tools = [
      {
        async tools() {
          return [
            {
              spec: { name: "lookup", description: "Looks up.", inputSchema: { type: "object" } },
              label: "Looking it up",
              run: async () => ({ output: "ok" }),
            },
          ];
        },
      },
    ];
    const name = "assistant:webchat:steps";
    const chat = await open(name);
    chat.send({ type: "message", id: "c1", text: "procura isso" });
    await vi.waitFor(() => expect(ofType(chat.frames, "accepted")).toHaveLength(1));
    // Nothing shows while the wait for more messages runs.
    expect(ofType(chat.frames, "status")).toEqual([]);

    await agent(name).flush();
    await vi.waitFor(() => expect(ofType(chat.frames, "bubble")).toHaveLength(1));
    expect(ofType(chat.frames, "status")).toEqual([
      { type: "status", status: "memory" },
      { type: "status", status: "thinking" },
      { type: "status", status: "tool", label: "Looking it up" },
      { type: "status", status: "thinking" },
    ]);
    const types = chat.frames.map((frame) => frame.type);
    expect(types.lastIndexOf("status")).toBeLessThan(types.indexOf("typing"));
    expect(world.steps).toEqual([]);

    // A new socket is shown what the owner saw: no calls, no results, nothing said before them.
    const later = await open(name);
    await vi.waitFor(() =>
      expect(later.frames[0]).toMatchObject({
        type: "history",
        messages: [
          { role: "user", text: "procura isso" },
          { role: "assistant", text: "Pronto." },
        ],
      }),
    );
  });

  it("shows a confirmation's notice as a bubble after the reply, and takes the code typed back", async () => {
    const world = use(
      fakeWorld([
        toolCalls({ name: "change", input: { to: "frontier" } }),
        reply("Confirme, por favor."),
        toolCalls({ name: "change", input: { to: "frontier" } }),
        reply("Feito."),
      ]),
    );
    const ran = changing(world);
    const name = "assistant:webchat:confirm";
    const chat = await asked(name);

    const [answer, notice] = ofType(chat.frames, "bubble");
    expect(answer?.text).toBe("Confirme, por favor.");
    const code = NOTICE_CODE.exec(String(notice?.text))?.[1] ?? "";
    // In the conversation's language, Portuguese here, with the button's own word (#187).
    expect(notice?.text).toBe(
      `Confirme: change the tier to {"to":"frontier"}.\nPara seguir, toque em Confirmar, ou responda só com o código ${code}. Expira em 10 minutos.`,
    );
    // The notice is Kelpie's own text: shown as written, never formatted, with its button (#186).
    expect(notice).not.toHaveProperty("blocks");
    expect(notice?.confirmation).toEqual(expect.any(Number));
    expect(answer).toHaveProperty("blocks");
    expect(answer).not.toHaveProperty("confirmation");
    expect(world.sent).toEqual([]);

    // The notice isn't history: a new socket doesn't get it back.
    const later = await open(name);
    await vi.waitFor(() => expect(later.frames[0]).toMatchObject({ type: "history" }));
    expect(JSON.stringify(later.frames[0])).not.toContain(code);

    chat.send({ type: "message", id: "c2", text: code });
    await vi.waitFor(() => expect(ofType(chat.frames, "accepted")).toHaveLength(2));
    await agent(name).flush();
    await vi.waitFor(() => expect(ran).toEqual([{ to: "frontier" }]));
  });

  it("confirms with the notice's button: from the requester's socket only, while open, once (#186)", async () => {
    const world = use(
      fakeWorld([
        toolCalls({ name: "change", input: { to: "frontier" } }),
        reply("Confirme, por favor."),
        toolCalls({ name: "change", input: { to: "frontier" } }),
        reply("Feito."),
      ]),
    );
    const ran = changing(world);
    const name = "assistant:webchat:button";
    const chat = await asked(name);
    const id = Number(ofType(chat.frames, "bubble")[1]?.confirmation);
    const turns = (await agent(name).turns()).length;

    // Another user's socket, or an id with no open confirmation, presses nothing.
    const other = await open(name, { ...owner, userId: "u-other" });
    other.send({ type: "confirm", id });
    chat.send({ type: "confirm", id: id + 1 });
    await vi.waitFor(() =>
      expect(ofType(other.frames, "confirmation")).toEqual([
        { type: "confirmation", id, status: "refused" },
      ]),
    );
    await vi.waitFor(() =>
      expect(ofType(chat.frames, "confirmation")).toEqual([
        { type: "confirmation", id: id + 1, status: "refused" },
      ]),
    );
    await agent(name).flush();
    expect(await agent(name).turns()).toHaveLength(turns);

    // The owner's press replies with the code for them; a second press is that message again.
    chat.send({ type: "confirm", id });
    chat.send({ type: "confirm", id });
    await vi.waitFor(() => expect(ofType(chat.frames, "confirmation")).toHaveLength(3));
    expect(ofType(chat.frames, "confirmation").slice(1)).toEqual([
      { type: "confirmation", id, status: "accepted" },
      { type: "confirmation", id, status: "accepted" },
    ]);
    await agent(name).flush();
    await vi.waitFor(async () =>
      expect((await agent(name).turns()).at(-1)?.status).toBe("delivered"),
    );
    expect(ran).toEqual([{ to: "frontier" }]);
    expect(await agent(name).turns()).toHaveLength(turns + 1);

    // Once used, it takes no more presses.
    chat.send({ type: "confirm", id });
    await vi.waitFor(() =>
      expect(ofType(chat.frames, "confirmation").at(-1)).toEqual({
        type: "confirmation",
        id,
        status: "refused",
      }),
    );
    await agent(name).flush();
    expect(ran).toEqual([{ to: "frontier" }]);
  });

  it("falls back to the browser's language when the owner's words don't say (#187)", async () => {
    const world = use(
      fakeWorld([toolCalls({ name: "change", input: { to: "frontier" } }), reply("Vale.")]),
    );
    changing(world);
    const name = "assistant:webchat:browser-language";
    const chat = await open(name, { ...owner, language: "es-ES,es;q=0.9" });
    chat.send({ type: "message", id: "c1", text: "ok" });
    await vi.waitFor(() => expect(ofType(chat.frames, "accepted")).toHaveLength(1));
    await agent(name).flush();
    await vi.waitFor(() => expect(ofType(chat.frames, "bubble")).toHaveLength(2));
    expect(String(ofType(chat.frames, "bubble")[1]?.text)).toMatch(
      /^Confirma: .+\nPara seguir, presiona Confirmar, o responde solo con el código [A-Z0-9]{6}\. Expira en 10 minutos\.$/s,
    );
  });

  it("never shows Kelpie's note about a finished setup step, and answers it (#206)", async () => {
    const world = use(
      fakeWorld([toolCalls({ name: "form" }), reply("Abra o link."), reply("Bot conectado!")]),
    );
    // The first turn sends the form's link, so the conversation waits for the bot.
    world.tools = [
      {
        async tools() {
          return [
            {
              spec: { name: "form", description: "Form.", inputSchema: { type: "object" } },
              label: "Opening a form",
              async run(_input: unknown, context: ToolContext) {
                const href = "https://admin.example/forms/tok-2";
                context.sendLink({
                  href,
                  text: `The secure form: ${href}`,
                  awaits: {
                    agentId: "lume",
                    step: "telegram_connected",
                    until: Date.now() + 60_000,
                  },
                });
                return { output: "Kelpie sends the link." };
              },
            },
          ];
        },
      },
    ];
    const name = "setup:webchat:u-owner-note";
    const chat = await open(name, { ...owner, agentId: "setup" });
    chat.send({ type: "message", id: "c1", text: "vamos conectar o bot" });
    await vi.waitFor(() => expect(ofType(chat.frames, "accepted")).toHaveLength(1));
    await agent(name).flush();
    await vi.waitFor(() => expect(ofType(chat.frames, "bubble")).toHaveLength(2));
    await vi.waitFor(async () =>
      expect((await agent(name).turns()).at(-1)?.status).toBe("delivered"),
    );

    await agent(name).setupDone("lume", {
      step: "telegram_connected",
      userId: "u-owner",
      bot: "LumeBot",
      webhookRegistered: true,
    });
    await vi.waitFor(() => expect(ofType(chat.frames, "bubble")).toHaveLength(3));
    expect(world.sent).toEqual([]);
    expect(JSON.stringify(world.requests.at(-1)?.messages)).toContain("Kelpie, automatically");

    const later = await open(name, { ...owner, agentId: "setup" });
    await vi.waitFor(() => expect(later.frames[0]).toMatchObject({ type: "history" }));
    const replay = JSON.stringify(later.frames[0]);
    expect(replay).toContain("vamos conectar o bot");
    expect(replay).toContain("Bot conectado!");
    expect(replay).not.toContain("Kelpie, automatically");
  });

  it("refuses a press once the confirmation expired (#186)", async () => {
    const world = use(
      fakeWorld([toolCalls({ name: "change", input: { to: "frontier" } }), reply("Confirme.")]),
    );
    const ran = changing(world);
    const name = "assistant:webchat:button-expired";
    const chat = await asked(name);
    const id = Number(ofType(chat.frames, "bubble")[1]?.confirmation);

    world.clock += 10 * 60_000;
    chat.send({ type: "confirm", id });
    await vi.waitFor(() =>
      expect(ofType(chat.frames, "confirmation")).toEqual([
        { type: "confirmation", id, status: "refused" },
      ]),
    );
    await agent(name).flush();
    expect(ran).toEqual([]);
  });

  it("sends a tool's link after the reply as Kelpie's own bubble, linking only it (#186)", async () => {
    const href = "https://admin.example/forms/to_k-1_x";
    const world = use(fakeWorld([toolCalls({ name: "form" }), reply("Pronto.")]));
    const locales: string[] = [];
    world.tools = [
      {
        async tools() {
          return [
            {
              spec: { name: "form", description: "Opens a form.", inputSchema: { type: "object" } },
              label: {
                en: "Opening a form",
                "pt-BR": "Abrindo um formulário",
                es: "Abriendo un formulario",
              },
              async run(_input: unknown, context: ToolContext) {
                locales.push(context.locale);
                context.sendLink({
                  href,
                  text: `The secure form for _bot_: ${href}\nAlso https://admin.example/other.`,
                });
                return { output: "Kelpie sends the link." };
              },
            },
          ];
        },
      },
    ];
    const name = "assistant:webchat:link";
    const chat = await open(name);
    chat.send({ type: "message", id: "c1", text: "pode conectar o bot?" });
    await vi.waitFor(() => expect(ofType(chat.frames, "accepted")).toHaveLength(1));
    await agent(name).flush();
    await vi.waitFor(() => expect(ofType(chat.frames, "bubble")).toHaveLength(2));

    const [answer, notice] = ofType(chat.frames, "bubble");
    expect(answer?.text).toBe("Pronto.");
    expect(notice?.text).toBe(
      `The secure form for _bot_: ${href}\nAlso https://admin.example/other.`,
    );
    expect(notice).not.toHaveProperty("confirmation");
    // The tool and its label speak the conversation's language (#187).
    expect(locales).toEqual(["pt-BR"]);
    expect(ofType(chat.frames, "status")).toContainEqual({
      type: "status",
      status: "tool",
      label: "Abrindo um formulário",
    });
    // Its own link only, exactly as the tool made it; the other admin page stays text.
    expect(hrefsOf(notice?.blocks)).toEqual([href]);
    expect(JSON.stringify(world.requests)).not.toContain("to_k-1_x");
    await vi.waitFor(async () =>
      expect((await agent(name).turns()).at(-1)?.status).toBe("delivered"),
    );
    expect(JSON.stringify(await agent(name).outbox())).not.toContain("to_k-1_x");
    const later = await open(name);
    await vi.waitFor(() => expect(later.frames[0]).toMatchObject({ type: "history" }));
    expect(JSON.stringify(later.frames[0])).not.toContain("to_k-1_x");
  });

  it("clears the step when the turn stops without a reply", async () => {
    use(fakeWorld([refuse()]));
    const name = "assistant:webchat:steps-refused";
    const chat = await open(name);
    chat.send({ type: "message", id: "c1", text: "faz isso" });
    await vi.waitFor(() => expect(ofType(chat.frames, "accepted")).toHaveLength(1));

    await agent(name).flush();
    await vi.waitFor(() =>
      expect(ofType(chat.frames, "status").at(-1)).toEqual({ type: "status", status: "idle" }),
    );
    expect(ofType(chat.frames, "status").map((frame) => frame.status)).toEqual([
      "memory",
      "thinking",
      "idle",
    ]);
  });
});
