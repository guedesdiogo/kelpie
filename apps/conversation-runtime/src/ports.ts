import {
  CAPABILITIES,
  type ChannelCapabilities,
  type ChannelEgressContract,
  type ChannelId,
  type SendOutcome,
  typingRenewIntervalMs,
} from "@kelpie/channels";
import { fromNdjsonStream, type LlmEvent, type ModelTier, type RoutedRequest } from "@kelpie/llm";
import type { Qualifier } from "@kelpie/qualifier";

/** Where a conversation's replies go. */
export interface Destination {
  channel: ChannelId;
  threadId: string;
}

/** One model call: its events, and a way to stop it on the gateway's side. */
export interface ModelCall {
  events: AsyncIterable<LlmEvent>;
  cancel(): void;
}

/** Everything the ConversationAgent needs from outside, so tests can replace it (ADR-0002). */
export interface ConversationPorts {
  generate(tier: ModelTier, request: RoutedRequest): Promise<ModelCall>;
  /**
   * Sends one bubble through the agent's channel (channel-egress). A failure is a value: rate
   * limited with the wait, recipient unavailable, not connected, or failed.
   */
  send(
    agentId: string,
    destination: Destination,
    text: string,
    options: { silent: boolean },
  ): Promise<SendOutcome>;
  /** Shows "typing" once. It is a courtesy, so callers ignore its failures. */
  typing(agentId: string, destination: Destination): Promise<void>;
  /** Keeps "typing" showing, renewed before it lapses, until `signal` aborts. */
  keepTyping(agentId: string, destination: Destination, signal: AbortSignal): Promise<void>;
  /** The end-of-turn qualifier, or null for the keyless heuristic (ADR-0009). */
  qualifier: Qualifier | null;
  now(): number;
  /** Waits `ms`, or rejects as soon as `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

/** The part of llm-gateway's RPC surface this Worker uses. */
interface LlmGatewayBinding {
  generate(
    tier: ModelTier,
    request: RoutedRequest,
  ): Promise<{
    events(): Promise<ReadableStream<Uint8Array>>;
    cancel(): Promise<void>;
  }>;
}

let portsForTesting: ConversationPorts | undefined;

/** Tests run in the Worker's isolate and swap the ports with this. Production never calls it. */
export function replacePortsForTesting(ports: ConversationPorts | undefined): void {
  portsForTesting = ports;
}

export function portsFor(env: Env): ConversationPorts {
  return portsForTesting ?? productionPorts(env);
}

function productionPorts(env: Env): ConversationPorts {
  const gateway = env.LLM_GATEWAY as unknown as LlmGatewayBinding;
  // A service binding to channel-egress's ChannelEgress entrypoint, which answers with values.
  const egress = env.CHANNEL_EGRESS as unknown as ChannelEgressContract;
  return {
    async generate(tier, request) {
      const generation = await gateway.generate(tier, request);
      const dispose = () => (generation as Partial<Disposable>)[Symbol.dispose]?.();
      // Cancelling the stream doesn't cross RPC, so stopping early calls cancel() explicitly.
      const cancel = () => {
        generation.cancel().catch(() => {
          // The call may already be over; there is nothing left to stop.
        });
      };
      const stream = await generation.events();
      async function* events() {
        try {
          yield* fromNdjsonStream(stream, cancel);
        } finally {
          dispose();
        }
      }
      return {
        events: events(),
        cancel: () => {
          cancel();
          dispose();
        },
      };
    },
    send: (agentId, destination, text, options) => egress.send(agentId, destination, text, options),
    async typing(agentId, destination) {
      await bounded(egress.typing(agentId, destination));
    },
    async keepTyping(agentId, destination, signal) {
      const capabilities = (CAPABILITIES as Partial<Record<ChannelId, ChannelCapabilities>>)[
        destination.channel
      ];
      const interval = capabilities ? typingRenewIntervalMs(capabilities) : null;
      while (!signal.aborted) {
        const outcome = await bounded(egress.typing(agentId, destination));
        // No bot, or no reachable recipient: renewing would fail the same way.
        if (
          outcome?.ok === false &&
          outcome.reason !== "rate_limited" &&
          outcome.reason !== "failed"
        ) {
          return;
        }
        if (interval === null) return;
        const wait =
          outcome?.ok === false && outcome.reason === "rate_limited"
            ? Math.max(interval, outcome.retryAfterMs)
            : interval;
        try {
          await sleep(wait, signal);
        } catch {
          return;
        }
      }
    },
    qualifier: null,
    now: () => Date.now(),
    sleep,
  };
}

/** "Typing" is a courtesy: a call that hangs or fails is given up after a few seconds. */
const TYPING_TIMEOUT_MS = 3_000;

async function bounded<T>(call: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), TYPING_TIMEOUT_MS);
  });
  try {
    return await Promise.race([call.catch(() => undefined), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Waits `ms`, or rejects as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
