import type { SendOutcome } from "@kelpie/channels";
import type { Destination } from "@kelpie/conversation/contract";
import type { AssistantMessage, LlmEvent, RoutedRequest, Usage } from "@kelpie/llm";
import type { ConversationPorts, ModelCall } from "../src/ports.ts";

// The Worker runs in the test's isolate, so these fakes replace the ConversationAgent's ports.

/**
 * The message of failures tests inject into a Durable Object. workerd reports a rejected RPC method
 * as unhandled even when its caller handles it, so `vitest.config.ts` ignores errors with it.
 */
export const INJECTED_FAILURE = "injected test failure";

type ModelScript =
  | { kind: "reply"; text: string; usage?: Usage[] }
  /** Replies once the test clears `world.modelHeld`. */
  | { kind: "held"; text: string }
  | { kind: "refuse" }
  /** Never answers; ends when the call is cancelled. */
  | { kind: "hang" }
  /** The stream fails mid-way. */
  | { kind: "fail" }
  /** The stream ends without a finish event. */
  | { kind: "truncate" };

export const reply = (text: string, usage?: Usage[]): ModelScript =>
  usage ? { kind: "reply", text, usage } : { kind: "reply", text };
export const held = (text: string): ModelScript => ({ kind: "held", text });
export const refuse = (): ModelScript => ({ kind: "refuse" });
export const hang = (): ModelScript => ({ kind: "hang" });
export const fail = (): ModelScript => ({ kind: "fail" });
export const truncate = (): ModelScript => ({ kind: "truncate" });

/** What the fake model reports for every answer: one attempt, part of the prompt from cache. */
export const FAKE_USAGE: Usage[] = [
  { model: "claude-haiku-4-5", inputUncached: 1_200, cacheRead: 800, cacheWrite: 0, output: 40 },
];

/** A prompt past the history budget (ADR-0017): 120,000 tokens in all. */
export const OVER_BUDGET: Usage[] = [
  {
    model: "claude-haiku-4-5",
    inputUncached: 20_000,
    cacheRead: 100_000,
    cacheWrite: 0,
    output: 40,
  },
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
  /** The tier of each model call, in call order. */
  tiers: string[];
  /** While set, a `held` script waits before it replies. */
  modelHeld: boolean;
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
  /** Every memory write, in order. */
  remembered: { agentId: string; changes: { path: string; content: string | null }[] }[];
  /** While set, memory writes throw, as an unreachable Context Store would. */
  failRemember: boolean;
}

export function fakeWorld(scripts: ModelScript[]): FakeWorld {
  let sleeps = 0;
  let sends = 0;
  const world: FakeWorld = {
    clock: Date.now() + 60_000,
    requests: [],
    tiers: [],
    modelHeld: false,
    cancelled: 0,
    sent: [],
    sends: [],
    remembered: [],
    failRemember: false,
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
      async generate(tier, request): Promise<ModelCall> {
        world.requests.push(structuredClone(request));
        world.tiers.push(tier);
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
            case "held":
              // Polls a plain flag: a promise created here can't be resolved from the test's context.
              while (world.modelHeld) await new Promise((resolve) => setTimeout(resolve, 5));
              yield {
                type: "finish",
                reason: "stop",
                message: assistant(script.text),
                usage: FAKE_USAGE,
              };
              return;
            case "reply":
              yield { type: "text", delta: script.text };
              yield {
                type: "finish",
                reason: "stop",
                message: assistant(script.text),
                usage: script.usage ?? FAKE_USAGE,
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
      async remember(agentId, changes) {
        if (world.failRemember) throw new Error(INJECTED_FAILURE);
        world.remembered.push({ agentId, changes });
        return { ok: true };
      },
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
