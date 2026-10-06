import type { Answer, Question } from "./types.ts";

// TypeSafe's System One API: the request and answer shapes that Jev (ADR-0018) and Cloudflare's
// Clef models both speak.

/** The answers that match their question's type; anything else is dropped. */
export function systemOneAnswers(
  questions: Record<string, Question>,
  raw: unknown,
): Record<string, Answer> {
  const received = (raw as { answers?: Record<string, unknown> } | null)?.answers;
  const answers: Record<string, Answer> = {};
  for (const [key, question] of Object.entries(questions)) {
    const answer = toAnswer(question, received?.[key]);
    if (answer) answers[key] = answer;
  }
  return answers;
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
