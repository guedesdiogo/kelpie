import { maskPersonalData } from "./mask.ts";
import { systemOneAnswers } from "./system-one.ts";
import type { Qualifier, QualifierId, QualifyResult, Question } from "./types.ts";

/**
 * The part of the Workers AI binding this adapter uses (`env.AI.run`). The caller passes it, so
 * the package stays free of Cloudflare imports (ADR-0002).
 */
export type ClefRun = (
  model: string,
  input: { model: string; state: unknown; questions: Record<string, Question> },
  options: { signal?: AbortSignal },
) => Promise<unknown>;

export interface ClefOptions {
  /** The model selector, "clef" or "clef-flash": thresholds are tuned against one. */
  model: string;
  run: ClefRun;
}

/**
 * Cloudflare's Clef decision models on Workers AI (issue #118). They speak the System One API, so
 * the request is the one Jev gets. Personal data in the state is masked before it leaves.
 */
export class ClefQualifier implements Qualifier {
  readonly id: QualifierId = "clef-workers-ai";
  readonly calibrated = true;
  readonly #options: ClefOptions;

  constructor(options: ClefOptions) {
    this.#options = options;
  }

  async qualify(
    state: unknown,
    questions: Record<string, Question>,
    options: { signal?: AbortSignal } = {},
  ): Promise<QualifyResult> {
    const { model, run } = this.#options;
    let body: unknown;
    try {
      body = await run(
        `@cf/cloudflare/${model}`,
        { model, state: maskPersonalData(state), questions },
        options.signal ? { signal: options.signal } : {},
      );
    } catch (error) {
      // A Workers AI error message can quote the input, so only the error's name is reported.
      throw new Error(`Workers AI failed: ${error instanceof Error ? error.name : "unknown"}`);
    }
    return { answers: systemOneAnswers(questions, body), provider: this.id, calibrated: true };
  }
}
