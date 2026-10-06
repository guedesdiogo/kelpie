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
  /** The model selector, "clef" or "clef-flash": each has its own bands (ADR-0022). */
  model: string;
  run: ClefRun;
}

/**
 * Cloudflare's Clef decision models on Workers AI (issue #118). They speak the System One API, so
 * the request is the one Jev gets. Personal data in the state is masked before it leaves.
 */
export class ClefQualifier implements Qualifier {
  /** Each model answers under its own id, because each has its own bands. */
  readonly id: QualifierId;
  readonly calibrated = true;
  readonly #options: ClefOptions;

  constructor(options: ClefOptions) {
    this.#options = options;
    this.id = options.model === "clef-flash" ? "clef-flash-workers-ai" : "clef-workers-ai";
  }

  async qualify(
    state: unknown,
    questions: Record<string, Question>,
    options: { signal?: AbortSignal } = {},
  ): Promise<QualifyResult> {
    const { model, run } = this.#options;
    // Clef accepts question ids of [A-Za-z0-9_.-] only, so `runDecision`'s `turn.end::` prefix
    // goes out as `turn.end__`, and the answers come back under the caller's keys.
    const sent = Object.fromEntries(
      Object.entries(questions).map(([key, question]) => [clefId(key), question]),
    );
    let body: unknown;
    try {
      body = await untilAborted(
        run(
          `@cf/cloudflare/${model}`,
          { model, state: maskPersonalData(state), questions: sent },
          options.signal ? { signal: options.signal } : {},
        ),
        options.signal,
      );
    } catch (error) {
      // A Workers AI error message can quote the input, so only the error's name is reported.
      throw new Error(`Workers AI failed: ${error instanceof Error ? error.name : "unknown"}`);
    }
    const received = (body as { answers?: Record<string, unknown> } | null)?.answers ?? {};
    const answers = Object.fromEntries(
      Object.keys(questions).map((key) => [key, received[clefId(key)]]),
    );
    return {
      answers: systemOneAnswers(questions, { answers }),
      provider: this.id,
      calibrated: true,
    };
  }
}

function clefId(key: string): string {
  return key.replace(/[^A-Za-z0-9_.-]/g, "_");
}

/** The binding may not honor the signal, so the call also stops waiting when it aborts. */
function untilAborted<T>(call: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return call;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    signal.addEventListener("abort", abort, { once: true });
    call.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
