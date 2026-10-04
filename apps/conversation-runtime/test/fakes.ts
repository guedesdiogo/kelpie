import type { AssistantMessage, LlmEvent, RoutedRequest } from "@kelpie/llm";
import type { Qualifier } from "@kelpie/qualifier";
import type { ConversationPorts, Destination, ModelCall } from "../src/ports.ts";

// The Worker runs in the test's isolate, so these fakes replace the ConversationAgent's ports.

/**
 * The message of failures tests inject into a Durable Object. workerd reports a rejected RPC method
 * as unhandled even when its caller handles it, so `vitest.config.ts` ignores errors with it.
 */
export const INJECTED_FAILURE = "injected test failure";

type ModelScript =
  | { kind: "reply"; text: string }
  | { kind: "refuse" }
  /** Never answers; ends when the call is cancelled. */
  | { kind: "hang" }
  /** The stream fails mid-way. */
  | { kind: "fail" }
  /** The stream ends without a finish event. */
  | { kind: "truncate" };

export const reply = (text: string): ModelScript => ({ kind: "reply", text });
export const refuse = (): ModelScript => ({ kind: "refuse" });
export const hang = (): ModelScript => ({ kind: "hang" });
export const fail = (): ModelScript => ({ kind: "fail" });
export const truncate = (): ModelScript => ({ kind: "truncate" });

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    parts: [{ type: "text", text }],
    native: { provider: "anthropic", model: "claude-haiku-4-5", content: [{ type: "text", text }] },
  };
}

export interface FakeWorld {
  ports: ConversationPorts;
  /** The time `now()` returns; tests move it. Starts a minute ahead so no schedule comes due. */
  clock: number;
  requests: RoutedRequest[];
  cancelled: number;
  sent: string[];
  typing: number;
  /** Sleeps with these call numbers (0-based) wait until the turn is aborted. */
  blockSleeps: Set<number>;
  /** Sends with these call numbers wait until removed from the set. */
  blockSends: Set<number>;
  /** Sends with these call numbers never complete; only an eviction ends them. */
  hangSends: Set<number>;
  /** Sends with these call numbers throw. */
  failSends: Set<number>;
  /** Every "typing" call throws. */
  failTyping: boolean;
}

export function fakeWorld(scripts: ModelScript[]): FakeWorld {
  let sleeps = 0;
  let sends = 0;
  const world: FakeWorld = {
    clock: Date.now() + 60_000,
    requests: [],
    cancelled: 0,
    sent: [],
    typing: 0,
    blockSleeps: new Set(),
    blockSends: new Set(),
    hangSends: new Set(),
    failSends: new Set(),
    failTyping: false,
    ports: {
      async generate(_tier, request): Promise<ModelCall> {
        world.requests.push(structuredClone(request));
        const script = scripts.shift() ?? reply("(no script left)");
        let release: (() => void) | undefined;
        const cancelledPromise = new Promise<void>((resolve) => {
          release = resolve;
        });
        async function* events(): AsyncIterable<LlmEvent> {
          switch (script.kind) {
            case "hang":
              await cancelledPromise;
              throw new Error("cancelled");
            case "fail":
              yield { type: "text", delta: "partial" };
              throw new Error("the gateway went away");
            case "truncate":
              yield { type: "text", delta: "partial" };
              return;
            case "refuse":
              yield { type: "finish", reason: "refusal", message: assistant(""), usage: [] };
              return;
            case "reply":
              yield { type: "text", delta: script.text };
              yield { type: "finish", reason: "stop", message: assistant(script.text), usage: [] };
          }
        }
        return {
          events: events(),
          cancel() {
            world.cancelled += 1;
            release?.();
          },
        };
      },
      async send(_destination: Destination, text: string) {
        const call = sends++;
        if (world.failSends.has(call)) throw new Error("the channel refused the message");
        if (world.hangSends.has(call)) await new Promise(() => {});
        // Polls a plain flag: a promise created here can't be resolved from the test's context.
        while (world.blockSends.has(call)) await new Promise((resolve) => setTimeout(resolve, 5));
        world.sent.push(text);
      },
      async typing() {
        world.typing += 1;
        if (world.failTyping) throw new Error("typing failed");
      },
      qualifier: null,
      now: () => world.clock,
      sleep(_ms, signal) {
        const call = sleeps++;
        if (!world.blockSleeps.has(call)) return Promise.resolve();
        return new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    },
  };
  return world;
}

/** A qualifier that takes `ms` to answer "finished", to hold a flush plan mid-decision. */
export function slowQualifier(ms: number): Qualifier {
  return {
    id: "fake",
    calibrated: false,
    async qualify(_state, questions) {
      await new Promise((resolve) => setTimeout(resolve, ms));
      const answers = Object.fromEntries(
        Object.keys(questions).map((key) => [key, { type: "noul" as const, noul: 0.95 }]),
      );
      return { answers, provider: "fake", calibrated: false };
    },
  };
}
