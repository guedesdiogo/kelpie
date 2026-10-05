import type { Decision } from "./decision.ts";
import type { QualifierId } from "./types.ts";

export interface EndOfTurnContext {
  /** The user's buffered fragments, oldest first. */
  fragments: string[];
}

export interface EndOfTurn {
  /** The probability that the user has finished and is waiting for a reply. */
  finished: number;
}

/** Words that leave a sentence hanging when they come last ("queria ver o pedido e"). */
const DANGLING = new Set([
  "e",
  "mas",
  "então",
  "entao",
  "tipo",
  "pera",
  "porque",
  "ou",
  "daí",
  "dai",
  "and",
  "but",
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
const SMALL_TALK = /^(tudo bem|tudo bom|td bem|como vai|como você está|how are you)$/;
/** Short replies that usually answer the agent's own question. */
const ACKNOWLEDGEMENTS = new Set([
  "ok",
  "okay",
  "blz",
  "beleza",
  "sim",
  "não",
  "nao",
  "pode ser",
  "valeu",
  "vlw",
  "obrigado",
  "obrigada",
  "obg",
  "certo",
  "fechado",
  "combinado",
  "perfeito",
  "show",
  "yes",
  "no",
  "sure",
  "thanks",
  "thank you",
]);
const TRAILING_EMOJI = /(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\u{FE0F}|\u{200D}|\s)+$/u;

/** A keyless estimate from the latest fragment (research note 04 §4.2). */
export function heuristicFinished({ fragments }: EndOfTurnContext): number {
  const raw = (fragments.at(-1) ?? "").trim();
  if (!raw) return 0.5;
  const last = raw.replace(TRAILING_EMOJI, "");
  if (!last) return 0.85; // emoji only, such as a thumbs-up
  const bare = last
    .toLowerCase()
    .replace(/[!.?]+$/, "")
    .trim();

  // A greeting, alone or with small talk, usually comes before the actual request.
  const [first = "", ...rest] = bare.split(/\s*,\s*/);
  if (GREETINGS.has(first) && (rest.length === 0 || SMALL_TALK.test(rest.join(" ")))) return 0.2;
  if (/^\/\w+(\s|$)/.test(last)) return 0.9; // a command such as /status
  if (/\?[!?]*$/.test(last)) return 0.9;
  if (/(\.\.\.|…|[,:;])$/.test(last)) return 0.2;
  const words = bare.split(/\s+/);
  // "fechado então", "beleza então": after an acknowledgement, "então" settles the matter.
  const lastWord = words.at(-1) ?? "";
  if (
    (lastWord === "então" || lastWord === "entao") &&
    ACKNOWLEDGEMENTS.has(words.slice(0, -1).join(" "))
  ) {
    return 0.85;
  }
  if (DANGLING.has(lastWord)) return 0.15;
  if (ACKNOWLEDGEMENTS.has(bare)) return 0.85;
  if (/[.!]$/.test(last) && last.length >= 10) return 0.85;
  return 0.5;
}

export interface QuietWindowPolicy {
  finishedMs: number;
  defaultMs: number;
  unfinishedMs: number;
}

/** At or above `high` the user looks done; at or below `low` they don't. */
export interface Bands {
  high: number;
  low: number;
}

/** The heuristic's own values, and the default for a qualifier without measured bands. */
export const HEURISTIC_BANDS: Bands = { high: 0.8, low: 0.3 };
/** Jev 1.13.0 compresses its PT-BR probabilities (ADR-0018). Recalibrate on real conversations. */
export const JEV_BANDS: Bands = { high: 0.7, low: 0.4 };

/** The bands of whoever answered: Jev's ids get Jev's, everyone else the heuristic's. */
export function endOfTurnBands(source: QualifierId | "heuristic"): Bands {
  return source.startsWith("jev-") ? JEV_BANDS : HEURISTIC_BANDS;
}

/** How long to wait for more fragments, given how likely the user is done. */
export function quietWindowMs(
  finished: number,
  policy: QuietWindowPolicy,
  bands: Bands = HEURISTIC_BANDS,
): number {
  if (finished >= bands.high) return policy.finishedMs;
  if (finished <= bands.low) return policy.unfinishedMs;
  return policy.defaultMs;
}

/**
 * "Has the user finished typing?" A confident heuristic rule answers first; otherwise Jev when
 * configured, and the heuristic again without it (the hybrid of ADR-0018).
 */
export const endOfTurn: Decision<EndOfTurnContext, EndOfTurn> = {
  id: "turn.end",
  version: "2",
  timeoutMs: 800,
  shortcut: (context) => {
    const finished = heuristicFinished(context);
    return finished >= HEURISTIC_BANDS.high || finished <= HEURISTIC_BANDS.low
      ? { finished }
      : null;
  },
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
    if (answer?.type !== "noul") return null;
    const { noul } = answer;
    return Number.isFinite(noul) && noul >= 0 && noul <= 1 ? { finished: noul } : null;
  },
  fallback: (context) => ({ finished: heuristicFinished(context) }),
};
