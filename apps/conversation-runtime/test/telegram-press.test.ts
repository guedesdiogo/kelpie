import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { PressTarget } from "@kelpie/conversation/contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationAgent } from "../src/conversation-agent.ts";
import { replacePortsForTesting } from "../src/ports.ts";
import type { ToolContext } from "../src/tools.ts";
import { type FakeWorld, fakeWorld, reply, toolCalls } from "./fakes.ts";

// Kelpie's Confirm button on Telegram (ADR-0067 §3, #495): a confirmation's notice carries an
// inline button whose data is the confirmation's random id. A tap, which ingress admitted as the
// owner's in their own chat, counts by ADR-0026 §3's rules, replies with the code for the owner,
// and is answered; the notice is then edited to say so. The typed code keeps working.

const agent = (name: string) => env.CONVERSATION_AGENT.getByName(name);
const chat = { channel: "telegram", threadId: "1001" } as const;

function message(id: string, text: string, userId = "u-owner") {
  return {
    agentId: "assistant",
    providerMessageId: id,
    userId,
    role: "owner",
    chatType: "direct",
    text,
    destination: chat,
    sentAt: Date.UTC(2026, 9, 22, 18),
    timeZone: null,
  } as const;
}

/** The owner's tap on the button carrying `data`, under the notice `providerMessageId`. */
function tap(data: string, fields: Partial<PressTarget> = {}): PressTarget {
  return {
    agentId: "assistant",
    destination: chat,
    userId: "u-owner",
    role: "owner",
    chatType: "direct",
    timeZone: null,
    pressId: "4382bfdwdsb323b2d9",
    providerMessageId: "43",
    data,
    ...fields,
  };
}

