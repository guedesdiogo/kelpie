import type { Qualifier, QualifierId, QualifyResult, Question } from "./types.ts";

/** What llm-gateway's `qualify` answers: the result, or why there is none. */
export type GatewayQualifyOutcome =
  | { ok: true; result: QualifyResult }
  | { ok: false; reason: "not_configured" | "failed" };

/** The gateway had no answer: no key configured, or the call failed there (and was logged). */
export class QualifierUnavailable extends Error {
  readonly reason: "not_configured" | "failed";

  constructor(reason: "not_configured" | "failed") {
    super(`qualifier unavailable: ${reason}`);
    this.name = "QualifierUnavailable";
    this.reason = reason;
  }
}

/**
 * A qualifier that runs in llm-gateway, which holds the key. The result keeps the gateway's
 * `provider`, which says who answered. An abort doesn't cross RPC: `runDecision`'s
 * timeout still returns on time, and the gateway bounds its own call.
 */
export class RemoteQualifier implements Qualifier {
  readonly id: QualifierId = "jev-http";
  readonly calibrated = true;
  readonly #call: (
    state: unknown,
    questions: Record<string, Question>,
  ) => Promise<GatewayQualifyOutcome>;

  constructor(
    call: (state: unknown, questions: Record<string, Question>) => Promise<GatewayQualifyOutcome>,
  ) {
    this.#call = call;
  }

  async qualify(state: unknown, questions: Record<string, Question>): Promise<QualifyResult> {
    const outcome = await this.#call(state, questions);
    if (!outcome.ok) throw new QualifierUnavailable(outcome.reason);
    return outcome.result;
  }
}
