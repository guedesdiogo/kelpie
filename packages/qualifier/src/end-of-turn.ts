import type { Decision } from "./decision.ts";

export interface EndOfTurnContext {
  /** The user's buffered fragments, oldest first. */
  fragments: string[];
}

export interface EndOfTurn {
  /** The probability that the user has finished and is waiting for a reply. */
  finished: number;
}

const CONNECTIVES = new Set([
  "e",
  "mas",
  "então",
  "entao",
  "tipo",
  "pera",
  "porque",
  "que",
  "ou",
  "aí",
  "ai",
  "daí",
  "dai",
  "and",
  "but",
  "so",
  "because",
  "or",
]);
const GREETINGS = new Set([
  "oi",
  "olá",
  "ola",
  "opa",
  "eae",
  "e aí",
  "bom dia",
  "boa tarde",
  "boa noite",
  "hi",
  "hello",
  "hey",
]);

/** A keyless estimate from the latest fragment (research note 04 §4.2). */
export function heuristicFinished({ fragments }: EndOfTurnContext): number {
  const last = (fragments.at(-1) ?? "").trim();
  if (!last) return 0.5;
  if (last.startsWith("/")) return 0.9;
  if (/\?\s*$/.test(last)) return 0.9;
  if (/(\.\.\.|…|[,:;])\s*$/.test(last)) return 0.2;

  const bare = last.toLowerCase().replace(/[!.]+$/, "");
  if (CONNECTIVES.has(bare.split(/\s+/).at(-1) ?? "")) return 0.15;
  if (GREETINGS.has(bare)) return 0.2;
  if (/[.!]\s*$/.test(last) && last.length >= 15) return 0.85;
  return 0.5;
}

export interface QuietWindowPolicy {
  finishedMs: number;
  defaultMs: number;
  unfinishedMs: number;
}

/** How long to wait for more fragments, given how likely the user is done. */
export function quietWindowMs(finished: number, policy: QuietWindowPolicy): number {
  if (finished >= 0.8) return policy.finishedMs;
  if (finished <= 0.3) return policy.unfinishedMs;
  return policy.defaultMs;
}

/** "Has the user finished typing?" Jev answers when configured; the heuristic otherwise. */
export const endOfTurn: Decision<EndOfTurnContext, EndOfTurn> = {
  id: "turn.end",
  version: "1",
  timeoutMs: 800,
  state: ({ fragments }) => ({ fragments }),
  questions: () => ({
    user_finished: {
      type: "noul",
      instructions:
        "The fragments are consecutive chat messages from one user, oldest first. Has the user finished their message and is now waiting for a reply?",
    },
  }),
  policy: ({ answers }) => {
    const answer = answers.user_finished;
    return answer?.type === "noul" ? { finished: answer.noul } : null;
  },
  fallback: (context) => ({ finished: heuristicFinished(context) }),
};