/** A tool, `change`, gated on the owner's confirmation: it logs what ran. */
function gated(world: FakeWorld): unknown[] {
  const ran: unknown[] = [];
  world.tools = [
    {
      async tools() {
        return [
          {
            spec: { name: "change", description: "Change.", inputSchema: { type: "object" } },
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

function use(world: FakeWorld): FakeWorld {
  replacePortsForTesting(world.ports);
  return world;
}

/** Runs the turn for what is buffered, until it settles. */
async function settle(stub: ReturnType<typeof agent>) {
  const before = (await stub.turns()).length;
  await stub.flush();
  await vi.waitFor(async () => {
    const turns = await stub.turns();
    expect(turns).toHaveLength(before + 1);
    expect(turns.at(-1)?.status).not.toBe("running");
  });
}

async function turn(stub: ReturnType<typeof agent>, id: string, text: string) {
  await stub.ingest(message(id, text));
  await settle(stub);
}

/** The data on each Confirm button sent so far, in order. */
const buttonsOf = (world: FakeWorld) =>
  world.sends.flatMap((send) => send.buttons?.flat().map((button) => button.data) ?? []);

const REFUSED = "Este botão não funciona mais.";

afterEach(() => {
  replacePortsForTesting(undefined);
  vi.restoreAllMocks();
});

describe("Kelpie's Confirm button on Telegram (ADR-0067 §3)", () => {
  it("puts a Confirm button under a confirmation's notice, carrying its random id", async () => {
    const world = use(
      fakeWorld([toolCalls({ name: "change", input: { to: "smart" } }), reply("Confirme.")]),
    );
    gated(world);
    const stub = agent("press-notice");
    await turn(stub, "m1", "mude para smart");

    const [answer, notice] = world.sends;
    expect(answer?.buttons).toBeUndefined();
    const code = /código ([A-Z0-9]{6})\./.exec(notice?.text ?? "")?.[1] ?? "";
    // The notice says the button is there, and the code still works typed.
    expect(notice?.text).toBe(
      `Confirme: change the tier to {"to":"smart"}.\nPara seguir, toque em Confirmar, ou responda só com o código ${code}. Expira em 10 minutos.`,
    );
    expect(notice?.buttons).toEqual([
      [{ label: "Confirmar", data: expect.stringMatching(/^confirm:[0-9a-f]{32}$/) }],
    ]);
    // The id is random, not the confirmation's counter, and the model never sees it.
    const [data = ""] = buttonsOf(world);
    const id = data.slice("confirm:".length);
    const rows = await runInDurableObject(stub, (_instance: ConversationAgent, state) =>
      state.storage.sql.exec("SELECT id, button_id FROM confirmations").toArray(),
    );
    expect(rows).toEqual([{ id: 1, button_id: id }]);
    expect(JSON.stringify(world.requests)).not.toContain(id);
    expect(JSON.stringify(await stub.outbox())).not.toContain(id);
  });

  it("confirms with a tap exactly the confirmation it is under, once", async () => {
    const world = use(
      fakeWorld([
        toolCalls(
          { name: "change", input: { to: "smart" } },
          { name: "change", input: { to: "frontier" } },
        ),
        reply("Confirme as duas."),
        toolCalls({ name: "change", input: { to: "frontier" } }),
        reply("Feito."),
      ]),
    );
    const ran = gated(world);
    const stub = agent("press-confirms");
    await turn(stub, "m1", "mude os dois");
    const [, frontier = ""] = buttonsOf(world);
    expect(buttonsOf(world)).toHaveLength(2);
    expect(new Set(buttonsOf(world)).size).toBe(2);

    // Tapped twice before the turn runs, it is still one message, with the code for the owner.
    expect(await stub.press(tap(frontier))).toEqual({ status: "accepted" });
    expect(await stub.press(tap(frontier, { pressId: "4382bfdwdsb323b2da" }))).toEqual({
      status: "accepted",
    });
    expect(world.pressAnswers).toEqual([
      { destination: chat, pressId: "4382bfdwdsb323b2d9" },
      { destination: chat, pressId: "4382bfdwdsb323b2da" },
    ]);
    expect(world.edits).toEqual([
      {
        destination: chat,
        providerMessageId: "43",
        text: 'Confirme: change the tier to {"to":"frontier"}.\nVocê confirmou.',
      },
      expect.objectContaining({ providerMessageId: "43" }),
    ]);
    await settle(stub);
    expect(ran).toEqual([{ to: "frontier" }]);
    expect(world.sent.at(-1)).toBe("Feito.");

    // Used, it takes no more taps: the tap is told so, and the notice stays as it is.
    expect(await stub.press(tap(frontier, { pressId: "4382bfdwdsb323b2db" }))).toEqual({
      status: "refused",
    });
    expect(world.pressAnswers.at(-1)).toEqual({
      destination: chat,
      pressId: "4382bfdwdsb323b2db",
      text: REFUSED,
    });
    expect(world.edits).toHaveLength(2);
    expect((await stub.turns()).length).toBe(2);
  });

  it("changes nothing for another user, an expired confirmation, or a forged or foreign id", async () => {
    const world = use(
      fakeWorld([toolCalls({ name: "change", input: { to: "smart" } }), reply("Confirme.")]),
    );
    const ran = gated(world);
    const stub = agent("press-refused");
    await turn(stub, "m1", "mude para smart");
    const [data = ""] = buttonsOf(world);

    // Ingress admits only the owner, but the conversation still counts only the requester.
    const refused = [
      tap(data, { userId: "u-other" }),
      tap("confirm:0123456789abcdef0123456789abcdef"),
      tap(`${data}0`),
      tap(data.replace("confirm:", "approve:")),
      tap("confirm:1"),
      tap(""),
    ];
    for (const target of refused) {
      expect(await stub.press(target), target.data).toEqual({ status: "refused" });
    }
    // In another chat's conversation, the id names nothing. Where nothing was said yet, the tap
    // is answered in the language the owner's app is set to.
    expect(
      await agent("press-refused-other").press(
        tap(data, { destination: { channel: "telegram", threadId: "2002" }, language: "pt-br" }),
      ),
    ).toEqual({ status: "refused" });
    world.clock += 11 * 60_000;
    expect(await stub.press(tap(data))).toEqual({ status: "refused" });

    expect(world.pressAnswers.map((answer) => answer.text)).toEqual(
      Array(refused.length + 2).fill(REFUSED),
    );
    expect(world.edits).toEqual([]);
    await stub.flush();
    expect(await stub.turns()).toHaveLength(1);
    expect(ran).toEqual([]);
  });

  it("refuses a tap meant for another conversation's agent or chat", async () => {
    use(fakeWorld([reply("Oi.")]));
    const stub = agent("press-bound");
    await turn(stub, "m1", "oi");
    expect(await stub.press(tap("confirm:x", { agentId: "other" }))).toEqual({
      status: "rejected",
      reason: "agent_mismatch",
    });
    expect(
      await stub.press(tap("confirm:x", { destination: { channel: "telegram", threadId: "9" } })),
    ).toEqual({ status: "rejected", reason: "destination_mismatch" });
  });

  it("keeps the typed code, after which the button no longer works", async () => {
    const world = use(
      fakeWorld([
        toolCalls({ name: "change", input: { to: "smart" } }),
        reply("Confirme."),
        toolCalls({ name: "change", input: { to: "smart" } }),
        reply("Feito."),
      ]),
    );
    const ran = gated(world);
    const stub = agent("press-typed");
    await turn(stub, "m1", "mude para smart");
    const code = /código ([A-Z0-9]{6})\./.exec(world.sent.at(-1) ?? "")?.[1] ?? "";
    await turn(stub, "m2", code);
    expect(ran).toEqual([{ to: "smart" }]);
    const [data = ""] = buttonsOf(world);
    expect(await stub.press(tap(data))).toEqual({ status: "refused" });
  });

  it("counts a tap only on a notice the owner was shown", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const world = use(
      fakeWorld([toolCalls({ name: "change", input: { to: "smart" } }), reply("Confirme.")]),
    );
    gated(world);
    // The reply goes out; its notice doesn't.
    world.failSends.add(1);
    const stub = agent("press-unshown");
    await turn(stub, "m1", "mude para smart");
    const id = await runInDurableObject(
      stub,
      (_instance: ConversationAgent, state) =>
        state.storage.sql.exec("SELECT button_id FROM confirmations").one().button_id,
    );
    expect(await stub.press(tap(`confirm:${id}`))).toEqual({ status: "refused" });
  });

  it("still counts a tap when the channel can't answer it or edit the notice", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const world = use(
      fakeWorld([
        toolCalls({ name: "change", input: { to: "smart" } }),
        reply("Confirme."),
        toolCalls({ name: "change", input: { to: "smart" } }),
        reply("Feito."),
      ]),
    );
    const ran = gated(world);
    const stub = agent("press-unanswered");
    await turn(stub, "m1", "mude para smart");
    world.failPressReplies = true;
    expect(await stub.press(tap(buttonsOf(world)[0] ?? ""))).toEqual({ status: "accepted" });
    expect(warned).toHaveBeenCalledWith("ConversationAgent: a tap wasn't answered", {
      reason: "failed",
    });
    expect(warned).toHaveBeenCalledWith("ConversationAgent: a notice wasn't edited", {
      reason: "failed",
    });
    await settle(stub);
    expect(ran).toEqual([{ to: "smart" }]);
  });
});
