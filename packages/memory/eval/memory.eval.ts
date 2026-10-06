// The memory evaluation (#108): the labelled questions against the index, at three vault sizes,
// answered by the index's plain search (the baseline) and by retrieval (#110), side by side.
// Run it with `bun run --filter @kelpie/memory eval`; it takes about half a minute, so `test`
// doesn't run it. `eval:baseline` then writes docs/spikes/memory-eval-baseline.json from the run.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MemoryIndex, pack as packRetrieved, retrieve, type SearchHit } from "../src/index.ts";
import { buildVault, SEED } from "./generate.ts";
import { GOLD_MEMORIES } from "./gold-vault.ts";
import { LABELS_SHA256, labelsHash } from "./labels.ts";
import { QUESTIONS } from "./questions.ts";
import { answerRank, bySlice, estimateTokens, type QuestionResult, staleFirst } from "./score.ts";

/** Results per question; the baseline packs the top five hits, as #110 will do better. */
const LIMIT = 10;
const PACKED = 5;
/** Retrieval packs its hits within this many tokens: #110's starting budget for the slice. */
const BUDGET_TOKENS = 1_000;

const SIZES = [1_000, 10_000, 100_000];

/** How a question's date becomes an instant: "as of" a day is its end, "valid at" a day its noon. */
const AS_OF_TIME = "T23:59:59Z";
const VALID_AT_TIME = "T12:00:00Z";

/**
 * Questions that name someone by a first name only. Distractors reuse those first names, so these
 * questions get harder as the vault grows, and the rest don't; they are reported apart.
 */
const FIRST_NAMES = GOLD_MEMORIES.filter((memory) => memory.kind === "person").map(
  (memory) => memory.title.replace(/^(Dr\.|Tio) /, "").split(" ")[0] ?? "",
);
const NAMED = new Set(
  QUESTIONS.filter((question) =>
    FIRST_NAMES.some((name) => new RegExp(`(?<!\\p{L})${name}(?!\\p{L})`, "u").test(question.text)),
  ).map((question) => question.id),
);
const UNNAMED = new Set(QUESTIONS.map((q) => q.id).filter((id) => !NAMED.has(id)));

/**
 * Retrieval's variants were compared on the questions with an even number only, and the two halves
 * are reported apart. The odd half isn't a clean hold-out: runs over every question came first
 * (docs/spikes/memory-eval.md).
 */
const EVEN = new Set(QUESTIONS.map((q) => q.id).filter((id) => Number(id.slice(1)) % 2 === 0));
const ODD = new Set(QUESTIONS.map((q) => q.id).filter((id) => !EVEN.has(id)));
const SLICES = {
  "names a shared first name": NAMED,
  "names nobody by first name": UNNAMED,
  "even half": EVEN,
  "odd half": ODD,
};

declare module "vitest" {
  interface TaskMeta {
    memoryEval?: unknown;
  }
}

describe("memory evaluation", () => {
  it("runs with the frozen labels", async () => {
    expect(await labelsHash()).toBe(LABELS_SHA256);
  });

  for (const size of SIZES) {
    it(`answers the questions over ${size} memories`, async ({ task }) => {
      const vault = await buildVault(size);
      await runInDurableObject(
        env.INDEX_HOST.getByName(`eval-${size}`),
        async (_instance, state) => {
          const index = new MemoryIndex(state.storage);
          const started = performance.now();
          for (const commit of vault.commits) await index.applyCommit(commit);
          const buildMs = performance.now() - started;

          const results: QuestionResult[] = [];
          const retrieved: QuestionResult[] = [];
          for (const question of QUESTIONS) {
            const options = {
              limit: LIMIT,
              ...(question.asOf ? { asOf: Date.parse(`${question.asOf}${AS_OF_TIME}`) } : {}),
              ...(question.validAt
                ? { validAt: Date.parse(`${question.validAt}${VALID_AT_TIME}`) }
                : {}),
            };
            const before = performance.now();
            const hits = index.search(question.text, options);
            const latencyMs = performance.now() - before;
            results.push({
              id: question.id,
              category: question.category,
              answerRank: answerRank(question, hits, vault.labels),
              staleFirst: staleFirst(question, hits, vault.labels),
              tokens: estimateTokens(pack(index, hits.slice(0, PACKED))),
              latencyMs,
            });

            const started = performance.now();
            const found = retrieve(index, question.text, options);
            const packed = packRetrieved(index, found, { budgetTokens: BUDGET_TOKENS });
            retrieved.push({
              id: question.id,
              category: question.category,
              answerRank: answerRank(question, found, vault.labels),
              staleFirst: staleFirst(question, found, vault.labels),
              tokens: packed.tokens,
              latencyMs: performance.now() - started,
            });
          }
          // The budget holds at every size, for every question.
          expect(Math.max(...retrieved.map((result) => result.tokens))).toBeLessThanOrEqual(
            BUDGET_TOKENS,
          );
          const versions = state.storage.sql
            .exec<{ n: number }>("SELECT count(*) AS n FROM versions")
            .one().n;
          task.meta.memoryEval = {
            labelsSha256: LABELS_SHA256,
            seed: SEED,
            limit: LIMIT,
            packed: PACKED,
            asOfTime: AS_OF_TIME,
            validAtTime: VALID_AT_TIME,
            size,
            memories: vault.memories,
            versions,
            commits: vault.commits.length,
            buildMs: Math.round(buildMs),
            databaseBytes: state.storage.sql.databaseSize,
            slices: bySlice(results, SLICES),
            questions: results,
            retrieval: {
              budgetTokens: BUDGET_TOKENS,
              slices: bySlice(retrieved, SLICES),
              questions: retrieved,
            },
          };
        },
      );
    });
  }
});

/** The baseline context: each hit's title, then its abstract or the start of its body. */
function pack(index: MemoryIndex, hits: readonly SearchHit[]): string {
  return hits
    .map((hit) => {
      const version = index.history(hit.path).find((v) => v.commit === hit.commit);
      const text = version?.abstract ?? version?.body.slice(0, 400) ?? "";
      return `## ${hit.title}\n${text}`;
    })
    .join("\n\n");
}
