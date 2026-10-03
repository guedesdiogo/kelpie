import type { Answer, Qualifier, QualifierId, QualifyResult, Question } from "./types.ts";

/** Recorded answers keyed by prefixed question, for tests and CI (no network, no key). */
export class FakeQualifier implements Qualifier {
  readonly id: QualifierId = "fake";
  readonly calibrated = false;

  constructor(private readonly recorded: Record<string, Answer>) {}

  async qualify(_state: unknown, questions: Record<string, Question>): Promise<QualifyResult> {
    // Answers come from memory, so there is nothing to abort.
    const answers: Record<string, Answer> = {};
    for (const key of Object.keys(questions)) {
      const answer = this.recorded[key];
      if (answer) answers[key] = answer;
    }
    return { answers, provider: this.id, calibrated: this.calibrated };
  }
}
