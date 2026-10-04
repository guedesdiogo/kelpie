import type { Qualifier, QualifierId, QualifyResult, Question } from "./types.ts";

/** One decision: its questions, a policy in code, a timeout and a deterministic fallback. */
export interface Decision<Context, Outcome extends object> {
  /** Prefixes the question keys, so several decisions can share one call later. */
  id: string;
  /** Changes whenever the questions or thresholds change, for evaluation and logs. */
  version: string;
  timeoutMs: number;
  state(context: Context): unknown;
  questions(context: Context): Record<string, Question>;
  /** Maps the answers to an outcome, or null to use the fallback. */
  policy(result: QualifyResult, context: Context): Outcome | null;
  /** Never throws; this is what a clone with no qualifier configured runs. */
  fallback(context: Context): Outcome;
}

export type Sourced<Outcome> = Outcome & { source: QualifierId | "heuristic" };

export interface RunHooks {
  /** Called when the qualifier fails or times out and the fallback is used. */
  onFallback?: (decisionId: string, error: unknown) => void;
}

/** Asks the qualifier, if any, and falls back to the decision's heuristic on failure or timeout. */
export async function runDecision<Context, Outcome extends object>(
  qualifier: Qualifier | null,
  decision: Decision<Context, Outcome>,
  context: Context,
  hooks: RunHooks = {},
): Promise<Sourced<Outcome>> {
  const fallback = (): Sourced<Outcome> => ({ ...decision.fallback(context), source: "heuristic" });
  const report = (error: unknown) => {
    try {
      hooks.onFallback?.(decision.id, error);
    } catch {
      // A failing logger must not break the turn; the fallback still runs.
    }
  };
  if (!qualifier) return fallback();

  const prefix = `${decision.id}::`;
  const controller = new AbortController();
  // Typed from the runtime in scope, so consumers compiling with Node or Workers typings agree.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const questions = Object.fromEntries(
      Object.entries(decision.questions(context)).map(([key, question]) => [
        prefix + key,
        question,
      ]),
    );
    const result = await Promise.race([
      qualifier.qualify(decision.state(context), questions, { signal: controller.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`${decision.id} timed out after ${decision.timeoutMs} ms`));
        }, decision.timeoutMs);
      }),
    ]);
    const answers = Object.fromEntries(
      Object.entries(result.answers)
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, answer]) => [key.slice(prefix.length), answer]),
    );
    const outcome = decision.policy({ ...result, answers }, context);
    if (outcome) return { ...outcome, source: result.provider };
    report(new Error("the policy declined the answers"));
  } catch (error) {
    report(error);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return fallback();
}
