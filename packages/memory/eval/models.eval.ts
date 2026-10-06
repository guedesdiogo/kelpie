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
  RELATIONS,
  type Retrieved,
  relationQuestion,
  rerank,
  retrieve,
} from "../src/index.ts";
import { buildVault, SEED } from "./generate.ts";
import { GOLD_MEMORIES } from "./gold-vault.ts";
import { LABELS_SHA256, WRITE_SET_SHA256 } from "./labels.ts";
import { QUESTIONS } from "./questions.ts";
import { answerRank, bySlice, percentile, type QuestionResult, staleFirst } from "./score.ts";
import { WRITE_PAIRS, type WriteRelation } from "./write-decision-set.ts";

const models = env as unknown as {
  EVAL_MODELS?: string;
  OPENAI_API_KEY?: string;
  AI?: { run(model: string, input: unknown, options?: unknown): Promise<unknown> };
};
const enabled = models.EVAL_MODELS === "1";

/** 100k memories would take tens of minutes to embed per model; 1k and 10k show the trend. */
const SIZES = [1_000, 10_000];
const LIMIT = 10;
/**
 * ai-memory reranks 3 × limit candidates, at most 30: retrieval fetches that many, the rerank
 * reorders them, and the limit is kept after, so notes can rise from below it.
 */
