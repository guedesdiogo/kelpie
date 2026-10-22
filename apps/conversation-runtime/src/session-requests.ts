import {
  type Locale,
  type Localized,
  RUNNER_INVISIBLE,
  RUNNER_LINE_BREAK,
  RUNNER_MAX_INPUT_CHARS,
  RUNNER_SESSION_ID,
  RUNNER_TOOL_NAME,
  type RunnerSessionsContract,
  type RunnerVerdict,
  type RunnerVerdictOutcome,
} from "@kelpie/channels";
import { CONFIRMATION_MS, newConfirmationCode } from "./tools.ts";

// Approve and Deny on the notice of a VPS session's permission prompt (ADR-0069 §1, #497). The
// notice carries the prompt the session's hook holds open; the conversation keeps, for 10 minutes,
// the two codes the owner may type, and the key the webchat's buttons send. The owner's press or
// code is the yes (ADR-0026): it goes to the runner as is, and never through the model, so Master's
// words never approve, and nor does a session's text.

/** A permission prompt a wait's notice carries, as AgentHost passes it across RPC. */
export interface SessionRequestNotice {
  /** The runner's id for it, which binds the verdict. */
  id: string;
  tool: string;
  /** Its input, redacted on the VPS, on one line. */
  input: string;
}

/** A request between its notice and the owner's answer, as the conversation keeps it. */
export interface OpenSessionRequest {
  /** What the webchat's Approve and Deny send: random, the conversation's own. */
  key: string;
  requestId: string;
  /** The codes the owner may type instead, on Telegram. */
  allow: string;
  deny: string;
  expiresAt: number;
  /** When the owner answered it, so it counts once. */
  usedAt: number | null;
}

/** How long a notice's codes and buttons count: a confirmation's 10 minutes (ADR-0026 §3). */
export const REQUEST_ANSWER_MS = CONFIRMATION_MS;
/** How long an answered or expired request is kept past its expiry, to answer a late code. */
const REQUEST_KEEP_MS = 60 * 60_000;
/** The most requests a conversation keeps: far more than an owner answers at once. */
export const MAX_KEPT_REQUESTS = 20;
/** How much of the tool's input the notice shows. */
export const NOTICE_INPUT_CHARS = 300;
/** A key, as the webchat's buttons send it. */
export const REQUEST_KEY = /^[0-9a-f]{16}$/;

/** A notice's request, checked across RPC; null for anything else. */
export function parseRequestNotice(value: unknown): SessionRequestNotice | null {
  if (typeof value !== "object" || value === null) return null;
  const { id, tool, input } = value as Record<string, unknown>;
  if (typeof id !== "string" || !RUNNER_SESSION_ID.test(id)) return null;
  if (typeof tool !== "string" || !RUNNER_TOOL_NAME.test(tool)) return null;
  if (typeof input !== "string" || input.length > RUNNER_MAX_INPUT_CHARS) return null;
  return { id, tool, input };
}

/**
 * Keeps a new request, with its codes and key, and drops what is past keeping, the oldest first
 * past MAX_KEPT_REQUESTS. A code that another kept request has is drawn again.
 */
export function keepRequest(
  kept: readonly OpenSessionRequest[],
  requestId: string,
  now: number,
  draw: { code: () => string; key: () => string } = { code: newConfirmationCode, key: randomKey },
): { kept: OpenSessionRequest[]; opened: OpenSessionRequest } {
  const live = kept.filter((request) => request.expiresAt + REQUEST_KEEP_MS > now);
  const taken = new Set(live.flatMap((request) => [request.allow, request.deny]));
  const fresh = () => {
    let code = draw.code();
    while (taken.has(code)) code = draw.code();
    taken.add(code);
    return code;
  };
  const opened: OpenSessionRequest = {
    key: draw.key(),
    requestId,
    allow: fresh(),
    deny: fresh(),
    expiresAt: now + REQUEST_ANSWER_MS,
    usedAt: null,
  };
  return { kept: [...live, opened].slice(-MAX_KEPT_REQUESTS), opened };
}

/**
 * The request a message answers, and how: the whole message is one of its codes, whatever its
 * case, maybe with a full stop or a bang after it. Null for any other message.
 */
export function answeredByCode(
  kept: readonly OpenSessionRequest[],
  text: string,
): { request: OpenSessionRequest; verdict: RunnerVerdict } | null {
  const word = text
    .trim()
    .replace(/[.!]+$/u, "")
    .toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(word)) return null;
  for (const request of kept) {
    if (request.allow === word) return { request, verdict: "allow" };
    if (request.deny === word) return { request, verdict: "deny" };
  }
  return null;
}

