import type { Remote } from "@kelpie/access";
import {
  CAPABILITIES,
  type ChannelCapabilities,
  type ChannelEgressContract,
  type ChannelId,
  type SendOutcome,
  type SetupFormsContract,
  typingRenewIntervalMs,
} from "@kelpie/channels";
import {
  type AgentHostContract,
  type ConfigPorts,
  createConfigCommands,
  REGISTRY_NAME,
  type RegistryContract,
  type SetupStep,
} from "@kelpie/config";
import type {
  ContextStoreContract,
  MemoryCoreResult,
  RecallOptions,
  RecallResult,
  WriteResult,
} from "@kelpie/context-store/contract";
import type { Destination } from "@kelpie/conversation/contract";
import {
  fromNdjsonStream,
  type ModelSelection,
  type RoutedRequest,
  type RouterEvent,
} from "@kelpie/llm";
import { mainAgentTools } from "./main-agent.ts";
import { memoryTools } from "./memory-tools.ts";
import { setupTools } from "./setup-agent.ts";
import { taskTools } from "./task-tools.ts";
import type { ToolProvider } from "./tools.ts";

/** One model call: its events, the router's fallbacks among them, and a way to stop it. */
export interface ModelCall {
  events: AsyncIterable<RouterEvent>;
  cancel(): void;
}

/**
 * What a turn is doing, for channels that can show it (#141): reading memory, thinking (a model
 * call) or running a tool; `idle` once it stopped without a reply.
 */
export type TurnStep = "memory" | "thinking" | "tool" | "idle";

/** Everything the ConversationAgent needs from outside, so tests can replace it (ADR-0002). */
export interface ConversationPorts {
  /** One model call, for an area with the agent's model settings (ADR-0036 §2). */
  generate(selection: ModelSelection, request: RoutedRequest): Promise<ModelCall>;
  /** The providers of the agents' tools (ADR-0014). */
  tools: readonly ToolProvider[];
  /**
   * Sends one bubble through the agent's channel (channel-egress). A failure is a value: rate
   * limited with the wait, recipient unavailable, not connected, or failed. `previewUrl` is the one
   * link in the bubble the channel may preview (#130); without it, none is. `links` makes the
   * bubble a formatted reply that may link those URLs (#188); without it, the text goes as typed.
   * `confirmation` makes it a confirmation's notice with a Confirm button, where the channel has
   * one (#186): the webchat; channel-egress never gets it.
   */
  send(
    agentId: string,
    destination: Destination,
    text: string,
    options: {
      silent: boolean;
      previewUrl?: string;
      links?: readonly string[];
      confirmation?: number;
    },
  ): Promise<SendOutcome>;
  /**
   * Tells an agent's AgentHost that the conversation named `conversation` waits for one of its setup
   * steps until `until` (#206). Bounded; a failure throws.
   */
  awaitSetup(agentId: string, conversation: string, step: SetupStep, until: number): Promise<void>;
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
  /**
   * The agent's always-loaded core (#112), through the Context Store: one block within a budget,
   * empty when nothing is pinned or the vault is off. A store that is unreachable, or doesn't
   * answer in time, throws.
   */
  core(agentId: string, budgetTokens: number): Promise<MemoryCoreResult>;
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
    selection: ModelSelection,
    request: RoutedRequest,
  ): Promise<{
    events(): Promise<ReadableStream<Uint8Array>>;
    cancel(): Promise<void>;
  }>;
}

