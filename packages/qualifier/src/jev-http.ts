import { maskPersonalData } from "./mask.ts";
import { systemOneAnswers } from "./system-one.ts";
import type { Qualifier, QualifierId, QualifyResult, Question } from "./types.ts";

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
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      // The parser's message quotes the body, which can echo the state.
      throw new Error("TypeSafe answered with a body that isn't JSON");
    }
    const answers = systemOneAnswers(questions, body);
    return { answers, provider: this.id, calibrated: this.calibrated };
  }
}
