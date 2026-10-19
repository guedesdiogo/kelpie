import { INVISIBLE, MAX_EXCERPT_CHARS, SESSION_ID } from "./protocol.ts";
import { cut, excerptOf, redact } from "./redact.ts";
import {
  appendEvent,
  CONTINUING_REASONS,
  deleteExcerpt,
  HOOK_EVENTS,
  HOOK_WORD,
  type HookEvent,
  prepareSpoolDir,
  type SpoolEvent,
  writeExcerpt,
} from "./spool.ts";

// The session-event hook (ADR-0057 §2), which hooks/session-event.ts runs for every event of
// every Claude Code session on the VPS. It must stay cheap, and it must never stand in a session's
// way: it reads its input, writes one line and maybe an excerpt, and returns.

/** The most of a hook's input read. A larger one, as a huge tool result, is dropped whole. */
export const MAX_INPUT_BYTES = 4 * 1024 * 1024;
/**
 * How long the hook may run. Claude Code doesn't enforce an async hook's `timeout`, so the hook
 * keeps its own, below the 2 s its settings give it.
 */
export const HOOK_DEADLINE_MS = 1_500;
/**
 * How much of a reply the hook keeps, redacted: twice what leaves. The runner redacts its own
 * secret by value before it cuts to 500, so a secret the hook can't know is whole when it does,
 * whatever its shape.
 */
export const HOOK_EXCERPT_CHARS = 2 * MAX_EXCERPT_CHARS;
/**
 * How much of a reply the hook redacts: far more than it keeps, so a secret near the cut is whole,
 * and bounded, so a huge reply costs no more than this.
 */
export const HOOK_REDACT_CHARS = 16 * 1024;
/**
 * The hook's command in `settings.json` (docs/runner.md). Claude Code runs it through `sh`, from
 * the session's folder: Bun would load that folder's `bunfig.toml`, its `preload` included, and
 * its `.env`, so a repository could run code as the owner. The command moves to the runner's
 * checkout first, and gives Bun an empty bunfig of its own and no `.env`.
 */
export const HOOK_COMMAND =
  'cd "$HOME/Repos/kelpie/tools/runner" && exec "$HOME/.bun/bin/bun" --no-env-file --config=hooks/bunfig.toml hooks/session-event.ts';
/** What shows nothing, removed from a reply before it is redacted. */
const INVISIBLES = new RegExp(INVISIBLE.source, "gu");
/** The tool whose permission request is a question to the owner. */
const QUESTION_TOOL = "AskUserQuestion";

export interface HookOptions {
  /** The spool's directory. */
  dir: string;
  /** The event's time, in epoch ms. */
  now: number;
  /** The owner's user, whose private directory the spool must be. */
  uid: number;
}

/** Everything the hook does with its input. It never throws, whatever the input or the disk. */
export async function runHook(
  input: AsyncIterable<Uint8Array | string>,
  options: HookOptions,
): Promise<void> {
  try {
    const text = await readInput(input, MAX_INPUT_BYTES);
    if (text !== null) recordEvent(text, options);
  } catch {
    // A hook that fails never stops a session.
  }
}

/** The input as text, read up to `maxBytes`; null past them. */
export async function readInput(
  input: AsyncIterable<Uint8Array | string>,
  maxBytes: number,
): Promise<string | null> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    size += bytes.byteLength;
    if (size > maxBytes) return null;
    chunks.push(bytes);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

/**
 * Records one hook event: its line in the spool, and for `Stop` the session's excerpt. An input
 * that isn't one of the events, or whose session id isn't a UUID, writes nothing.
 */
export function recordEvent(input: string, { dir, now, uid }: HookOptions): void {
  let payload: Record<string, unknown>;
  try {
    const value = JSON.parse(input) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return;
    payload = value as Record<string, unknown>;
  } catch {
    return;
  }
  const event = payload.hook_event_name;
  const session = payload.session_id;
  if (!HOOK_EVENTS.includes(event as HookEvent)) return;
  if (typeof session !== "string" || !SESSION_ID.test(session)) return;
  if (!prepareSpoolDir(dir, uid)) return;
  appendEvent(dir, lineOf(event as HookEvent, session, now, payload));
  if (event === "Stop") {
    const reply = payload.last_assistant_message;
    // The whole reply is redacted before it is cut, so no secret straddles the cut.
    // What shows nothing goes first: it could split a key, which would then pass, rejoined.
    const text =
      typeof reply === "string"
        ? excerptOf(
            redact(cut(reply, HOOK_REDACT_CHARS).replace(INVISIBLES, "")),
            HOOK_EXCERPT_CHARS,
          )
        : "";
    // Only the latest reply's excerpt is kept: a reply without text leaves none.
    if (text.trim() === "") deleteExcerpt(dir, session);
    else writeExcerpt(dir, session, { at: now, text });
  } else if (event === "SessionEnd" && !CONTINUING_REASONS.includes(String(payload.reason))) {
    deleteExcerpt(dir, session);
  }
}

/** The event's line: its name, its type or reason, whether it is a question, and its time. */
function lineOf(
  event: HookEvent,
  session: string,
  at: number,
  payload: Record<string, unknown>,
): SpoolEvent {
  const word = (value: unknown) =>
    typeof value === "string" && HOOK_WORD.test(value) ? value : undefined;
  const type = event === "Notification" ? word(payload.notification_type) : undefined;
  const reason = event === "SessionEnd" ? word(payload.reason) : undefined;
  const question = event === "PermissionRequest" && payload.tool_name === QUESTION_TOOL;
  return {
    at,
    event,
    session,
    ...(type === undefined ? {} : { type }),
    ...(reason === undefined ? {} : { reason }),
    ...(question ? { question } : {}),
  };
}