/** llm-gateway's admin entrypoint: the instance's model settings, for the setup agent (#289). */
interface LlmGatewayAdminBinding {
  providers: ConfigPorts["models"]["providers"];
  instanceModels: ConfigPorts["models"]["view"];
  configureDefaults: ConfigPorts["models"]["configure"];
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
  const gatewayAdmin = env.LLM_GATEWAY_ADMIN as unknown as LlmGatewayAdminBinding;
  // A service binding to channel-egress's ChannelEgress entrypoint, which answers with values.
  const egress = env.CHANNEL_EGRESS as unknown as ChannelEgressContract;
  // A service binding to context-store's ContextStore entrypoint.
  const contextStore = env.CONTEXT_STORE as unknown as ContextStoreContract;
  // A service binding to channel-egress's SetupForms entrypoint, which only opens a form, reads the
  // runner's state, which holds no secret, and disconnects a deleted agent's bot (#303).
  const forms = env.SETUP_FORMS as unknown as SetupFormsContract;
  // Typed as the contracts the admin API binds, so both clients of the commands match.
  const registry = env.REGISTRY.getByName(REGISTRY_NAME) as unknown as Remote<RegistryContract>;
  const agentHost = (id: string) =>
    env.AGENT_HOST.getByName(id) as unknown as Remote<AgentHostContract>;
  const commands = createConfigCommands({
    registry,
    agents: {
      configure: (id, changes, actor) => agentHost(id).configure(changes, actor),
      config: (id) => agentHost(id).config(),
      erase: (id, conversations) => agentHost(id).erase(conversations),
    },
    directory: {
      issuePairingCode: notBound,
      enableIdentity: notBound,
      disableIdentity: notBound,
      listIdentities: notBound,
      setTimeZone: notBound,
    },
    tasks: {
      create: (agentId, task, actor) => agentHost(agentId).createTask(task, actor),
      edit: (agentId, taskId, edit, actor) => agentHost(agentId).editTask(taskId, edit, actor),
      move: (agentId, taskId, status, actor) => agentHost(agentId).moveTask(taskId, status, actor),
      comment: (agentId, taskId, text, actor) =>
        agentHost(agentId).commentTask(taskId, text, actor),
      requestStop: (agentId, taskId, actor) => agentHost(agentId).requestStop(taskId, actor),
      list: (agentId, status) => agentHost(agentId).listTasks(status),
      get: (agentId, taskId) => agentHost(agentId).getTask(taskId),
    },
    channels: {
      createTelegramForm: (agentId) => forms.createTelegramForm(agentId),
      registerTelegramWebhook: notBound,
      describeTelegramBot: notBound,
      createRunnerForm: () => forms.createRunnerForm(),
      describeRunner: () => forms.describeRunner(),
      disconnectTelegram: (agentId) => forms.disconnectTelegram(agentId),
    },
    models: {
      providers: () => gatewayAdmin.providers(),
      view: () => gatewayAdmin.instanceModels(),
      configure: (settings, actor) => gatewayAdmin.configureDefaults(settings, actor),
    },
    vault: { held: notBound, forget: notBound, setDream: notBound },
  });
  return {
    async generate(selection, request) {
      const generation = await gateway.generate(selection, request);
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
    tools: [
      memoryTools({
        search: (agentId, query, options) =>
          withTimeout(contextStore.search(agentId, query, options), SEARCH_TIMEOUT_MS),
        readNote: (agentId, path, options) =>
          withTimeout(contextStore.readNote(agentId, path, options), READ_TIMEOUT_MS),
        writeNote: (agentId, input, options) =>
          withTimeout(contextStore.writeNote(agentId, input, options), REMEMBER_TIMEOUT_MS),
      }),
      // The setup agent's (#48): the same commands as the admin API, minus the ones that need the
      // Directory, the vault's admin entrypoint or more of channel-egress than opening a form,
      // which this Worker doesn't bind.
      setupTools(commands, { adminOrigin: env.ADMIN_ORIGIN }),
      // The main agent's (#289): other agents' model trios, behind the owner's confirmation.
      mainAgentTools(commands, async (id) => (await registry.get(id))?.role ?? null),
      // The task tools (#335): a run ends its task, and an agent hands work to those it owns.
      taskTools({
        owned: async (id) =>
          (await registry.list()).filter((agent) => agent.owner === id).map((agent) => agent.id),
        create: (assignee, task, creator) =>
          env.AGENT_HOST.getByName(assignee).createTaskFor(task, creator),
        // Only an agent the Registry lists: a model-named id makes no object.
        comment: async (assignee, taskId, text, by) =>
          (await registry.get(assignee))
            ? env.AGENT_HOST.getByName(assignee).commentTaskAs(taskId, text, by, "chat")
            : { ok: false, reason: "unknown_task" },
      }),
    ],
    awaitSetup: (agentId, conversation, step, until) =>
      withTimeout(agentHost(agentId).awaitSetup(conversation, step, until), AWAIT_SETUP_TIMEOUT_MS),
    // A Confirm button is the webchat's alone (#186): channel-egress takes only what it sends.
    send: (agentId, destination, text, { confirmation: _button, ...options }) =>
      egress.send(agentId, destination, text, options),
    remember: (agentId, changes, summary) =>
      withTimeout(contextStore.write(agentId, changes, summary), REMEMBER_TIMEOUT_MS),
    recall: (agentId, question, options) =>
      withTimeout(contextStore.recall(agentId, question, options), RECALL_TIMEOUT_MS),
    core: (agentId, budgetTokens) =>
      withTimeout(contextStore.core(agentId, budgetTokens), CORE_TIMEOUT_MS),
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

/**
 * What the setup agent's tools never call: the commands that need the Directory, the vault's admin
 * entrypoint, or channel-egress beyond opening a form and reading the runner's state. Binding the
 * Directory here would make ingress and this Worker bind each other.
 */
function notBound(): Promise<never> {
  return Promise.reject(new Error("not bound in conversation-runtime"));
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
/** The core (#112) is one read of memory's index, with nothing to embed or rerank. */
const CORE_TIMEOUT_MS = 5_000;
/** Noting a setup step's wait is one write in the agent's object (#206). */
const AWAIT_SETUP_TIMEOUT_MS = 3_000;
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
