/** Instructions are written in English; content in other languages goes in the state (ADR-0009). */
export type Instructions = string | Record<string, unknown>;

/** Jev's three typed question shapes (research note 04 §1). */
export type Question =
  | { type: "noul"; instructions: Instructions }
  | { type: "choice"; instructions: Instructions; criteria: Record<string, Instructions | null> }
  | { type: "score"; instructions: Instructions; criteria: Instructions[] };

export type Answer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number> }
  | { type: "score"; score: number; probabilities: Record<string, number> };

export type QualifierId =
  | "clef-workers-ai"
  | "jev-workers-ai"
  | "jev-http"
  | "jev-openrouter"
  | "llm-judge"
  | "fake";

/** The qualifiers an agent can choose between (issue #118). */
export const QUALIFIER_BACKENDS = ["clef", "jev"] as const;
export type QualifierBackend = (typeof QUALIFIER_BACKENDS)[number];

export interface QualifyResult {
  answers: Record<string, Answer>;
  provider: QualifierId;
  /** False for LLM judges and fakes; policies use more conservative thresholds then. */
  calibrated: boolean;
}

/** A typed-decision service. Kelpie works without one: every decision has a heuristic fallback. */
export interface Qualifier {
  readonly id: QualifierId;
  readonly calibrated: boolean;
  /** Implementations stop the request when `signal` aborts (the decision timed out). */
  qualify(
    state: unknown,
    questions: Record<string, Question>,
    options?: { signal?: AbortSignal },
  ): Promise<QualifyResult>;
}
