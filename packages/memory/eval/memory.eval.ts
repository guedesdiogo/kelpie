// The memory evaluation (#108): the labelled questions against the index, at three vault sizes.
// Run it with `bun run --filter @kelpie/memory eval`; it takes minutes, so `test` doesn't run it.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MemoryIndex, type SearchHit } from "../src/index.ts";
import { buildVault } from "./generate.ts";
import { LABELS_SHA256, labelsHash } from "./labels.ts";
import { QUESTIONS } from "./questions.ts";
import { answerRank, bySlice, estimateTokens, type QuestionResult, staleFirst } from "./score.ts";

/** Results per question; the baseline packs the top five hits, as #110 will do better. */
const LIMIT = 10;
const PACKED = 5;

const SIZES = [1_000, 10_000, 100_000];

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
          for (const question of QUESTIONS) {
            const options = {
              limit: LIMIT,
              ...(question.asOf ? { asOf: Date.parse(`${question.asOf}T23:59:59Z`) } : {}),
              ...(question.validAt ? { validAt: Date.parse(`${question.validAt}T12:00:00Z`) } : {}),
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
          }
          const versions = state.storage.sql
            .exec<{ n: number }>("SELECT count(*) AS n FROM versions")
            .one().n;
          task.meta.memoryEval = {
            size,
            memories: vault.memories,
            versions,
            commits: vault.commits.length,
            buildMs: Math.round(buildMs),
            databaseBytes: state.storage.sql.databaseSize,
            slices: bySlice(results),
            questions: results,
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
