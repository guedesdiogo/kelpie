import type { SendOutcome } from "@kelpie/channels";
import type { Destination } from "@kelpie/conversation/contract";
import type { AssistantMessage, LlmEvent, RoutedRequest, Usage } from "@kelpie/llm";
import type { Qualifier } from "@kelpie/qualifier";
import type { ConversationPorts, ModelCall } from "../src/ports.ts";

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

/** What the fake model reports for every answer: one attempt, part of the prompt from cache. */
export const FAKE_USAGE: Usage[] = [
  { model: "claude-haiku-4-5", inputUncached: 1_200, cacheRead: 800, cacheWrite: 0, output: 40 },
];

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
  /** Every bubble sent, with whether it went out silently. */
  sends: { text: string; silent: boolean }[];
  typing: number;
  /** How many times "typing" was kept up while the model answered, and how many times it stopped. */
  typingKept: number;
  typingStopped: number;
  /** Sleeps with these call numbers (0-based) wait until the turn is aborted. */
  blockSleeps: Set<number>;
  /** Sends with these call numbers wait until removed from the set. */
  blockSends: Set<number>;
  /** Sends with these call numbers never complete; only an eviction ends them. */
  hangSends: Set<number>;
  /** Sends with these call numbers fail. */
  failSends: Set<number>;
  /** Sends with these call numbers are rate-limited, asking for `rateLimitWaitMs`. */
  rateLimitSends: Set<number>;
  rateLimitWaitMs: number;
  /** How long each sleep was asked to wait, in call order. */
  sleeps: number[];
  /** Every send attempt, delivered or not. */
  sendAttempts: number;
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
    sends: [],
    typing: 0,
    typingKept: 0,
    typingStopped: 0,
    blockSleeps: new Set(),
    blockSends: new Set(),
    hangSends: new Set(),
    failSends: new Set(),
    rateLimitSends: new Set(),
    rateLimitWaitMs: 50,
    sleeps: [],
    sendAttempts: 0,
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
              yield {
                type: "finish",
                reason: "refusal",
                message: assistant(""),
                usage: FAKE_USAGE,
              };
              return;
            case "reply":
              yield { type: "text", delta: script.text };
              yield {
                type: "finish",
                reason: "stop",
                message: assistant(script.text),
                usage: FAKE_USAGE,
              };
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
      async send(_agentId, _destination: Destination, text, options): Promise<SendOutcome> {
        const call = sends++;
        world.sendAttempts += 1;
        if (world.failSends.has(call)) return { ok: false, reason: "failed" };
        if (world.rateLimitSends.has(call)) {
          return { ok: false, reason: "rate_limited", retryAfterMs: world.rateLimitWaitMs };
        }
        if (world.hangSends.has(call)) await new Promise(() => {});
        // Polls a plain flag: a promise created here can't be resolved from the test's context.
        while (world.blockSends.has(call)) await new Promise((resolve) => setTimeout(resolve, 5));
        world.sent.push(text);
        world.sends.push({ text, silent: options.silent });
        return { ok: true, providerMessageId: `m-${call}` };
      },
      async typing() {
        world.typing += 1;
        if (world.failTyping) throw new Error("typing failed");
      },
      keepTyping(_agentId, _destination, signal) {
        world.typingKept += 1;
        return new Promise<void>((resolve) => {
          const stop = () => {
            world.typingStopped += 1;
            resolve();
          };
          if (signal.aborted) stop();
          else signal.addEventListener("abort", stop, { once: true });
        });
      },
      qualifier: null,
      now: () => world.clock,
      sleep(ms, signal) {
        const call = sleeps++;
        world.sleeps.push(ms);
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
