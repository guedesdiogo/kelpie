import type { Actor } from "@kelpie/config";
import type { RecallOptions } from "@kelpie/context-store/contract";
import { withoutTypedStamps } from "@kelpie/conversation";
import type { ToolCallPart, ToolResult, ToolSpec } from "@kelpie/llm";

// The tool layer (ADR-0014, issue #141): providers offer an agent tools, and the conversation's
// turn runs the calls its model asks for. The setup agent's configuration commands (#48) and the
// memory tools (#126) arrive as providers.

/** The most rounds of tool calls a turn runs (ADR-0025); calls past them get TOOL_BOUND_RESULT. */
export const MAX_TOOL_ROUNDS = 5;

/** What a call past the turn's bounds gets. One last call then answers, with the same tools. */
export const TOOL_BOUND_RESULT =
  "Not run: this turn reached its limit for tools. Answer now with what you have.";

/** What a call still running when the turn's time ran out gets; one last call then answers. */
export const TOOL_TIMED_OUT_RESULT =
  "Stopped: this turn ran out of time for tools before the call finished, so it may or may not have taken effect. Answer now with what you have.";

/** What a call gets when a new message or a pause stopped the turn before it started. */
export const TOOL_NOT_RUN_RESULT = "Not run: the turn stopped before this call started.";

/**
 * What a call gets when the turn stopped while it ran, or when an eviction lost its result: it may
 * have done its work, so the next turn shouldn't assume either way.
 */
export const TOOL_STOPPED_RESULT =
  "Stopped before its result came back: it may or may not have taken effect.";

/** The longest tool output kept; history holds it and every later request sends it again. */
export const TOOL_OUTPUT_MAX_CHARS = 10_000;

/** What a tool that threw gets. Its error isn't passed on: it could quote personal data. */
export const TOOL_FAILED_RESULT = "The tool failed.";

/** The reply when even the last call asks for tools again. */
export const TOOL_LIMIT_TEXT =
  "I couldn't finish this within my limits. Ask me again, or narrow it down.";

/** A change a tool makes only with the owner's yes (ADR-0013). */
export interface ConfirmationRequest {
  /** The command the yes is for. */
  command: string;
  /** Its input as the command takes it, after parsing: the yes is for exactly this. */
  input: unknown;
  /**
   * What the owner is shown, written by the tool's code from the validated input, never by the
   * model: a sentence, starting in lower case, that names an agent by its id.
   */
  summary: string;
}

/** How long a confirmation's code lasts. */
export const CONFIRMATION_MS = 10 * 60_000;

/** The longest summary a notice shows, once made visible: the notice fits one Telegram message. */
export const MAX_SUMMARY_CHARS = 3_500;

/**
 * The text with every control, format, private-use, unassigned, line or paragraph separator and
 * default-ignorable character (variation selectors, fillers) written out as `\u{…}`, so nothing in
 * it is invisible or reorders what is shown.
 */