const RERANK_CANDIDATES = Math.min(3 * LIMIT, 30);
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

  it("measures the write decision's choice on its labeled set (#149)", async ({ task }) => {
    const qualifier = clef();
    const log: CallLog = { ms: [], failed: 0 };
    const labels = Object.keys(RELATIONS) as WriteRelation[];
    const answers = await pooled(WRITE_PAIRS, async (pair) => {
      const started = performance.now();
      try {
        // As decideWrite asks it: the memory and the note in the state, one choice for the note.
        const result = await qualifier.qualify(
          {
            memory: `${pair.memory.title}\n${pair.memory.body}`,
            notes: { c0: `${pair.note.title}\n${pair.note.body}` },
          },
          { c0: relationQuestion("c0") },
        );
        const answer = result.answers.c0;
        if (answer?.type !== "choice" || !labels.includes(answer.choice as WriteRelation)) {
          log.failed += 1;
          return { choice: "failed", probability: Number.NaN };
        }
        return {
          choice: answer.choice as WriteRelation,
          probability: answer.probabilities[answer.choice] ?? Number.NaN,
        };
      } catch {
        log.failed += 1;
        return { choice: "failed", probability: Number.NaN };
      } finally {
        log.ms.push(performance.now() - started);
      }
    });
    const round = (value: number) => Math.round(value * 1000) / 1000;
    const confusion = Object.fromEntries(
      labels.map((label) => [
        label,
        Object.fromEntries(
          [...labels, "failed"].map((choice) => [
            choice,
            WRITE_PAIRS.filter((pair, i) => pair.label === label && answers[i]?.choice === choice)
              .length,
          ]),
        ),
      ]),
    );
    const per = Object.fromEntries(
      labels.map((label) => {
        const chosen = answers.filter((answer) => answer.choice === label).length;
        const right = WRITE_PAIRS.filter(
          (pair, i) => pair.label === label && answers[i]?.choice === label,
        ).length;
        const truth = WRITE_PAIRS.filter((pair) => pair.label === label).length;
        return [
          label,
          { precision: chosen === 0 ? null : round(right / chosen), recall: round(right / truth) },
        ];
      }),
    );
    const meanProbability = (correct: boolean) => {
      const values = answers
        .filter((answer, i) => (answer.choice === WRITE_PAIRS[i]?.label) === correct)
        .map((answer) => answer.probability)
        .filter((value) => Number.isFinite(value));
      return values.length === 0 ? null : round(values.reduce((a, b) => a + b, 0) / values.length);
    };
    const writeDecision = {
      model: "clef",
      setSha256: WRITE_SET_SHA256,
      pairs: WRITE_PAIRS.length,
      accuracy: round(
        WRITE_PAIRS.filter((pair, i) => answers[i]?.choice === pair.label).length /
          WRITE_PAIRS.length,
      ),
      perLabel: per,
      confusion,
      // A NOOP on a memory that was news loses it; a SUPERSEDE of a note still true replaces it.
      lostByNoop: WRITE_PAIRS.filter(
        (pair, i) => answers[i]?.choice === "duplicate" && pair.label !== "duplicate",
      ).map((pair) => pair.id),
      wrongSupersede: WRITE_PAIRS.filter(
        (pair, i) => answers[i]?.choice === "replaces" && pair.label !== "replaces",
      ).map((pair) => pair.id),
      // The chosen answer's probability, per pair the qualifier would act on, for a threshold.
      actedOn: WRITE_PAIRS.flatMap((pair, i) => {
        const answer = answers[i];
        return answer && (answer.choice === "duplicate" || answer.choice === "replaces")
          ? [
              {
                id: pair.id,
                label: pair.label,
                choice: answer.choice,
                p: round(answer.probability),
              },
            ]
          : [];
      }),
      meanProbabilityRight: meanProbability(true),
      meanProbabilityWrong: meanProbability(false),
      ...callStats(log),
    };
    console.log(JSON.stringify(writeDecision, null, 2));
    task.meta.memoryEvalModels = { writeDecision };
    expect(answers).toHaveLength(WRITE_PAIRS.length);
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
          /** Retrieval of the rerank's candidates, reranked, then cut to the limit. */
          const reranking = async (
            question: (typeof QUESTIONS)[number],
            judge: Judge,
            vector?: { model: string; query: readonly number[] },
          ) => {
            const candidates = retrieve(index, question.text, {
              ...optionsOf(question),
              limit: RERANK_CANDIDATES,
              ...(vector ? { vector } : {}),
            });
            const reranked = await rerank(index, question.text, candidates, judge, {
              candidates: RERANK_CANDIDATES,
            });
            return reranked.slice(0, LIMIT);
          };
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
              reranking(question, judge, {
                model: embedder.model,
                query: queries[QUESTIONS.indexOf(question)] ?? [],
              }),
            );

            configs[`+ ${embedder.model} + rerank`] = QUESTIONS.map((question, i) =>
              score(question, reranked[i] ?? []),
            );
          }
          const plainJudge = judgeFor("retrieval + rerank");
          const rerankedPlain = await pooled(QUESTIONS, (question) =>
            reranking(question, plainJudge),
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

  it("measures where outdated memories sit, for the contradiction band (#111)", async ({
    task,
  }) => {
    const vault = await buildVault(1_000);
    const band = await runInDurableObject(
      env.INDEX_HOST.getByName("models-band"),
      async (_instance, state) => {
        const index = new MemoryIndex(state.storage);
        for (const commit of vault.commits) await index.applyCommit(commit);
        const textOf = (path: string) => {
          const note = index.current(path);
          return note === null
            ? null
            : [note.title, note.abstract, note.body].filter((part) => part).join("\n\n");
        };
        const key = (a: string, b: string) => (a < b ? `${a}\n${b}` : `${b}\n${a}`);
        // Same topic, disagreeing: each question's answer against what would answer it wrongly,
        // and each fact's consecutive versions, which say what changed.
        const positives = new Map<string, [string, string]>();
        const paths = new Set<string>();
        for (const question of QUESTIONS) {
          for (const stale of question.stale ?? []) {
            for (const gold of question.gold) {
              const a = vault.labels.get(gold)?.path;
              const b = vault.labels.get(stale)?.path;
              const ta = a === undefined ? null : textOf(a);
              const tb = b === undefined ? null : textOf(b);
              if (a && b && a !== b && ta && tb) {
                positives.set(key(a, b), [ta, tb]);
                paths.add(a).add(b);
              }
            }
          }
        }
        for (const memory of GOLD_MEMORIES) {
          memory.versions.slice(1).forEach((version, i) => {
            const before = memory.versions[i];
            if (before === undefined) return;
            const text = (v: typeof version) =>
              [memory.title, v.abstract, v.body].filter((part) => part).join("\n\n");
            positives.set(`${memory.key}@${i + 1}`, [text(before), text(version)]);
          });
        }
        // Same entity, not disagreeing: every other pair of gold notes that share one.
        const gold = [...new Set([...vault.labels.values()].map((target) => target.path))].filter(
          (path) => index.current(path) !== null,
        );
        const entities = index.entitiesOf(gold);
        const negatives: [string, string][] = [];
        for (let i = 0; i < gold.length; i += 1) {
          for (let j = i + 1; j < gold.length; j += 1) {
            const a = gold[i] as string;
            const b = gold[j] as string;
            const shared = [...(entities.get(a)?.keys() ?? [])].some((k) =>
              entities.get(b)?.has(k),
            );
            const ta = textOf(a);
            const tb = textOf(b);
            if (shared && !positives.has(key(a, b)) && ta && tb) negatives.push([ta, tb]);
          }
        }
        const cosine = (x: readonly number[], y: readonly number[]) => {
          let dot = 0;
          let xx = 0;
          let yy = 0;
          for (let i = 0; i < x.length; i += 1) {
            dot += (x[i] ?? 0) * (y[i] ?? 0);
            xx += (x[i] ?? 0) ** 2;
            yy += (y[i] ?? 0) ** 2;
          }
          return dot / Math.sqrt(xx * yy);
        };
        const round = (value: number) => Math.round(value * 1000) / 1000;
        const out: Record<string, unknown> = {};
        for (const embedder of embedders()) {
          const pairs = [...positives.values(), ...negatives];
          const texts = [...new Set(pairs.flat())];
          const vectors = await embedder.embed(texts);
          const vectorOf = new Map(texts.map((text, i) => [text, vectors[i] ?? []]));
          const scores = (list: [string, string][]) =>
            list.map(([a, b]) => cosine(vectorOf.get(a) ?? [], vectorOf.get(b) ?? []));
          const pos = scores([...positives.values()]).sort((a, b) => a - b);
          const neg = scores(negatives).sort((a, b) => a - b);
          const within = (list: number[], low: number, high: number) =>
            list.filter((value) => value >= low && value < high).length / (list.length || 1);
          const bands = [];
          for (let low = 0.3; low <= 0.71; low += 0.05) {
            for (let high = low + 0.1; high <= 0.96; high += 0.05) {
              bands.push({
                band: [round(low), round(high)],
                caught: round(within(pos, low, high)),
                flaggedNegatives: round(within(neg, low, high)),
              });
            }
          }
          out[embedder.model] = {
            positives: pos.map(round),
            negatives: {
              n: neg.length,
              p10: round(percentile(neg, 10)),
              p50: round(percentile(neg, 50)),
              p90: round(percentile(neg, 90)),
            },
            bestBands: bands
              .sort(
                (a, b) =>
                  b.caught - b.flaggedNegatives - (a.caught - a.flaggedNegatives) ||
                  a.flaggedNegatives - b.flaggedNegatives,
              )
              .slice(0, 5),
          };
        }
        return out;
      },
    );
    task.meta.memoryEvalModels = { band };
    console.log(JSON.stringify({ band }, null, 1));
    expect(Object.keys(band).length).toBeGreaterThan(0);
  });
});
