// Dream's abstracts (#112), measured against the 1,000-memory vault as it is: the same questions,
// with the session pages' abstracts as the vault has them (none) and as the cheap tier writes them
// (eval/session-abstracts.json, from eval/session-abstracts.mjs). Abstracts are searched and
// embedded with the title and body, so writing them changes retrieval; #112 asks that #108's
// evaluation doesn't regress before Dream may write them.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { gitBlobSha, MemoryIndex, readNote, retrieve } from "../src/index.ts";
import { buildVault, SEED, type SyntheticVault } from "./generate.ts";
import { QUESTIONS } from "./questions.ts";
import { answerRank, bySlice, type QuestionResult, staleFirst } from "./score.ts";
import cache from "./session-abstracts.json";

const SIZE = 1_000;
const LIMIT = 10;
const AS_OF_TIME = "T23:59:59Z";
const VALID_AT_TIME = "T12:00:00Z";

declare module "vitest" {
  interface TaskMeta {
    abstractsEval?: unknown;
  }
}

/** Each question, answered by the index's plain search and by retrieval (#110). */
async function evaluate(name: string, vault: SyntheticVault) {
  return runInDurableObject(env.INDEX_HOST.getByName(name), async (_instance, state) => {
    const index = new MemoryIndex(state.storage);
    for (const commit of vault.commits) await index.applyCommit(commit);
    const search: QuestionResult[] = [];
    const retrieval: QuestionResult[] = [];
    for (const question of QUESTIONS) {
      const options = {
        limit: LIMIT,
        ...(question.asOf ? { asOf: Date.parse(`${question.asOf}${AS_OF_TIME}`) } : {}),
        ...(question.validAt ? { validAt: Date.parse(`${question.validAt}${VALID_AT_TIME}`) } : {}),
      };
      const hits = index.search(question.text, options);
      const found = retrieve(index, question.text, options);
      for (const [results, list] of [
        [search, hits],
        [retrieval, found],
      ] as const) {
        results.push({
          id: question.id,
          category: question.category,
          answerRank: answerRank(question, list, vault.labels),
          staleFirst: staleFirst(question, list, vault.labels),
          tokens: 0,
          latencyMs: 0,
        });
      }
    }
    return { search: bySlice(search), retrieval: bySlice(retrieval) };
  });
}

describe("Dream's abstracts", () => {
  it(`don't regress #108 over ${SIZE} memories`, async ({ task }) => {
    expect(cache.seed).toBe(SEED);
    const abstracts = new Map(
      Object.entries(cache.abstracts).flatMap(([path, entry]) =>
        entry.abstract === null ? [] : [[path, entry.abstract] as const],
      ),
    );
    // Every session page has its abstract, asked for its content as the vault holds it now.
    const plain = await buildVault(SIZE);
    const sessions = new Map<string, string>();
    for (const commit of plain.commits) {
      for (const change of commit.changes) {
        if (change.content === null) sessions.delete(change.path);
        else if (readNote(change.path, change.content)?.kind === "session") {
          sessions.set(change.path, change.content);
        }
      }
    }
    expect(abstracts.size).toBe(sessions.size);
    for (const [path, content] of sessions) {
      expect(cache.abstracts[path as keyof typeof cache.abstracts]?.blob, path).toBe(
        await gitBlobSha(content),
      );
    }
    const before = await evaluate("abstracts-before", plain);
    const after = await evaluate("abstracts-after", await buildVault(SIZE, SEED, { abstracts }));
    task.meta.abstractsEval = { model: cache.model, abstracts: abstracts.size, before, after };
    // What a turn uses doesn't drop (#110); docs/spikes/memory-eval.md records every slice.
    const { overall: was } = before.retrieval;
    const { overall: is } = after.retrieval;
    for (const k of ["1", "3", "5", "10"] as const) {
      expect(is?.hit[k] ?? 0).toBeGreaterThanOrEqual(was?.hit[k] ?? 0);
    }
    expect(is?.mrr ?? 0).toBeGreaterThanOrEqual(was?.mrr ?? 0);
  });
});
