import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { isPrivateDir, listNames, readSmall, readTail } from "./files.ts";
import { SESSION_ID } from "./protocol.ts";

// The spool the session-event hook writes and the runner reads (ADR-0057 §2): one line per hook
// event, and each session's last excerpt in a file of its own. A directory only the owner's user
// may open, holding files only it may read. No network, and no secret.

/** Where the spool lives, under the owner's home. The hook and the runner both run as that user. */
export function spoolDirOf(home: string): string {
  return join(home, ".local", "state", "kelpie-runner", "session-events");
}

export const EVENTS_FILE = "events.ndjson";
/** The previous events, rotated out of EVENTS_FILE when it filled up. */
export const OLDER_EVENTS_FILE = "events.1.ndjson";
/**
 * The most each of the two events files holds: together, the spool keeps at most 1 MiB, and drops
 * its oldest half when the newer file fills up.
 */
export const MAX_EVENTS_FILE_BYTES = 512 * 1024;
/** An excerpt's file: 1,000 characters, even all escaped, and its time. */
export const MAX_EXCERPT_FILE_BYTES = 8 * 1024;
/** The most entries of the spool's directory looked at: two events files and one excerpt a session. */
export const MAX_SPOOL_ENTRIES = 2_000;

/** The hook's events, as ADR-0057 §2 lists them. */
export const HOOK_EVENTS = [
  "Notification",
  "PermissionRequest",
  "PermissionDenied",
  "PostToolUse",
  "PostToolUseFailure",
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "SessionEnd",
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** The `SessionEnd` reasons that don't end a session: `/clear`, and a resume (ADR-0057 §4). */
export const CONTINUING_REASONS: readonly string[] = ["clear", "resume"];

/** A notification's type, or a `SessionEnd`'s reason, as Claude Code names them. */
export const HOOK_WORD = /^[a-z_]{1,64}$/;

/** One line of the spool. Never a payload: no prompt, no tool input, no path. */
export interface SpoolEvent {
  /** When the hook ran, in epoch ms. */
  at: number;
  event: HookEvent;
  /** Claude Code's session id, a lowercase UUID. */
  session: string;
  /** A `Notification`'s type, such as `permission_prompt`. */
  type?: string;
  /** A `SessionEnd`'s reason, such as `clear` or `other`. */
  reason?: string;
  /** A `PermissionRequest`'s: whether it asks for `AskUserQuestion`, a question, or another tool. */
  question?: boolean;
}

/** A session's latest excerpt: its last reply, redacted and cut, and when the hook wrote it. */
export interface Excerpt {
  at: number;
  text: string;
}

/**
 * Makes the spool's directory, `0700`, or checks the one there. False when it isn't a private
 * directory of `uid`'s, and then nothing is written to it.
 */
export function prepareSpoolDir(dir: string, uid: number): boolean {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    return false;
  }
  return isPrivateDir(dir, uid);
}

/**
 * Appends one event's line, `0600`. A line that would take EVENTS_FILE past its bound first
 * rotates it to OLDER_EVENTS_FILE, dropping the older one. A hook that still holds the rotated file
 * open appends there, so no line is lost; two hooks rotating at once can drop the older half early.
 */
export function appendEvent(dir: string, event: SpoolEvent): void {
  const line = new TextEncoder().encode(`${JSON.stringify(event)}\n`);
  const path = join(dir, EVENTS_FILE);
  if (sizeOf(path) + line.byteLength > MAX_EVENTS_FILE_BYTES) {
    try {
      renameSync(path, join(dir, OLDER_EVENTS_FILE));
    } catch {
      // Another hook rotated it first.
    }
  }
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, line);
  } finally {
    closeSync(fd);
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** The spool's events, oldest file first; lines that don't parse are skipped. */
export function readEvents(dir: string): SpoolEvent[] {
  const events: SpoolEvent[] = [];
  for (const name of [OLDER_EVENTS_FILE, EVENTS_FILE]) {
    // A little past the bound, for the lines of hooks that rotated at once.
    const tail = readTail(join(dir, name), MAX_EVENTS_FILE_BYTES + 64 * 1024);
    if (!tail) continue;
    const lines = tail.text.split("\n");
    // A read that starts inside the file starts inside a line.
    if (tail.partial) lines.shift();
    for (const line of lines) {
      const event = parseSpoolLine(line);
      if (event) events.push(event);
    }
  }
  return events;
}

/** One line of the spool, checked field by field; null for anything else. */
export function parseSpoolLine(line: string): SpoolEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { at, event, session, type, reason, question } = value as Record<string, unknown>;
  if (!Number.isSafeInteger(at) || (at as number) < 0) return null;
  if (!HOOK_EVENTS.includes(event as HookEvent)) return null;
  if (typeof session !== "string" || !SESSION_ID.test(session)) return null;
  return {
    at: at as number,
    event: event as HookEvent,
    session,
    ...(typeof type === "string" && HOOK_WORD.test(type) ? { type } : {}),
    ...(typeof reason === "string" && HOOK_WORD.test(reason) ? { reason } : {}),
    ...(question === true ? { question } : {}),
  };
}

const EXCERPT_NAME = /^excerpt-([0-9a-f-]{36})\.json$/;
const TEMPORARY_NAME = /^\.excerpt-[0-9a-f-]{36}\.\d+\.tmp$/;

function excerptPath(dir: string, session: string): string {
  return join(dir, `excerpt-${session}.json`);
}

/**
 * Replaces a session's excerpt, `0600`: written aside, then renamed, so a reader never sees half
 * of one. `session` must be a UUID: it names the file.
 */
export function writeExcerpt(dir: string, session: string, excerpt: Excerpt): void {
  if (!SESSION_ID.test(session)) return;
  const temporary = join(dir, `.excerpt-${session}.${process.pid}.tmp`);
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, JSON.stringify(excerpt));
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, excerptPath(dir, session));
}

/** A session's excerpt, or null when it has none, or none that checks out. */
export function readExcerpt(dir: string, session: string): Excerpt | null {
  if (!SESSION_ID.test(session)) return null;
  const text = readSmall(excerptPath(dir, session), MAX_EXCERPT_FILE_BYTES);
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as Partial<Excerpt> | null;
    return Number.isSafeInteger(value?.at) && typeof value?.text === "string"
      ? { at: value.at as number, text: value.text }
      : null;
  } catch {
    return null;
  }
}

export function deleteExcerpt(dir: string, session: string): void {
  if (SESSION_ID.test(session)) rmSync(excerptPath(dir, session), { force: true });
}

/**
 * The sessions the spool holds an excerpt of, and its leftover temporary files, of hooks stopped
 * while writing one.
 */
export function listExcerpts(dir: string): { sessions: string[]; temporary: string[] } {
  const listed = listNames(dir, MAX_SPOOL_ENTRIES);
  const sessions: string[] = [];
  const temporary: string[] = [];
  for (const name of listed?.names ?? []) {
    const session = EXCERPT_NAME.exec(name)?.[1];
    if (session !== undefined && SESSION_ID.test(session)) sessions.push(session);
    else if (TEMPORARY_NAME.test(name)) temporary.push(name);
  }
  return { sessions, temporary };
}
