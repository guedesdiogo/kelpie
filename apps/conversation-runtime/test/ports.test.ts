import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { portsFor, replacePortsForTesting } from "../src/ports.ts";

// The production ports' model calls (#431): a call that carries the conversation's session goes
// through llm-gateway's LlmChat, the one entrypoint that takes a session; any other goes through
// LlmGateway, as before.

/** One of llm-gateway's entrypoints, answering each call with a finished reply. */
function entrypoint(name: string, calls: string[]) {
  return {
    async generate(_selection: unknown, _request: unknown, session?: unknown) {
      calls.push(`${name} ${session === undefined ? "without" : "with"} a session`);
      const finish = {
        type: "finish",
        reason: "stop",
        message: { role: "assistant", parts: [] },
        usage: [],
      };
      return {
        events: async () =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`${JSON.stringify(finish)}\n`));
              controller.close();
            },
          }),
        cancel: async () => {},
        answer: async () => ({ ok: true }),
      };
    },
  };
}

const session = {
  conversation: "assistant:telegram:chat-1",
  id: "6c1f2a9e-3b7d-4e51-9a0c-2f8d7e6b5a41",
  resume: false,
  toolLoopMs: 120_000,
};
const request = { system: "You are Kelpie.", messages: [], maxOutputTokens: 1024 };

describe("the model port (#431)", () => {
  it("sends a call with a session through LlmChat, and any other through LlmGateway", async () => {
    replacePortsForTesting(undefined);
    const calls: string[] = [];
    const ports = portsFor({
      ...env,
      LLM_GATEWAY: entrypoint("LlmGateway", calls),
      LLM_CHAT: entrypoint("LlmChat", calls),
    } as never);
    for (const sent of [session, undefined]) {
      const call = await ports.generate({ area: "conversation" }, request, sent);
      for await (const _event of call.events) {
        // Read to the end.
      }
    }
    expect(calls).toEqual(["LlmChat with a session", "LlmGateway without a session"]);
  });

  it("sends a call with a session through LlmGateway, without it, when LlmChat isn't bound (#432)", async () => {
    // As after a partial rollback to a build without the binding: LlmGateway refuses a session,
    // so the turn goes on without one, on a route that keeps none.
    replacePortsForTesting(undefined);
    const calls: string[] = [];
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ports = portsFor({
      ...env,
      LLM_GATEWAY: entrypoint("LlmGateway", calls),
      LLM_CHAT: undefined,
    } as never);
    const call = await ports.generate({ area: "conversation" }, request, session);
    for await (const _event of call.events) {
      // Read to the end.
    }
    expect(calls).toEqual(["LlmGateway without a session"]);
    expect(warned).toHaveBeenCalledWith(
      "conversation-runtime: LLM_CHAT isn't bound; the turn goes on without its session",
    );
    warned.mockRestore();
  });
});

describe("the channel ports (ADR-0067 §3)", () => {
  const destination = { channel: "telegram", threadId: "1001" } as const;
  const buttons = [[{ label: "Confirmar", data: "confirm:0f1e2d3c4b5a69788796a5b4c3d2e1f0" }]];

  /** channel-egress's ChannelEgress, recording each call; `answer` decides every outcome. */
  function egress(answer: () => Promise<unknown> = async () => ({ ok: true })) {
    const calls: unknown[][] = [];
    const record =
      (method: string) =>
      (...args: unknown[]) => {
        calls.push([method, ...args]);
        return answer();
      };
    return {
      calls,
      binding: { send: record("send"), edit: record("edit"), answer: record("answer") },
    };
  }

  it("sends a notice's buttons through channel-egress, and answers and edits there", async () => {
    replacePortsForTesting(undefined);
    const { calls, binding } = egress();
    const ports = portsFor({ ...env, CHANNEL_EGRESS: binding } as never);

    await ports.send("kelpie", destination, "Confirme.", {
      silent: false,
      confirmation: 3,
      buttons,
    });
    expect(
      await ports.answer("kelpie", destination, "4382", "Este botão não funciona mais."),
    ).toEqual({ ok: true });
    expect(await ports.edit("kelpie", destination, "43", "Confirme.\nVocê confirmou.")).toEqual({
      ok: true,
    });
    // The webchat's own button stays the webchat's: channel-egress gets the buttons it shows.
    expect(calls).toEqual([
      ["send", "kelpie", destination, "Confirme.", { silent: false, buttons }],
      ["answer", "kelpie", destination, "4382", "Este botão não funciona mais."],
      ["edit", "kelpie", destination, "43", "Confirme.\nVocê confirmou."],
    ]);
  });

  it("gives up on an answer that hangs, after a few seconds, as on typing", async () => {
    replacePortsForTesting(undefined);
    const { binding } = egress(() => new Promise(() => {}));
    const ports = portsFor({ ...env, CHANNEL_EGRESS: binding } as never);
    expect(await ports.answer("kelpie", destination, "4382")).toEqual({
      ok: false,
      reason: "failed",
    });
  });

  it("gives up on an answer or an edit that fails, as on typing", async () => {
    replacePortsForTesting(undefined);
    const { binding } = egress(async () => {
      throw new Error("channel-egress is unreachable");
    });
    const ports = portsFor({ ...env, CHANNEL_EGRESS: binding } as never);
    expect(await ports.answer("kelpie", destination, "4382")).toEqual({
      ok: false,
      reason: "failed",
    });
    expect(await ports.edit("kelpie", destination, "43", "x")).toEqual({
      ok: false,
      reason: "failed",
    });
  });
});
