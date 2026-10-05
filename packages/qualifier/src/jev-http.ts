import { maskPersonalData } from "./mask.ts";
import type { Answer, Qualifier, QualifierId, QualifyResult, Question } from "./types.ts";

export const SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone";

/** The part of `fetch` this adapter uses. The caller passes its runtime's, as with timers. */
export type JevFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface JevHttpOptions {
  apiKey: string;
  /** A pinned version such as "jev-1.13.0": thresholds are tuned against one (ADR-0018). */
  model: string;
  fetch: JevFetch;
}

/** Jev through TypeSafe's API (ADR-0018). Personal data in the state is masked before it leaves. */
export class JevHttpQualifier implements Qualifier {
  readonly id: QualifierId = "jev-http";
  readonly calibrated = true;
  readonly #options: JevHttpOptions;

  constructor(options: JevHttpOptions) {
    this.#options = options;
  }

  async qualify(
    state: unknown,
    questions: Record<string, Question>,
    options: { signal?: AbortSignal } = {},
  ): Promise<QualifyResult> {
    const response = await this.#options.fetch(SYSTEM_ONE_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.#options.model,
        state: maskPersonalData(state),
        questions,
      }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    // An error's body can echo the state, so only the status is reported.
    if (!response.ok) throw new Error(`TypeSafe answered ${response.status}`);
    const body = (await response.json()) as { answers?: Record<string, unknown> } | null;
    const answers: Record<string, Answer> = {};
    for (const [key, question] of Object.entries(questions)) {
      const answer = toAnswer(question, body?.answers?.[key]);
      if (answer) answers[key] = answer;
    }
    return { answers, provider: this.id, calibrated: this.calibrated };
  }
}

/** Keeps an answer only when its shape matches its question's type. */
function toAnswer(question: Question, raw: unknown): Answer | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (value.type !== question.type) return null;
  const { probabilities } = value;
  switch (question.type) {
    case "noul":
      return typeof value.noul === "number" ? { type: "noul", noul: value.noul } : null;
    case "choice":
      return typeof value.choice === "string" && isProbabilities(probabilities)
        ? { type: "choice", choice: value.choice, probabilities }
        : null;
    case "score":
      return typeof value.score === "number" && isProbabilities(probabilities)
        ? { type: "score", score: value.score, probabilities }
        : null;
  }
}

function isProbabilities(value: unknown): value is Record<string, number> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every((probability) => typeof probability === "number")
  );
}
