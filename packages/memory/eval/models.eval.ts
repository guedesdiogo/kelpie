// The memory evaluation with models (#110): the same vaults and questions as memory.eval.ts,
// answered with vectors from bge-m3 or OpenAI, before and after a rerank by Clef, and the gate
// "does this message need memory?" asked of Clef. It calls paid models, so it runs only with
// `bun run --filter @kelpie/memory eval:models`; otherwise it skips itself.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type Embedder, OpenAIEmbedder, WorkersAiEmbedder } from "@kelpie/llm";
import { ClefQualifier } from "@kelpie/qualifier";
import { describe, expect, it } from "vitest";
import {
  type Judge,
  MemoryIndex,
  needsMemory,
  qualifierJudge,
  type Retrieved,
  rerank,
  retrieve,
} from "../src/index.ts";
import { buildVault, SEED } from "./generate.ts";
import { GOLD_MEMORIES } from "./gold-vault.ts";
import { LABELS_SHA256 } from "./labels.ts";
import { QUESTIONS } from "./questions.ts";
import { answerRank, bySlice, percentile, type QuestionResult, staleFirst } from "./score.ts";

const models = env as unknown as {
  EVAL_MODELS?: string;
  OPENAI_API_KEY?: string;
  AI?: { run(model: string, input: unknown, options?: unknown): Promise<unknown> };
};
const enabled = models.EVAL_MODELS === "1";

/** 100k memories would take tens of minutes to embed per model; 1k and 10k show the trend. */
const SIZES = [1_000, 10_000];
const LIMIT = 10;
/** ai-memory reranks 3 × limit candidates, at most 30. */
const RERANK_CANDIDATES = 30;
/** Calls to a model in flight at once. */
const CONCURRENCY = 8;
const AS_OF_TIME = "T23:59:59Z";
const VALID_AT_TIME = "T12:00:00Z";

/** Messages the gate should let pass without memory: acknowledgements, greetings, laughter. */
const ACKNOWLEDGEMENTS = [
  "ok",
  "valeu!",
  "obrigado",
  "kkkk",
  "bom dia",
  "boa noite",
  "certo",
  "show",
  "beleza",
  "tá bom",
  "pode ser",
  "entendi",
  "combinado",
  "perfeito",
  "👍",
  "hahaha",
  "sim",
  "não",
  "oi",
  "tchau",
];
const GATE_QUESTION = {
  type: "noul" as const,
  instructions:
    "Would answering the message in the state well need facts from the owner's notes: their people, places, preferences, plans, decisions or past conversations?",
};

const FIRST_NAMES = GOLD_MEMORIES.filter((memory) => memory.kind === "person").map(
  (memory) => memory.title.replace(/^(Dr\.|Tio) /, "").split(" ")[0] ?? "",
);
const NAMED = new Set(
  QUESTIONS.filter((question) =>
    FIRST_NAMES.some((name) => new RegExp(`(?<!\\p{L})${name}(?!\\p{L})`, "u").test(question.text)),
  ).map((question) => question.id),
);
const EVEN = new Set(QUESTIONS.map((q) => q.id).filter((id) => Number(id.slice(1)) % 2 === 0));
const SLICES = {
  "names a shared first name": NAMED,
  "names nobody by first name": new Set(QUESTIONS.map((q) => q.id).filter((id) => !NAMED.has(id))),
  "even half": EVEN,
  "odd half": new Set(QUESTIONS.map((q) => q.id).filter((id) => !EVEN.has(id))),
};

/** Model calls' durations and failures, for the latency each adds to a turn. */
interface CallLog {
  ms: number[];
  failed: number;
}
const callStats = (log: CallLog) => ({
  calls: log.ms.length,
  failed: log.failed,
  p50Ms: Math.round(percentile(log.ms, 50)),
  p95Ms: Math.round(percentile(log.ms, 95)),
});

/** The judge, timed, with a failure counted when it throws or leaves a candidate unscored. */
function logged(judge: Judge, log: CallLog): Judge {
  return async (question, candidates) => {
    const started = performance.now();
    try {
      const scores = await judge(question, candidates);
      if (scores === null || candidates.some((candidate) => scores[candidate.id] === undefined)) {
        log.failed += 1;
      }
      return scores;
    } catch (error) {
      log.failed += 1;
      throw error;
    } finally {
      log.ms.push(performance.now() - started);
    }
  };
}

