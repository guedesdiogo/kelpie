import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { WEBCHAT_ADMISSION_HEADER } from "@kelpie/conversation/contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationAgent } from "../src/conversation-agent.ts";
import { replacePortsForTesting } from "../src/ports.ts";
import type { ToolContext } from "../src/tools.ts";
import { PRESENCE_FRAMES as CLASSIFIED, FRAME_VIEWS } from "../src/webchat.ts";
import { type FakeWorld, fakeWorld, noRoute, refuse, reply, toolCalls } from "./fakes.ts";

// The webchat's sidebar follows each agent through a socket in a presence view (ADR-0052): it gets
// the conversation's presence and never its content, and it may send only a card's actions, each
// naming its agent.

const owner = {
  agentId: "assistant",
  userId: "u-owner",
  role: "owner",
  chatType: "direct",
  timeZone: null,
};
const presence = { ...owner, view: "presence" };
const agent = (name: string) => env.CONVERSATION_AGENT.getByName(name);

type Frame = { type: string } & Record<string, unknown>;

async function open(name: string, admission: unknown = owner) {
  const headers: Record<string, string> = { Upgrade: "websocket" };
  headers[WEBCHAT_ADMISSION_HEADER] = JSON.stringify(admission);
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
const types = (frames: Frame[]) => frames.map((frame) => frame.type);
/** What a presence socket may ever get (ADR-0052 §2). */
const PRESENCE_FRAMES = [
  "presence",
  "status",
  "failed",
  "paused",
  "resumed",
  "requests",
  "confirmation",
];

function use(world: FakeWorld): FakeWorld {
  replacePortsForTesting(world.ports);
  return world;
}

afterEach(() => {
  replacePortsForTesting(undefined);
});

/** A provider with one tool, `change`, gated on the owner's confirmation. */
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

/** The owner writes on the conversation's own socket, and the turn runs to its end. */
async function turn(name: string, chat: Awaited<ReturnType<typeof open>>, text = "oi") {
  chat.send({ type: "message", id: `m${Math.random().toString(36).slice(2, 8)}`, text });
  await vi.waitFor(() => expect(ofType(chat.frames, "accepted").length).toBeGreaterThan(0));
  await agent(name).flush();
  await vi.waitFor(async () =>
    expect((await agent(name).turns()).at(-1)?.status).not.toBe("running"),
  );
}

describe("the presence view (ADR-0052)", () => {
  it("opens with the conversation's presence, and nothing of its content", async () => {
    use(fakeWorld([]));
    const row = await open("assistant:webchat:p-open", presence);
    await vi.waitFor(() => expect(row.frames).toHaveLength(1));
    expect(row.frames[0]).toEqual({
      type: "presence",
      turn: null,
      failed: false,
      paused: false,
      requests: [],
      more: 0,
    });
    // No history, no wait, no mascot.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(types(row.frames)).toEqual(["presence"]);
  });

  it("closes a socket whose admission names a view it doesn't know", async () => {
    use(fakeWorld([]));
    const row = await open("assistant:webchat:p-view", { ...owner, view: "all" });
    await vi.waitFor(() => expect(row.closedWith()).toBe(1008));
  });

  it("follows each step and gets idle after a delivered turn, never a bubble", async () => {
    use(fakeWorld([toolCalls({ name: "missing" }), reply("Oi.")]));
    const name = "assistant:webchat:p-steps";
    const chat = await open(name);
    const row = await open(name, presence);
    await turn(name, chat);
    await vi.waitFor(() =>
      expect(ofType(row.frames, "status").at(-1)).toMatchObject({ status: "idle" }),
    );
    expect(types(row.frames).every((type) => PRESENCE_FRAMES.includes(type))).toBe(true);
    expect(ofType(row.frames, "status").map((frame) => frame.status)).toContain("thinking");
    // The conversation's own socket still ends the step on the reply's bubble.
    expect(ofType(chat.frames, "bubble").map((frame) => frame.text)).toContain("Oi.");
  });

  it("gets idle after a refused turn, which leaves no step behind", async () => {
    use(fakeWorld([refuse()]));
    const name = "assistant:webchat:p-refused";
    const chat = await open(name);
    const row = await open(name, presence);
    await turn(name, chat);
    await vi.waitFor(() =>
      expect(ofType(row.frames, "status").at(-1)).toMatchObject({ status: "idle" }),
    );
    const late = await open(name, presence);
    await vi.waitFor(() => expect(late.frames).toHaveLength(1));
    expect(late.frames[0]).toMatchObject({ type: "presence", turn: null });
  });

  it("gets failed when a turn fails, and a new presence socket learns it", async () => {
    use(fakeWorld([noRoute("unavailable")]));
    const name = "assistant:webchat:p-failed";
    const chat = await open(name);
    const row = await open(name, presence);
    await turn(name, chat);
    await vi.waitFor(() => expect(ofType(row.frames, "failed")).toHaveLength(1));
    const late = await open(name, presence);
    await vi.waitFor(() => expect(late.frames).toHaveLength(1));
    expect(late.frames[0]).toMatchObject({ type: "presence", failed: true });
  });

  it("lists the open confirmations once their notice is sent, on both views, and drops a used one", async () => {
    const world = use(
      fakeWorld([
        toolCalls({ name: "change", input: { to: "frontier" } }),
        reply("Confirme, por favor."),
        toolCalls({ name: "change", input: { to: "frontier" } }),
        reply("Feito."),
      ]),
    );
    const ran = changing(world);
    const name = "assistant:webchat:p-requests";
    const chat = await open(name);
    const row = await open(name, presence);
    await turn(name, chat, "mude o tier");
    const id = Number(ofType(chat.frames, "bubble")[1]?.confirmation);
    const listed = [{ id, summary: 'change the tier to {"to":"frontier"}.' }];
    await vi.waitFor(() =>
      expect(ofType(row.frames, "requests").at(-1)?.requests).toMatchObject(listed),
    );
    expect(ofType(chat.frames, "requests").at(-1)?.requests).toMatchObject(listed);
    const [shown] = (ofType(row.frames, "requests").at(-1)?.requests ?? []) as {
      askedAgoMs: number;
      expiresInMs: number;
    }[];
    expect(shown?.askedAgoMs).toBeGreaterThanOrEqual(0);
    expect(shown?.expiresInMs).toBeGreaterThan(9 * 60_000);
    // A socket that opens later learns it in its snapshot, and the conversation's own after history.
    const late = await open(name, presence);
    await vi.waitFor(() => expect(late.frames).toHaveLength(1));
    expect(late.frames[0]?.requests).toMatchObject(listed);
    const reloaded = await open(name);
    await vi.waitFor(() => expect(ofType(reloaded.frames, "requests")).toHaveLength(1));
    expect(types(reloaded.frames).indexOf("requests")).toBeGreaterThan(
      types(reloaded.frames).indexOf("history"),
    );

    // The row's card confirms over the presence socket, naming its agent.
    row.send({ type: "confirm", id, agent: "assistant" });
    await vi.waitFor(() =>
      expect(ofType(row.frames, "confirmation")).toEqual([
        { type: "confirmation", id, status: "accepted" },
      ]),
    );
    await agent(name).flush();
    await vi.waitFor(() => expect(ran).toEqual([{ to: "frontier" }]));
    // Used, it leaves both lists.
    await vi.waitFor(() => expect(ofType(row.frames, "requests").at(-1)?.requests).toEqual([]));
    await vi.waitFor(() => expect(ofType(chat.frames, "requests").at(-1)?.requests).toEqual([]));
  });

  it("still tells a used confirmation's removal after the conversation hibernates", async () => {
    const world = use(
      fakeWorld([
        toolCalls({ name: "change", input: { to: "frontier" } }),
        reply("Confirme, por favor."),
        toolCalls({ name: "change", input: { to: "frontier" } }),
        reply("Feito."),
      ]),
    );
    changing(world);
    const name = "assistant:webchat:p-hibernate";
    const chat = await open(name);
    const row = await open(name, presence);
    await turn(name, chat, "mude o tier");
    const id = Number(ofType(chat.frames, "bubble")[1]?.confirmation);
    await vi.waitFor(() => expect(ofType(row.frames, "requests").at(-1)?.requests).toHaveLength(1));
    // Asleep, the conversation keeps its sockets but loses what it held in memory.
    await evictDurableObject(agent(name));
    row.send({ type: "confirm", id, agent: "assistant" });
    await vi.waitFor(() =>
      expect(ofType(row.frames, "confirmation")).toEqual([
        { type: "confirmation", id, status: "accepted" },
      ]),
    );
    await agent(name).flush();
    await vi.waitFor(() => expect(ofType(row.frames, "requests").at(-1)?.requests).toEqual([]));
    await vi.waitFor(() => expect(ofType(chat.frames, "requests").at(-1)?.requests).toEqual([]));
    // Before and after the wake, the row got only its view's frames.
    expect(types(row.frames).every((type) => PRESENCE_FRAMES.includes(type))).toBe(true);
    expect(types(chat.frames)).toContain("bubble");
  });

  it("tells a row that opened after the ask when its confirmation is used", async () => {
    const world = use(
      fakeWorld([
        toolCalls({ name: "change", input: { to: "frontier" } }),
        reply("Confirme, por favor."),
        toolCalls({ name: "change", input: { to: "frontier" } }),
        reply("Feito."),
      ]),
    );
    const ran = changing(world);
    const name = "assistant:webchat:p-away";
    // The owner writes and leaves: the agent asks while no socket of theirs is open.
    const chat = await open(name);
    chat.send({ type: "message", id: "m-away", text: "mude o tier" });
    await vi.waitFor(() => expect(ofType(chat.frames, "accepted")).toHaveLength(1));
    chat.close();
    await agent(name).flush();
    await vi.waitFor(async () =>
      expect((await agent(name).turns()).at(-1)?.status).not.toBe("running"),
    );
    // Back, the sidebar's row learns the request from its snapshot, and confirms it.
    const row = await open(name, presence);
    await vi.waitFor(() => expect(row.frames).toHaveLength(1));
    const [request] = (row.frames[0]?.requests ?? []) as { id: number }[];
    expect(request).toBeDefined();
    row.send({ type: "confirm", id: request?.id, agent: "assistant" });
    await vi.waitFor(() =>
      expect(ofType(row.frames, "confirmation").at(-1)?.status).toBe("accepted"),
    );
    await agent(name).flush();
    await vi.waitFor(() => expect(ran).toEqual([{ to: "frontier" }]));
    await vi.waitFor(() => expect(ofType(row.frames, "requests").at(-1)?.requests).toEqual([]));
  });

  it("takes only a card's actions, each naming its agent, and closes on anything else", async () => {
    use(fakeWorld([]));
    const name = "assistant:webchat:p-actions";
    // A confirm with no agent, or another's, is refused, and the socket stays open.
    const row = await open(name, presence);
    row.send({ type: "confirm", id: 1 });
    row.send({ type: "confirm", id: 1, agent: "agenda" });
    await vi.waitFor(() => expect(ofType(row.frames, "confirmation")).toHaveLength(2));
    expect(ofType(row.frames, "confirmation").map((frame) => frame.status)).toEqual([
      "refused",
      "refused",
    ]);
    // A pause naming another agent is ignored; one naming this one pauses the conversation.
    row.send({ type: "pause", agent: "agenda" });
    row.send({ type: "pause", agent: "assistant" });
    await vi.waitFor(() => expect(ofType(row.frames, "paused")).toHaveLength(1));
    expect(row.closedWith()).toBeNull();
    // A message, typing or a frame it can't read closes it.
    for (const frame of [
      { type: "message", id: "m1", text: "oi" },
      { type: "typing", active: true },
      "not json",
    ]) {
      const other = await open(name, presence);
      other.send(frame);
      await vi.waitFor(() => expect(other.closedWith()).toBe(1008));
    }
  });

  it("keeps the SDK's own frames inert on a presence socket", async () => {
    use(fakeWorld([]));
    const name = "assistant:webchat:p-sdk";
    const row = await open(name, presence);
    row.send({ type: "cf_agent_state", state: { forged: true } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const state = await runInDurableObject(
      agent(name),
      (instance: ConversationAgent) => instance.state,
    );
    expect(state).toBeUndefined();
  });

  it("refuses a press for a confirmation whose notice was never sent", async () => {
    use(fakeWorld([]));
    const name = "assistant:webchat:p-unsent";
    const row = await open(name, presence);
    await vi.waitFor(() => expect(row.frames).toHaveLength(1));
    const id = await runInDurableObject(agent(name), (_instance, state) => {
      const now = Date.now();
      const rows = state.storage.sql
        .exec(
          `INSERT INTO confirmations (code, user_id, command, input, summary, after_history_id, turn_id, created_at, expires_at)
           VALUES ('ABC123', 'u-owner', 'change', '{}', 'x', 0, 1, ?, ?) RETURNING id`,
          now,
          now + 600_000,
        )
        .toArray();
      return Number(rows[0]?.id);
    });
    row.send({ type: "confirm", id, agent: "assistant" });
    await vi.waitFor(() =>
      expect(ofType(row.frames, "confirmation")).toEqual([
        { type: "confirmation", id, status: "refused" },
      ]),
    );
  });

  it("classifies every frame by view, as the ADR lists the presence view's", () => {
    expect([...CLASSIFIED].sort()).toEqual([...PRESENCE_FRAMES].sort());
    // The snapshot and a failed turn are the sidebar's alone; the conversation's own socket shows them otherwise.
    expect(FRAME_VIEWS.presence).toBe("presence");
    expect(FRAME_VIEWS.failed).toBe("presence");
  });

  it("keeps at most 8 presence sockets, closing the oldest with 1013", async () => {
    use(fakeWorld([]));
    const name = "assistant:webchat:p-cap";
    const rows: Awaited<ReturnType<typeof open>>[] = [];
    for (let index = 0; index < 9; index += 1) {
      rows.push(await open(name, presence));
      await vi.waitFor(() => expect(rows.at(-1)?.frames).toHaveLength(1));
    }
    await vi.waitFor(() => expect(rows[0]?.closedWith()).toBe(1013));
    expect(rows.slice(1).map((row) => row.closedWith())).toEqual(Array(8).fill(null));
  });
});

describe("the conversation's own socket (ADR-0052 §3)", () => {
  it("refuses a press naming another agent, and still takes one naming none", async () => {
    const world = use(
      fakeWorld([
        toolCalls({ name: "change", input: { to: "frontier" } }),
        reply("Confirme, por favor."),
        toolCalls({ name: "change", input: { to: "frontier" } }),
        reply("Feito."),
      ]),
    );
    const ran = changing(world);
    const name = "assistant:webchat:own-agent";
    const chat = await open(name);
    await turn(name, chat, "mude o tier");
    const id = Number(ofType(chat.frames, "bubble")[1]?.confirmation);
    // Naming another agent, the press is refused, and the confirmation stays open.
    chat.send({ type: "confirm", id, agent: "agenda" });
    await vi.waitFor(() =>
      expect(ofType(chat.frames, "confirmation")).toEqual([
        { type: "confirmation", id, status: "refused" },
      ]),
    );
    // A page from before ADR-0052 names none: on the conversation's own socket it still counts.
    chat.send({ type: "confirm", id });
    await vi.waitFor(() =>
      expect(ofType(chat.frames, "confirmation").at(-1)).toEqual({
        type: "confirmation",
        id,
        status: "accepted",
      }),
    );
    await agent(name).flush();
    await vi.waitFor(() => expect(ran).toEqual([{ to: "frontier" }]));
    expect(chat.closedWith()).toBeNull();
  });

  it("confirms nothing in either conversation for one's id pressed over another's socket", async () => {
    const world = use(
      fakeWorld([
        toolCalls({ name: "change", input: { to: "frontier" } }),
        reply("Confirme, por favor."),
      ]),
    );
    const ran = changing(world);
    const asking = "assistant:webchat:cross-a";
    const chat = await open(asking);
    await turn(asking, chat, "mude o tier");
    const id = Number(ofType(chat.frames, "bubble")[1]?.confirmation);
    const other = await open("agenda:webchat:cross-b", { ...presence, agentId: "agenda" });
    await vi.waitFor(() => expect(other.frames).toHaveLength(1));
    other.send({ type: "confirm", id, agent: "agenda" });
    await vi.waitFor(() =>
      expect(ofType(other.frames, "confirmation")).toEqual([
        { type: "confirmation", id, status: "refused" },
      ]),
    );
    // The asking conversation still lists it, and ran nothing.
    const late = await open(asking, presence);
    await vi.waitFor(() => expect(late.frames).toHaveLength(1));
    expect(late.frames[0]?.requests).toMatchObject([{ id }]);
    expect(ran).toEqual([]);
  });
});