/**
 * What came of the owner's answer:
 * - `applied`: the session took it;
 * - `not_applied`: the runner had it, but the hook didn't take it in time, so it took it back;
 * - `closed`: the request was answered already, in the session, or ended;
 * - `expired`: its 10 minutes passed; `answered`: the owner answered it before, through Kelpie;
 * - `failed`: the runner wasn't reached, so the owner may try again.
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
  typed: (allow: string, deny: string) => string;
  buttons: string;
}> = {
  en: {
    tool: (tool, input) => `Tool: ${tool}, with ${input}.`,
    typed: (allow, deny) =>
      `To approve it, reply with ${allow}. To deny it, reply with ${deny}. Or answer it in the Claude app.`,
    buttons: "Approve or deny it here, or answer it in the Claude app.",
  },
  "pt-BR": {
    tool: (tool, input) => `Ferramenta: ${tool}, com ${input}.`,
    typed: (allow, deny) =>
      `Para aprovar, responda ${allow}. Para negar, responda ${deny}. Ou responda no app do Claude.`,
    buttons: "Aprove ou negue aqui, ou responda no app do Claude.",
  },
  es: {
    tool: (tool, input) => `Herramienta: ${tool}, con ${input}.`,
    typed: (allow, deny) =>
      `Para aprobarlo, responde ${allow}. Para negarlo, responde ${deny}. O respóndelo en la app de Claude.`,
    buttons: "Apruébalo o niégalo aquí, o respóndelo en la app de Claude.",
  },
};

/**
 * The lines a wait's notice gains for its request (ADR-0027): the tool and its input, as quoted
 * plain text on one line, and how to answer: the buttons in the webchat, the codes elsewhere.
 */
export function requestLines(
  request: SessionRequestNotice,
  opened: OpenSessionRequest,
  buttons: boolean,
  locale: Locale,
): string {
  const texts = NOTICE_TEXTS[locale];
  const how = buttons ? texts.buttons : texts.typed(opened.allow, opened.deny);
  return `${texts.tool(request.tool, quoted(request.input, NOTICE_INPUT_CHARS))}\n${how}`;
}

const REPLIES: Localized<
  Record<Exclude<VerdictStatus, "applied">, string> & {
    approved: string;
    denied: string;
  }
> = {
  en: {
    approved: "Approved: the session goes on.",
    denied: "Denied: the session was told no.",
    not_applied:
      "Kelpie couldn't hand your answer to the session in time. Answer it in the Claude app.",
    closed:
      "That request is no longer open: it was answered in the Claude app, or the session moved on.",
    expired: "That request expired. Answer it in the Claude app.",
    answered: "You already answered that request.",
    failed: "Kelpie couldn't reach the VPS's runner. Try again, or answer it in the Claude app.",
  },
  "pt-BR": {
    approved: "Aprovado: a sessão segue.",
    denied: "Negado: a sessão recebeu o não.",
    not_applied:
      "O Kelpie não conseguiu entregar sua resposta à sessão a tempo. Responda no app do Claude.",
    closed:
      "Esse pedido não está mais aberto: foi respondido no app do Claude, ou a sessão seguiu.",
    expired: "Esse pedido expirou. Responda no app do Claude.",
    answered: "Você já respondeu esse pedido.",
    failed:
      "O Kelpie não conseguiu falar com o runner da VPS. Tente de novo, ou responda no app do Claude.",
  },
  es: {
    approved: "Aprobado: la sesión sigue.",
    denied: "Negado: la sesión recibió el no.",
    not_applied:
      "Kelpie no pudo entregar tu respuesta a la sesión a tiempo. Respóndela en la app de Claude.",
    closed:
      "Esa solicitud ya no está abierta: se respondió en la app de Claude, o la sesión siguió.",
    expired: "Esa solicitud expiró. Respóndela en la app de Claude.",
    answered: "Ya respondiste esa solicitud.",
    failed:
      "Kelpie no pudo hablar con el runner de la VPS. Inténtalo de nuevo, o respóndela en la app de Claude.",
  },
};

/** Kelpie's fixed reply to a typed code (ADR-0027): what came of it. */
export function verdictReply(
  status: VerdictStatus,
  verdict: RunnerVerdict,
  locale: Locale,
): string {
  const texts = REPLIES[locale];
  if (status !== "applied") return texts[status];
  return verdict === "allow" ? texts.approved : texts.denied;
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
 * and it is cut to `max` with "…", then quoted with its own quotes escaped, so it can't close them.
 */
function quoted(text: string, max: number): string {
  const line = text.replace(INVISIBLES, "").replace(BREAKS, " ").replace(/\s+/gu, " ").trim();
  const characters = [...line];
  const cut =
    characters.length > max
      ? `${characters
          .slice(0, max - 1)
          .join("")
          .trimEnd()}…`
      : line;
  return `"${cut.replaceAll(/[\\"]/g, "\\$&")}"`;
}

function randomKey(): string {
  return [...crypto.getRandomValues(new Uint8Array(8))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
