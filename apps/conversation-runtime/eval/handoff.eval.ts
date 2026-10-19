// The handoff evaluation (#287): how often Master hands a demand within a specialist's
// remit to that specialist, and whether it hands off any demand that needs none. It runs the real
// turn, with Master's prompt, roster and tools, on production's cheap route, so it calls a
// paid model: it runs only with `bun run --filter @kelpie/conversation-runtime eval:handoff`, and
// otherwise skips itself.
import { env } from "cloudflare:workers";
import { REGISTRY_NAME, type TaskView } from "@kelpie/config";
import {
  AnthropicMessagesProvider,
  type LlmProvider,
  ModelRouter,
  OpenAIResponsesProvider,
  type ProviderId,
  type RouterEvent,
} from "@kelpie/llm";
import { describe, expect, it, vi } from "vitest";
import { replaceTaskRunnerForTesting } from "../src/agent-host/agent-host.ts";
import { configurationTools } from "../src/configuration.ts";
import { memoryTools } from "../src/memory-tools.ts";
import { replacePortsForTesting } from "../src/ports.ts";
import { subagentTools } from "../src/subagent-tools.ts";
import { taskTools } from "../src/task-tools.ts";
import type { ToolProvider } from "../src/tools.ts";
import { fakeWorld } from "../test/fakes.ts";
import { CASES, type HandoffCase, ROSTER } from "./handoff-cases.ts";

const models = env as unknown as {
  EVAL_MODELS?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
};
const enabled = models.EVAL_MODELS === "1";

/** Each prompt runs this many times, each in a conversation of its own. */
const REPETITIONS = 3;
/** Conversations in flight at once. */
const CONCURRENCY = 6;
/** The bar the owner set (2026-10-15): correct handoffs, and none on a prompt that needs none. */
const MIN_CORRECT = 0.9;

const host = (id: string) => env.AGENT_HOST.getByName(id);
const registry = () => env.REGISTRY.getByName(REGISTRY_NAME);
const owner = { userId: "u-owner", role: "owner", via: "admin-api" } as const;

/** Every tool call, by the conversation it came from. */
const calls = new Map<string, { name: string; input: Record<string, unknown> }[]>();

/** The provider's tools, with each call noted before it runs. */
function noted(provider: ToolProvider): ToolProvider {
  return {
    async tools(agentId, place) {
      return (await provider.tools(agentId, place)).map((tool) => ({
        ...tool,
        run(input, context) {
          const thread = context.source.split(",")[0] ?? "";
          const list = calls.get(thread) ?? [];
          list.push({ name: tool.spec.name, input: (input ?? {}) as Record<string, unknown> });
          calls.set(thread, list);
          return tool.run(input, context);
        },
      }));
    },
  };
}

/** A task as the board would make it; none is run here. */
const made = (title: string): TaskView => ({
  id: crypto.randomUUID(),
  title,
  status: "todo",
  scheduledStartAt: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  creator: { kind: "agent", id: "kelpie" },
  body: "",
  waitingReason: null,
  attempt: 0,
  stopRequested: false,
  result: null,
});

/** Master's tools, as production lists them, over an empty vault and no real boards. */
const TOOLS: ToolProvider[] = [
  memoryTools({
    search: async () => ({ ok: true, text: "", notes: [] }),
    readNote: async () => ({ ok: false, reason: "not_found" }),
    writeNote: async () => ({ ok: true, path: "notes/x.md" }),
  } as never),
  configurationTools({} as never, {
    roleOf: async (id) => (await registry().get(id))?.role ?? null,
    adminOrigin: "https://admin.example",
  }),
  subagentTools({
    canSpawn: async (id) => (await registry().get(id))?.role === "master",
    creator: async () => ({
      model: {},
      described: { provider: "anthropic", tier: "cheap", route: [] },
      tools: null,
    }),
    add: async () => ({ ok: false, reason: "not_allowed" }),
    bindCreator: async () => ({ ok: false }),
    discard: async () => undefined,
    configure: async () => ({ ok: false, reason: "invalid_input" }),
    owned: async () => [],
    remove: async () => ({ ok: false, reason: "forbidden" }),
  }),
  taskTools({
    owned: async (id) =>
      (await registry().list())
        .filter((entry) => entry.owner === id)
        .map((entry) => ({ id: entry.id, name: entry.name })),
    create: async (_assignee, task) => ({ ok: true, value: made(task.title) }),
    comment: async () => ({ ok: false, reason: "unknown_task" }),
  }),
].map(noted);

declare module "vitest" {
  interface TaskMeta {
    handoffEval?: {
      models: string[];
      prompts: number;
      repetitions: number;
      positives: { runs: number; correct: number; rate: number };
      negatives: { runs: number; handedOff: number };
      wrong: string[];
    };
  }
}

interface Run {
  case: HandoffCase;
  handedTo: string[];
  subagents: number;
  correct: boolean;
}

