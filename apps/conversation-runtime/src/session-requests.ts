import {
  type Locale,
  type Localized,
  RUNNER_INVISIBLE,
  RUNNER_LINE_BREAK,
  RUNNER_MAX_INPUT_CHARS,
  RUNNER_SESSION_ID,
  RUNNER_TOOL_NAME,
  type RunnerSessionsContract,
  type RunnerVerdictOutcome,
} from "@kelpie/channels";
import { CONFIRMATION_MS } from "./tools.ts";

// Approve and Deny on the notice of a VPS session's permission prompt (ADR-0069 §1, #497). The
// notice carries the prompt the session's hook holds open, and its buttons the request's random id.
// The conversation keeps, for 10 minutes, the requests it showed buttons for, so a press counts
// only for a notice it sent, once. The owner's press is the verdict (ADR-0026): it goes to the
// runner as it is, never through the model, so Master's words never approve, and nor does a
// session's text. There is no typed code: the Claude app stays the other way to answer.

/** A permission prompt a wait's notice carries, as AgentHost passes it across RPC. */
export interface SessionRequestNotice {
  /** The runner's random id for it, which the buttons carry and the verdict is bound to. */
  id: string;
  tool: string;
  /** Its input, redacted on the VPS, on one line. */
  input: string;
  /** Whether the input leaves some of it out: then the notice offers no Approve. */
  truncated: boolean;
}

/** A request whose notice showed Approve and Deny, until the owner's press. */
export interface OpenSessionRequest {
  requestId: string;
  expiresAt: number;
  /** When the owner pressed, so it counts once. */
  usedAt: number | null;
}

/** How long a notice's buttons count: a confirmation's 10 minutes (ADR-0026 §3). */
export const REQUEST_ANSWER_MS = CONFIRMATION_MS;
/** How long a request is kept past its expiry, to answer a late press. */
const REQUEST_KEEP_MS = 60 * 60_000;
/** The most requests a conversation keeps: far more than an owner answers at once. */
export const MAX_KEPT_REQUESTS = 20;
/** How much of the tool's input the notice shows: all the runner sends. */
export const NOTICE_INPUT_CHARS = RUNNER_MAX_INPUT_CHARS;

/** A notice's request, checked across RPC; null for anything else. */
export function parseRequestNotice(value: unknown): SessionRequestNotice | null {
  if (typeof value !== "object" || value === null) return null;
  const { id, tool, input, truncated } = value as Record<string, unknown>;
  if (typeof id !== "string" || !RUNNER_SESSION_ID.test(id)) return null;
  if (typeof tool !== "string" || !RUNNER_TOOL_NAME.test(tool)) return null;
  if (typeof input !== "string" || input.length > RUNNER_MAX_INPUT_CHARS) return null;
  return typeof truncated === "boolean" ? { id, tool, input, truncated } : null;
}

/**
 * Keeps a request whose notice shows buttons, in place of one of the same id, and drops what is
 * past keeping, the oldest first past MAX_KEPT_REQUESTS.
 */
export function keepRequest(
  kept: readonly OpenSessionRequest[],
  requestId: string,
  now: number,
): { kept: OpenSessionRequest[]; opened: OpenSessionRequest } {
  const live = kept.filter(
    (request) => request.expiresAt + REQUEST_KEEP_MS > now && request.requestId !== requestId,
  );
  const opened = { requestId, expiresAt: now + REQUEST_ANSWER_MS, usedAt: null };
  return { kept: [...live, opened].slice(-MAX_KEPT_REQUESTS), opened };
}

/**
 * What came of the owner's press:
 * - `applied`: the session took it;
 * - `not_applied`: the runner had it, but the hook didn't take it in time, so it took it back;
 * - `closed`: the request was answered already, in the session, or ended, or isn't one this
 *   conversation showed;
 * - `expired`: its 10 minutes passed; `answered`: the owner pressed before;
 * - `failed`: the runner wasn't reached, so the owner may press again.
 */
