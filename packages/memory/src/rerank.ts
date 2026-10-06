// The rerank (#110), on ai-memory's contract at fc4da03
// (https://github.com/akitaonrails/ai-memory/blob/fc4da03/crates/ai-memory-llm/src/reranker.rs):
// a judge scores the best hits, at most 30, from each note's title and start (600 characters);
// only that prefix is reordered, and the fused order stays when the judge fails or answers in
// part. Kelpie's judge is the agent's qualifier (Clef or Jev), asked one question per note.
import type { MemoryIndex, SearchHit } from "./memory-index.ts";

export interface RerankCandidate {
  id: string;
  text: string;
}

/** Scores each candidate's relevance to the question, 0 to 1, by id; null when it can't. */
export type Judge = (
  question: string,
  candidates: RerankCandidate[],
) => Promise<Record<string, number> | null>;

const MAX_CANDIDATES = 30;
const SNIPPET_CHARS = 600;

function snippet(index: MemoryIndex, hit: SearchHit): string {
  const version = index.versionOf(hit.path, hit.commit);
  const text = `${hit.title}\n${version?.abstract ?? version?.body ?? ""}`;
  return text.length <= SNIPPET_CHARS ? text : text.slice(0, SNIPPET_CHARS);
}

/**
 * The hits with their best `candidates` (30 at most) reordered by the judge's scores, ties kept in
 * fused order. Any failure, or a score missing for one candidate, returns the hits as they were.
 */
export async function rerank<T extends SearchHit>(
  index: MemoryIndex,
  question: string,
  hits: readonly T[],
  judge: Judge,
  options: { candidates?: number } = {},
): Promise<T[]> {
  const count = Math.min(
    Math.trunc(options.candidates ?? MAX_CANDIDATES) || 0,
    MAX_CANDIDATES,
    hits.length,
  );
  if (count < 2) return [...hits];
  const head = hits.slice(0, count);
  const candidates = head.map((hit, i) => ({ id: `c${i}`, text: snippet(index, hit) }));
  let scores: Record<string, number> | null;
  try {
    scores = await judge(question, candidates);
  } catch {
    return [...hits];
  }
  const scored = candidates.map((candidate, i) => ({
    hit: head[i] as T,
    i,
    score: scores?.[candidate.id],
  }));
  if (!scored.every((entry) => typeof entry.score === "number" && Number.isFinite(entry.score))) {
    return [...hits];
  }
  scored.sort((a, b) => (b.score as number) - (a.score as number) || a.i - b.i);
  return [...scored.map((entry) => entry.hit), ...hits.slice(count)];
}

/** What `qualifierJudge` needs of a qualifier: `@kelpie/qualifier`'s `Qualifier`, structurally. */
export interface NoulQualifier {
  qualify(
    state: unknown,
    questions: Record<string, { type: "noul"; instructions: string }>,
  ): Promise<{ answers: Record<string, { type: string; noul?: number }> }>;
}

/** A judge that asks the qualifier one yes-or-no question per note, in one call. */
export function qualifierJudge(qualifier: NoulQualifier): Judge {
  return async (question, candidates) => {
    const notes = Object.fromEntries(candidates.map((candidate) => [candidate.id, candidate.text]));
    const questions = Object.fromEntries(
      candidates.map((candidate) => [
        candidate.id,
        {
          type: "noul" as const,
          instructions: `Does the note "${candidate.id}" in the state help answer the question in the state?`,
        },
      ]),
    );
    const result = await qualifier.qualify({ question, notes }, questions);
    return Object.fromEntries(
      candidates.flatMap((candidate) => {
        const noul = result.answers[candidate.id]?.noul;
        return typeof noul === "number" ? [[candidate.id, noul]] : [];
      }),
    );
  };
}
