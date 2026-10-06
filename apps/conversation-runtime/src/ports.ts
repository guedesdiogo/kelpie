import {
  CAPABILITIES,
  type ChannelCapabilities,
  type ChannelEgressContract,
  type ChannelId,
  type SendOutcome,
  typingRenewIntervalMs,
} from "@kelpie/channels";
import type {
  ContextStoreContract,
  RecallOptions,
  RecallResult,
  WriteResult,
} from "@kelpie/context-store/contract";
import type { Destination } from "@kelpie/conversation/contract";
import { fromNdjsonStream, type LlmEvent, type ModelTier, type RoutedRequest } from "@kelpie/llm";
import { memoryTools } from "./memory-tools.ts";
import type { ToolProvider } from "./tools.ts";

/** One model call: its events, and a way to stop it on the gateway's side. */
export interface ModelCall {
  events: AsyncIterable<LlmEvent>;
  cancel(): void;
}

/**
 * What a turn is doing, for channels that can show it (#141): reading memory, thinking (a model
 * call) or running a tool; `idle` once it stopped without a reply.
 */
export type TurnStep = "memory" | "thinking" | "tool" | "idle";

/** Everything the ConversationAgent needs from outside, so tests can replace it (ADR-0002). */
export interface ConversationPorts {
  generate(tier: ModelTier, request: RoutedRequest): Promise<ModelCall>;
  /** The providers of the agents' tools (ADR-0014). */
  tools: readonly ToolProvider[];
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
  /**
   * Shows the turn's step, on channels whose capabilities say they can (the webchat); the others
   * keep "typing" up instead. A courtesy, like "typing".
   */
  status(agentId: string, destination: Destination, step: TurnStep, label?: string): Promise<void>;
  /**
   * Writes memory files to the vault through the Context Store (ADR-0020 §3). A refusal is a value;
   * a store that is unreachable, or doesn't answer in time, throws.
   */
  remember(
    agentId: string,
    changes: { path: string; content: string | null }[],
    summary: string,
  ): Promise<WriteResult>;
  /**
   * The vault's notes that answer a question, packed within a budget, through the Context Store
   * (#110). The block is empty when nothing matches or the vault is off; a store that is
   * unreachable, or doesn't answer in time, throws.
   */
  recall(agentId: string, question: string, options: RecallOptions): Promise<RecallResult>;
  now(): number;
  /** Waits `ms`, or rejects as soon as `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /**
   * Resolves once `ms` pass, for the turn's time bound on a running tool (ADR-0025); never once
   * `signal` aborts, which also clears its timer.
   */
  deadline(ms: number, signal: AbortSignal): Promise<void>;
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
  // A service binding to context-store's ContextStore entrypoint.
  const contextStore = env.CONTEXT_STORE as unknown as ContextStoreContract;
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
    // The setup agent's (#48) arrive as providers too.
    tools: [
      memoryTools({
        search: (agentId, query, options) =>
          withTimeout(contextStore.search(agentId, query, options), SEARCH_TIMEOUT_MS),
        readNote: (agentId, path, options) =>
          withTimeout(contextStore.readNote(agentId, path, options), READ_TIMEOUT_MS),
      }),
    ],
    send: (agentId, destination, text, options) => egress.send(agentId, destination, text, options),
    remember: (agentId, changes, summary) =>
      withTimeout(contextStore.write(agentId, changes, summary), REMEMBER_TIMEOUT_MS),
    recall: (agentId, question, options) =>
      withTimeout(contextStore.recall(agentId, question, options), RECALL_TIMEOUT_MS),
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
    // No channel behind channel-egress shows a turn's step: they keep "typing" up instead.
    async status() {},
    now: () => Date.now(),
    sleep,
    deadline: (ms, signal) => sleep(ms, signal).catch(() => new Promise<void>(() => {})),
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

/**
 * A memory write the Context Store hasn't answered after this long counts as failed, to be tried
 * again; it only queues the files, so it answers well within this. A schedule runs it, and the
 * object's schedules run one at a time, so it must not hold up a reply's.
 */
const REMEMBER_TIMEOUT_MS = 10_000;

/**
 * A recall the Context Store hasn't answered after this long is given up, and the turn goes on
 * without memory. The store bounds its own calls: 2 s to embed the question, 3.5 s for the rerank.
 */
const RECALL_TIMEOUT_MS = 6_000;
/** The memory tools (#126): a search embeds and reranks as recall does; a read is one lookup. */
const SEARCH_TIMEOUT_MS = 8_000;
const READ_TIMEOUT_MS = 5_000;

async function withTimeout<T>(call: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([call, timeout]);
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