/** Runs `task` over `items` with at most CONCURRENCY in flight, keeping the order. */
async function pooled<T, R>(items: readonly T[], task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (next < items.length) {
      const at = next;
      next += 1;
      results[at] = await task(items[at] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

function embedders(): Embedder[] {
  const run = models.AI?.run.bind(models.AI);
  return [
    ...(run
      ? [new WorkersAiEmbedder({ run: (model, input, options) => run(model, input, options) })]
      : []),
    ...(models.OPENAI_API_KEY ? [new OpenAIEmbedder({ apiKey: models.OPENAI_API_KEY })] : []),
  ];
}

function clef(): ClefQualifier {
  const run = models.AI?.run.bind(models.AI);
  if (!run) throw new Error("eval:models needs the AI binding");
  return new ClefQualifier({
    model: "clef",
    run: (model, input, options) => run(model, input, options),
  });
}

function optionsOf(question: (typeof QUESTIONS)[number]) {
  return {
    limit: LIMIT,
    ...(question.asOf ? { asOf: Date.parse(`${question.asOf}${AS_OF_TIME}`) } : {}),
    ...(question.validAt ? { validAt: Date.parse(`${question.validAt}${VALID_AT_TIME}`) } : {}),
  };
}

declare module "vitest" {
  interface TaskMeta {
    memoryEvalModels?: unknown;
  }
}

describe.skipIf(!enabled)("memory evaluation with models", () => {
  it("asks Clef whether a message needs memory", async ({ task }) => {
    const qualifier = clef();
    const log: CallLog = { ms: [], failed: 0 };
    const ask = async (message: string) => {
      const started = performance.now();
      try {
        const result = await qualifier.qualify({ message }, { needs_memory: GATE_QUESTION });
        const answer = result.answers.needs_memory;
        return answer?.type === "noul" ? answer.noul : Number.NaN;
      } catch {
        // The gate fails open: a failure counts as "needs memory".
        log.failed += 1;
        return Number.NaN;
      } finally {
        log.ms.push(performance.now() - started);
      }
    };
    const questions = await pooled(QUESTIONS, (question) => ask(question.text));
    const acknowledgements = await pooled(ACKNOWLEDGEMENTS, ask);
    const rate = (scores: number[], pass: (score: number) => boolean) =>
      Math.round((scores.filter(pass).length / scores.length) * 1000) / 1000;
    task.meta.memoryEvalModels = {
      gate: {
        model: "clef",
        threshold: 0.5,
        questionsPassed: rate(questions, (score) => score >= 0.5),
        questionsFailedOpen: rate(questions, (score) => Number.isNaN(score)),
        acknowledgementsStopped: rate(acknowledgements, (score) => score < 0.5),
        acknowledgementsStoppedByRegex: rate(
          ACKNOWLEDGEMENTS.map((message) => (needsMemory(message) ? 1 : 0)),
          (score) => score === 0,
        ),
        lowestQuestion: Math.min(...questions.filter((score) => !Number.isNaN(score))),
        questionsBelow: QUESTIONS.filter((_, i) => (questions[i] ?? 0) < 0.5).map((q) => q.id),
        ...callStats(log),
      },
    };
    expect(questions).toHaveLength(QUESTIONS.length);
  });

  for (const size of SIZES) {
    it(`answers the questions over ${size} memories with vectors and a rerank`, async ({
      task,
    }) => {
      const vault = await buildVault(size);
      await runInDurableObject(
        env.INDEX_HOST.getByName(`models-${size}`),
        async (_instance, state) => {
          const index = new MemoryIndex(state.storage);
          for (const commit of vault.commits) await index.applyCommit(commit);
          const clefJudge = qualifierJudge(clef());
          const rerankCalls: Record<string, CallLog> = {};
          const judgeFor = (name: string) => {
            const log: CallLog = { ms: [], failed: 0 };
            rerankCalls[name] = log;
            return logged(clefJudge, log);
          };
          const score = (question: (typeof QUESTIONS)[number], hits: readonly Retrieved[]) => ({
            id: question.id,
            category: question.category,
            answerRank: answerRank(question, hits, vault.labels),
            staleFirst: staleFirst(question, hits, vault.labels),
            tokens: 0,
            latencyMs: 0,
          });
          const configs: Record<string, QuestionResult[]> = {
            retrieval: QUESTIONS.map((question) =>
              score(question, retrieve(index, question.text, optionsOf(question))),
            ),
          };
          const timings: Record<string, number> = {};
          for (const embedder of embedders()) {
            const started = performance.now();
            for (;;) {
              const missing = index.embeddingTexts(embedder.model, 256);
              if (missing.length === 0) break;
              const vectors = await embedder.embed(missing.map((item) => item.text));
              index.putEmbeddings(
                embedder.model,
                missing.map((item, i) => ({ blobSha: item.blobSha, vector: vectors[i] ?? [] })),
              );
            }
            timings[`embed ${embedder.model} (ms)`] = Math.round(performance.now() - started);
            const queries = await embedder.embed(QUESTIONS.map((question) => question.text));
            const found = QUESTIONS.map((question, i) =>
              retrieve(index, question.text, {
                ...optionsOf(question),
                vector: { model: embedder.model, query: queries[i] ?? [] },
              }),
            );
            configs[`+ ${embedder.model}`] = QUESTIONS.map((question, i) =>
              score(question, found[i] ?? []),
            );
            const judge = judgeFor(`+ ${embedder.model} + rerank`);
            const reranked = await pooled(QUESTIONS, (question) =>
              rerank(index, question.text, found[QUESTIONS.indexOf(question)] ?? [], judge, {
                candidates: RERANK_CANDIDATES,
              }),
            );

            configs[`+ ${embedder.model} + rerank`] = QUESTIONS.map((question, i) =>
              score(question, reranked[i] ?? []),
            );
          }
          const plainJudge = judgeFor("retrieval + rerank");
          const rerankedPlain = await pooled(QUESTIONS, (question) =>
            rerank(
              index,
              question.text,
              retrieve(index, question.text, optionsOf(question)),
              plainJudge,
              {
                candidates: RERANK_CANDIDATES,
              },
            ),
          );
          configs["retrieval + rerank"] = QUESTIONS.map((question, i) =>
            score(question, rerankedPlain[i] ?? []),
          );
          task.meta.memoryEvalModels = {
            labelsSha256: LABELS_SHA256,
            seed: SEED,
            size,
            limit: LIMIT,
            rerankCandidates: RERANK_CANDIDATES,
            timings,
            rerankCalls: Object.fromEntries(
              Object.entries(rerankCalls).map(([name, log]) => [name, callStats(log)]),
            ),
            configs: Object.fromEntries(
              Object.entries(configs).map(([name, results]) => [
                name,
                { slices: bySlice(results, SLICES), questions: results },
              ]),
            ),
          };
        },
      );
    });
  }
});
