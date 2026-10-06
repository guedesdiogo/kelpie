import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { replacePortsForTesting } from "../src/ports.ts";
import { ADMISSION_HEADER } from "../src/webchat.ts";
import { type FakeWorld, fakeWorld, reply } from "./fakes.ts";

// The webchat's socket lives on the conversation's object (issue #40). Ingress admits the owner
// and passes the admission in a header the browser can't set; these tests open sockets the way
// ingress does.

const owner = { agentId: "assistant", userId: "u-owner", timeZone: null };
const agent = (name: string) => env.CONVERSATION_AGENT.getByName(name);

type Frame = { type: string } & Record<string, unknown>;

async function open(name: string, admission: unknown = owner) {
  const headers: Record<string, string> = { Upgrade: "websocket" };
  if (admission !== null) headers[ADMISSION_HEADER] = JSON.stringify(admission);
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

    await vi.waitFor(() => expect(chat.frames[0]).toEqual({ type: "history", messages: [] }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(chat.frames.map((frame) => frame.type)).toEqual(["history"]);
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
