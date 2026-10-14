// The session recall slice (#297), over the 1,000-memory vault: 24 conversations whose answer sits
// past a message's 280th character or in a long session's omitted middle, plus a control, each
// with two conversations on its topic. Their pages are written twice: as today's `sessionPage`
// writes them, and keeping each message whole up to 2,000 characters, with no middle cut up to 200
// messages. The same questions go to retrieval (#110), as a turn asks them, with no vectors.
// Run it with `bun run --filter @kelpie/memory eval`; docs/spikes/memory-eval.md records the run.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  MemoryIndex,
  pack,
  retrieve,
  SESSION_LIMITS,
  type SessionLimits,
  sessionPage,
  type VaultCommit,
} from "../src/index.ts";
import { buildVault, SEED } from "./generate.ts";
import { aggregate, percentile, type QuestionResult } from "./score.ts";
import { CASES, conversationOf, distractorsOf, PLACES } from "./session-recall.ts";

const SIZE = 1_000;
const LIMIT = 10;
/** The turn's starting budget for its slice, as #108's evaluation packs it. */
const BUDGET_TOKENS = 1_000;
/** A page this high, which holds the answer, is one `memory_read` away from it. */
const READABLE_RANK = 5;

const VARIANTS: Record<string, SessionLimits> = {
  today: SESSION_LIMITS,
  whole: { excerptChars: 2_000, headLines: 100, tailLines: 100 },
};

declare module "vitest" {
  interface TaskMeta {
    sessionsEval?: unknown;
  }
}

/** Every conversation's page under the limits, as one commit after the vault's last. */
async function pagesCommit(limits: SessionLimits, after: number) {
  const pages = new Map<string, string>();
  const gold = new Map<string, string>();
  for (const c of CASES) {
    for (const conversation of [conversationOf(c), ...distractorsOf(c)]) {
      const page = await sessionPage(conversation, limits);
      if (page === null) throw new Error(`no page for ${conversation.key}`);
      pages.set(page.path, page.text);
      if (conversation.key === c.id) gold.set(c.id, page.path);
    }
  }
  const commit: VaultCommit = {
    sha: "e".repeat(40),
    committedAt: after + 1,
    changes: [...pages].map(([path, content]) => ({ path, content })),
  };
  return { commit, pages, gold };
}

describe("session recall", () => {
  it(`finds what a conversation said, over ${SIZE} memories, with today's pages and whole ones`, async ({
    task,
  }) => {
    const vault = await buildVault(SIZE);
    const last = Math.max(...vault.commits.map((commit) => commit.committedAt));
    const report: Record<string, unknown> = {};
    for (const [variant, limits] of Object.entries(VARIANTS)) {
      const { commit, pages, gold } = await pagesCommit(limits, last);
      // The slice tests what it says: today's pages keep only the control's facts.
      for (const c of CASES) {
        const text = pages.get(gold.get(c.id) ?? "") ?? "";
        const kept = variant === "whole" || c.place === "head";
        expect(text.includes(c.fact), `${variant} ${c.id}`).toBe(kept);
      }
      report[variant] = await runInDurableObject(
        env.INDEX_HOST.getByName(`sessions-${variant}`),
        async (_instance, state) => {
          const index = new MemoryIndex(state.storage);
          for (const each of [...vault.commits, commit]) await index.applyCommit(each);
          const results: (QuestionResult & { place: string; shown: boolean; readable: boolean })[] =
            [];
          for (const c of CASES) {
            const started = performance.now();
            const found = retrieve(index, c.question, { limit: LIMIT });
            const packed = pack(index, found, { budgetTokens: BUDGET_TOKENS });
            const path = gold.get(c.id) ?? "";
            const rank = found.findIndex((hit) => hit.path === path);
            results.push({
              id: c.id,
              category: "entity",
              answerRank: rank === -1 ? null : rank + 1,
              staleFirst: null,
              tokens: packed.tokens,
              latencyMs: performance.now() - started,
              place: c.place,
              // What the turn reads: the answer itself in the packed block, not only its page.
              shown: packed.text.includes(c.fact),
              // What one read reaches: a long page shows only its start in the block.
              readable:
                rank !== -1 && rank < READABLE_RANK && (pages.get(path) ?? "").includes(c.fact),
            });
          }
          expect(Math.max(...results.map((result) => result.tokens))).toBeLessThanOrEqual(
            BUDGET_TOKENS,
          );
          const sizes = [...pages.values()].map((text) => text.length);
          const rate = (rows: typeof results, of: (row: (typeof results)[number]) => boolean) =>
            Math.round((rows.filter(of).length / rows.length) * 1000) / 1000;
          const slice = (rows: typeof results) => ({
            ...aggregate(rows),
            shown: rate(rows, (row) => row.shown),
            readable: rate(rows, (row) => row.readable),
          });
          return {
            limits,
            pages: {
              n: sizes.length,
              chars: {
                mean: Math.round(sizes.reduce((sum, n) => sum + n, 0) / sizes.length),
                p95: percentile(sizes, 95),
                max: Math.max(...sizes),
              },
            },
            databaseBytes: state.storage.sql.databaseSize,
            slices: {
              overall: slice(results),
              ...Object.fromEntries(
                PLACES.map((place) => [place, slice(results.filter((row) => row.place === place))]),
              ),
            },
            questions: results.map(({ id, place, answerRank, shown, readable, tokens }) => ({
              id,
              place,
              answerRank,
              shown,
              readable,
              tokens,
            })),
          };
        },
      );
    }
    task.meta.sessionsEval = {
      seed: SEED,
      size: SIZE,
      limit: LIMIT,
      budgetTokens: BUDGET_TOKENS,
      ...report,
    };
  });
});