async function run(one: HandoffCase, repetition: number): Promise<Run> {
  const thread = `eval-${one.id}-${repetition}`;
  const conversation = env.CONVERSATION_AGENT.getByName(`kelpie:telegram:${thread}`);
  await conversation.ingest({
    agentId: "kelpie",
    providerMessageId: `${thread}:m1`,
    userId: "u-owner",
    role: "owner",
    chatType: "direct",
    text: one.prompt,
    destination: { channel: "telegram", threadId: thread },
    sentAt: Date.now(),
    timeZone: null,
  });
  await conversation.flush();
  await vi.waitFor(
    async () => {
      const turns = await conversation.turns();
      expect(turns.length > 0 && turns.every((turn) => turn.status !== "running")).toBe(true);
    },
    { timeout: 180_000, interval: 500 },
  );
  const theirs = calls.get(`telegram:${thread}`) ?? [];
  const handedTo = theirs
    .filter((call) => call.name === "create_task")
    .map((call) => String(call.input.agentId));
  const subagents = theirs.filter((call) => call.name === "create_subagent").length;
  // Strict: the expected specialist got it, and nothing went anywhere else.
  const correct =
    subagents === 0 &&
    (one.expected === null
      ? handedTo.length === 0
      : handedTo.length > 0 && handedTo.every((id) => id === one.expected));
  return { case: one, handedTo, subagents, correct };
}

/** Runs every job, `limit` at a time, keeping their order. */
async function pool<T>(jobs: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const index = next++;
      results[index] = await (jobs[index] as () => Promise<T>)();
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

describe.skipIf(!enabled)("the mandatory handoff, on the cheap tier (#287)", () => {
  it("hands each demand within a remit to its specialist, and none that needs none", async ({
    task,
  }) => {
    // Production's cheap route (llm-gateway's MODEL_ROUTES), over the providers with a key: the
    // newest Claude Haiku, then OpenAI's.
    const providers: Partial<Record<ProviderId, LlmProvider>> = {
      ...(models.ANTHROPIC_API_KEY
        ? { anthropic: new AnthropicMessagesProvider({ apiKey: models.ANTHROPIC_API_KEY }) }
        : {}),
      ...(models.OPENAI_API_KEY
        ? { openai: new OpenAIResponsesProvider({ apiKey: models.OPENAI_API_KEY }) }
        : {}),
    };
    if (Object.keys(providers).length === 0) {
      throw new Error(
        "No model key: set ANTHROPIC_API_KEY or OPENAI_API_KEY, or add one to ~/.kelpie/.env",
      );
    }
    for (const { id, name, remit } of ROSTER) {
      await registry().add(id, name, owner);
      if (remit !== "") await host(id).configure({ remit }, owner);
    }
    replaceTaskRunnerForTesting(null);
    const router = new ModelRouter(
      {
        cheap: [
          { provider: "anthropic", model: "haiku" },
          { provider: "openai", model: "gpt-6-luna" },
        ],
        medium: [],
        frontier: [],
      },
      providers,
    );
    /** The models that answered, as their usage names them. */
    const answered = new Set<string>();
    async function* noting(events: AsyncIterable<RouterEvent>): AsyncIterable<RouterEvent> {
      for await (const event of events) {
        if (event.type === "finish") for (const { model } of event.usage) answered.add(model);
        yield event;
      }
    }
    const world = fakeWorld([]);
    world.tools = TOOLS;
    world.ports.generate = async (_selection, request) => {
      const controller = new AbortController();
      return {
        events: noting(router.stream({ tier: "cheap" }, request, { signal: controller.signal })),
        cancel: () => controller.abort(),
        // Its routes are API routes, which never ask for a tool's result (#295).
        answer: async () => {},
      };
    };
    replacePortsForTesting(world.ports);

    const runs = await pool(
      CASES.flatMap((one) =>
        Array.from({ length: REPETITIONS }, (_, repetition) => () => run(one, repetition)),
      ),
      CONCURRENCY,
    );

    const positives = runs.filter((one) => one.case.expected !== null);
    const negatives = runs.filter((one) => one.case.expected === null);
    const rate = positives.filter((one) => one.correct).length / positives.length;
    const wrong = runs
      .filter((one) => !one.correct)
      .map(
        (one) =>
          `${one.case.id}: expected ${one.case.expected ?? "none"}, got ${one.handedTo.join(", ") || "none"}${one.subagents ? `, ${one.subagents} subagent(s)` : ""} — ${one.case.prompt}`,
      );
    // The JSON reporter writes it to eval/last-run.json, for #287's record.
    task.meta.handoffEval = {
      models: [...answered],
      prompts: CASES.length,
      repetitions: REPETITIONS,
      positives: {
        runs: positives.length,
        correct: positives.filter((one) => one.correct).length,
        rate,
      },
      negatives: {
        runs: negatives.length,
        handedOff: negatives.filter((one) => !one.correct).length,
      },
      wrong,
    };
    expect(rate).toBeGreaterThanOrEqual(MIN_CORRECT);
    expect(negatives.filter((one) => !one.correct)).toEqual([]);
  });
});
