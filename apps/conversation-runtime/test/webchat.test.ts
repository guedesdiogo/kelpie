import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { WEBCHAT_ADMISSION_HEADER } from "@kelpie/conversation/contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationAgent } from "../src/conversation-agent.ts";
import { replacePortsForTesting } from "../src/ports.ts";
import { type FakeWorld, fakeWorld, refuse, reply, sayThenCall } from "./fakes.ts";

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
    // As ingress sent it before #131, and as a socket from then still holds it.
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
