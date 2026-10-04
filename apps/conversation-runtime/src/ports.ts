import type { ChannelId } from "@kelpie/channels";
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
  send(destination: Destination, text: string): Promise<void>;
  typing(destination: Destination): Promise<void>;
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
  return {
    async generate(tier, request) {
      const generation = await gateway.generate(tier, request);
      // Cancelling the stream doesn't cross RPC, so stopping early calls cancel() explicitly.
      const cancel = () => void generation.cancel();
      return { events: fromNdjsonStream(await generation.events(), cancel), cancel };
    },
    // Channel egress arrives with the channel stories (3.6, 3.7).
    async send() {
      throw new Error("No channel egress is configured yet");
    },
    async typing() {
      throw new Error("No channel egress is configured yet");
    },
    qualifier: null,
    now: () => Date.now(),
    sleep: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
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
      }),
  };
}