export type VerdictStatus =
  | "applied"
  | "not_applied"
  | "closed"
  | "expired"
  | "answered"
  | "failed";

/** The runner's answer to a verdict, as the owner reads it. */
export function verdictStatus(outcome: RunnerVerdictOutcome): VerdictStatus {
  if (outcome.ok) return outcome.applied ? "applied" : "not_applied";
  return outcome.reason === "closed" ? "closed" : "failed";
}

const NOTICE_TEXTS: Localized<{
  tool: (tool: string, input: string) => string;
  buttons: string;
  inApp: string;
  cut: string;
}> = {
  en: {
    tool: (tool, input) => `Tool: ${tool}, with ${input}.`,
    buttons: "Approve or deny it here, or answer it in the Claude app.",
    inApp: "Answer it in the Claude app.",
    cut: "Its input is longer than this notice shows, so answer it in the Claude app.",
  },
  "pt-BR": {
    tool: (tool, input) => `Ferramenta: ${tool}, com ${input}.`,
    buttons: "Aprove ou negue aqui, ou responda no app do Claude.",
    inApp: "Responda no app do Claude.",
    cut: "A entrada é mais longa do que este aviso mostra, então responda no app do Claude.",
  },
  es: {
    tool: (tool, input) => `Herramienta: ${tool}, con ${input}.`,
    buttons: "Apruébalo o niégalo aquí, o respóndelo en la app de Claude.",
    inApp: "Respóndelo en la app de Claude.",
    cut: "Su entrada es más larga de lo que muestra este aviso, así que respóndelo en la app de Claude.",
  },
};

/**
 * The lines a wait's notice gains for its request (ADR-0027): the tool and its input, as quoted
 * plain text on one line, and where to answer it: here, with the buttons, or in the Claude app. An
 * input cut short shows "…", and only the Claude app answers it: no one approves what they
 * didn't see whole.
 */
export function requestLines(
  request: SessionRequestNotice,
  buttons: boolean,
  locale: Locale,
): string {
  const texts = NOTICE_TEXTS[locale];
  const input = quoted(request.input, NOTICE_INPUT_CHARS, request.truncated);
  const how = request.truncated ? texts.cut : buttons ? texts.buttons : texts.inApp;
  return `${texts.tool(request.tool, input)}\n${how}`;
}

/** Whether a notice of `request` may show Approve and Deny: only when it shows all its input. */
export function answerable(request: SessionRequestNotice): boolean {
  return !request.truncated;
}

type RunnerVerdicts = Pick<RunnerSessionsContract, "verdict">;

let verdictsForTesting: RunnerVerdicts | undefined;

/**
 * Tests run in the Worker's isolate and swap channel-egress's RunnerSessions with this, for the
 * verdicts. Production never calls it.
 */
export function replaceRunnerVerdictsForTesting(verdicts: RunnerVerdicts | undefined): void {
  verdictsForTesting = verdicts;
}

/** channel-egress's RunnerSessions, for the owner's verdicts. */
export function runnerVerdictsOf(env: { RUNNER_SESSIONS: unknown }): RunnerVerdicts {
  return verdictsForTesting ?? (env.RUNNER_SESSIONS as RunnerVerdicts);
}

const BREAKS = new RegExp(RUNNER_LINE_BREAK.source, "g");
const INVISIBLES = new RegExp(RUNNER_INVISIBLE.source, "gu");

/**
 * A session's own text as a notice shows it: what shows nothing goes, each break becomes a space,
 * and it is cut to `max` with "…", or ends with one when `more` says it was cut before, then quoted
 * with its own quotes escaped, so it can't close them.
 */
function quoted(text: string, max: number, more = false): string {
  const line = text.replace(INVISIBLES, "").replace(BREAKS, " ").replace(/\s+/gu, " ").trim();
  const characters = [...line];
  const cut =
    characters.length > max || more
      ? `${characters
          .slice(0, max - 1)
          .join("")
          .trimEnd()}…`
      : line;
  return `"${cut.replaceAll(/[\\"]/g, "\\$&")}"`;
}