export function visible(text: string): string {
  return text.replace(
    /[\p{C}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu,
    (character) => `\\u{${(character.codePointAt(0) ?? 0).toString(16).toUpperCase()}}`,
  );
}

/**
 * The bubble the host sends after the turn's reply, so the owner can confirm a change. The summary
 * is shown with its invisible characters written out. With `button`, the webchat shows the notice
 * with a Confirm button that sends the code for the owner (#186); the code still works typed.
 */
export function confirmationNotice(summary: string, code: string, button = false): string {
  const how = button
    ? `press Confirm, or reply with just the code ${code}`
    : `reply with just the code ${code}`;
  return `Confirm: ${visible(summary)}\nTo go ahead, ${how}. It expires in ${CONFIRMATION_MS / 60_000} minutes.`;
}

/**
 * A link a tool has the host send the owner after the turn's reply, as a bubble of Kelpie's own
 * (#186): the model never sees it, so it can't alter it.
 */
export interface HostLink {
  /** Written by the tool's code from validated input, never by the model; it holds `href`. */
  text: string;
  /** The bubble's one link: a page on the admin API's origin, behind the owner's Access login. */
  href: string;
}

/** Codes avoid letters and digits that read alike: no 0/O, 1/I/L, 2/Z, 5/S, 8/B. */
const CODE_ALPHABET = "ACDEFHJKMNPRTWXY34679";

export function newConfirmationCode(): string {
  let code = "";
  while (code.length < 6) {
    // The largest multiple of the alphabet's size that fits a byte: above it, a byte would skew.
    for (const byte of crypto.getRandomValues(new Uint8Array(8))) {
      if (byte < 252 && code.length < 6) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    }
  }
  return code;
}

/**
 * Whether a message confirms the code: one of its lines, past the time stamp in front of it, is
 * the code alone, in ASCII letters and digits of any case, with a period or exclamation mark after
 * it at most. A line that only mentions the code, such as "don't do K7MPRX", or asks about it
 * ("K7MPRX?"), is no yes.
 */
export function confirmsCode(text: string, code: string): boolean {
  return withoutTypedStamps(text)
    .split("\n")
    .some((line) => {
      const word = line.trim();
      // Longer lines can't be the code; skipping them keeps a huge message cheap to check.
      if (word.length > MAX_CODE_LINE_CHARS) return false;
      const bare = word.replace(/[.!]+$/u, "");
      return /^[A-Za-z0-9]+$/.test(bare) && bare.toUpperCase() === code;
    });
}

const MAX_CODE_LINE_CHARS = 32;

/** JSON with every object's keys sorted, so equal inputs compare equal. */
export function canonicalJson(value: unknown): string {
  return (
    JSON.stringify(value, (_key, item: unknown) =>
      item !== null && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : item,
    ) ?? "null"
  );
}

/** What a tool's run knows about the turn. None of it comes from model output. */
export interface ToolContext {
  /** Built from the turn's admitted user, `via` the agent. */
  actor: Actor;
  agentId: string;
  /** The memory scopes the turn may read, as its recall uses them. */
  scopes: RecallOptions["scopes"];
  /** The agent's qualifier, for tools that rank as recall does: Clef unless the agent chose Jev. */
  qualifier: NonNullable<RecallOptions["qualifier"]>;
  /** The turn, the same for all its calls: what a tool counts per turn is keyed by it. */
  turn: string;
  /**
   * Where the turn's words came from, for what a tool saves: the conversation, as its session
   * pages name it, and the day in its time zone.
   */
  source: string;
  /** Aborts when the turn stops: a new message, a pause or an eviction. */
  signal: AbortSignal;
  /**
   * Whether the owner confirmed this change (ADR-0013): they reply with just the code the host
   * showed them for it, in a message of their own, or press the notice's Confirm button in the
   * webchat, which replies with the code for them (#186). Until they do, the host shows them the
   * summary and a code after the turn's reply, and this answers false: the call must not make the
   * change. A code lasts CONFIRMATION_MS, confirms exactly one command and input, and confirms once.
   * The model never sees a code before the owner sends it.
   */
  confirm(request: ConfirmationRequest): Promise<boolean>;
  /**
   * Has the host send the owner `link` after the turn's reply, as its own bubble, where `href` is
   * the only text that shows as a link (#186). History, the requests and the outbox's inspection
   * never hold it. A turn stopped before its reply drops it, as it drops the reply; a call the turn
   * gave up on sends nothing. An `href` that isn't an admin API page in `text` makes it throw.
   */
  sendLink(link: HostLink): void;
}

/**
 * A tool's answer for the model. A failure is a value; the model reads `output` either way, and
 * history keeps it, so it must not carry another service's error message: those can quote personal
 * data. Past TOOL_OUTPUT_MAX_CHARS it is cut.
 */
export interface ToolOutcome {
  output: string;
  isError?: boolean;
}

export interface Tool {
  spec: ToolSpec;
  /** Plain words the webchat shows while the tool runs, such as "Searching memory". */
  label: string;
  run(input: unknown, context: ToolContext): Promise<ToolOutcome>;
}

export interface ToolProvider {
  /**
   * The tools this provider gives an agent, none when it serves others. A turn asks once and keeps
   * the list for all its rounds; it should stay the same from turn to turn too, because a change
   * starts the provider's cache over.
   */
  tools(agentId: string): Promise<Tool[]>;
}

/** Runs one call. An unknown tool and a tool that throws are answered with an error. */
export async function runToolCall(
  tools: ReadonlyMap<string, Tool>,
  call: ToolCallPart,
  context: ToolContext,
): Promise<ToolResult> {
  const tool = tools.get(call.name);
  if (!tool) {
    const name = call.name.slice(0, 64);
    return { callId: call.id, output: `There is no tool named ${name}.`, isError: true };
  }
  try {
    const outcome = await tool.run(call.input, context);
    const output =
      outcome.output.length > TOOL_OUTPUT_MAX_CHARS
        ? // Never half of a surrogate pair.
          `${outcome.output.slice(0, TOOL_OUTPUT_MAX_CHARS).replace(/[\uD800-\uDBFF]$/, "")}\n[Cut: the result was longer.]`
        : outcome.output;
    return outcome.isError
      ? { callId: call.id, output, isError: true }
      : { callId: call.id, output };
  } catch (error) {
    // The tool's own name, never the model's input or the error's message.
    console.error("ConversationAgent: a tool failed", {
      tool: tool.spec.name,
      error: error instanceof Error ? error.name : typeof error,
    });
    return { callId: call.id, output: TOOL_FAILED_RESULT, isError: true };
  }
}
