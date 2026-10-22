import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { isPrivateDir, listNames, readSmall, readTail } from "./files.ts";
import { type RunnerVerdict, SESSION_ID, TOOL_NAME } from "./protocol.ts";

// The spool the session-event hook writes and the runner reads (ADR-0057 §2): one line per hook
// event, and each session's last excerpt in a file of its own. Since ADR-0069, also each permission
// request the permission hook holds open, the verdict the runner gives it, and each session's
// inbox address. A directory only the owner's user may open, holding files only it may read. No
// network, and no secret.

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
/**
 * A subagent's id, as Claude Code's `agent_id` gives it, such as `a1b2c3d4e5f6a7b8`: a short
 * token, never free text. `.` and `@` are let in for in-process teammates, whose ids the docs
 * don't show.
 */
export const AGENT_ID = /^[A-Za-z0-9_.@-]{1,64}$/;

/** A subagent's id when it is a short token; null, a subagent of unknown id, for anything else. */
export function agentOf(value: unknown): string | null {
  return typeof value === "string" && AGENT_ID.test(value) ? value : null;
}

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
  /**
   * The subagent whose tool call fired the event, by its id; null for a subagent whose id
   * isn't a short token. Absent from the main thread's events, and from the lines written before
   * #482.
   */
  agent?: string | null;
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
  const { at, event, session, type, reason, question, agent } = value as Record<string, unknown>;
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
    // Present, it says a subagent's: an id that isn't a token is one of unknown id, as in the hook.
    ...(agent === undefined ? {} : { agent: agentOf(agent) }),
  };
}

const EXCERPT_NAME = /^excerpt-([0-9a-f-]{36})\.json$/;
const TEMPORARY_NAME = /^\.(?:excerpt|request|socket)-[0-9a-f-]{36}\.\d+\.tmp$/;
const REQUEST_NAME = /^request-([0-9a-f-]{36})\.json$/;
const VERDICT_NAME = /^verdict-([0-9a-f-]{36})\.json$/;
const SOCKET_NAME = /^socket-([0-9a-f-]{36})\.json$/;

function excerptPath(dir: string, session: string): string {
  return join(dir, `excerpt-${session}.json`);
}

/**
 * Replaces a session's excerpt, `0600`: written aside, then renamed, so a reader never sees half
 * of one. `session` must be a UUID: it names the file.
 */
export function writeExcerpt(dir: string, session: string, excerpt: Excerpt): void {
  if (!SESSION_ID.test(session)) return;
  writeAside(dir, "excerpt", session, JSON.stringify(excerpt));
}

/**
 * Writes `<kind>-<id>.json`, `0600`, aside first and then renamed, so a reader never sees half of
 * it. `id` must be a UUID: it names the file.
 */
function writeAside(dir: string, kind: string, id: string, text: string): void {
  const temporary = join(dir, `.${kind}-${id}.${process.pid}.tmp`);
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, join(dir, `${kind}-${id}.json`));
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

/** A request's, a verdict's or an inbox address's file: a cut input, at most. */
export const MAX_ACTION_FILE_BYTES = 16 * 1024;
/** The longest inbox address taken: a Unix socket's path fits Linux's 108-byte `sun_path`. */
export const MAX_SOCKET_PATH_CHARS = 107;

/**
 * A permission prompt the permission hook holds open for Kelpie's verdict (ADR-0069 §1): its id,
 * which the hook drew at random, the session and its thread, when it opened and until when the
 * hook waits, the hook's own process, and the tool with its input, redacted and cut.
 */
export interface SpoolRequest {
  id: string;
  session: string;
  /** The subagent whose prompt it is, as an event's `agent`: absent for the main thread's. */
  agent?: string | null;
  at: number;
  deadline: number;
  pid: number;
  tool: string;
  input: string;
  /** Whether `input` is all of the tool's input: a request cut short never gets Approve. */
  whole: boolean;
}

/** The runner's verdict on a request: once written, only its taker removes it. */
export interface SpoolVerdict {
  id: string;
  behavior: RunnerVerdict;
  at: number;
}

/** A session's inbox address, as its `SessionStart` hook read `CLAUDE_CODE_MESSAGING_SOCKET`. */
export interface SpoolSocket {
  at: number;
  path: string;
}

export function writeRequest(dir: string, request: SpoolRequest): void {
  if (SESSION_ID.test(request.id)) writeAside(dir, "request", request.id, JSON.stringify(request));
}

/** A request, or null when none checks out under that id. */
export function readRequest(dir: string, id: string): SpoolRequest | null {
  const value = readAction(dir, "request", id);
  if (value === null) return null;
  const { session, agent, at, deadline, pid, tool, input, whole } = value;
  if (value.id !== id || typeof session !== "string" || !SESSION_ID.test(session)) return null;
  if (![at, deadline].every((time) => Number.isSafeInteger(time) && (time as number) >= 0)) {
    return null;
  }
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return null;
  if (typeof tool !== "string" || !TOOL_NAME.test(tool) || typeof input !== "string") return null;
  if (agent !== undefined && agent !== null && agentOf(agent) === null) return null;
  return {
    id,
    session,
    ...(agent === undefined ? {} : { agent: agent as string | null }),
    at: at as number,
    deadline: deadline as number,
    pid: pid as number,
    tool,
    input,
    // Missing, it reads as cut short: the safe side.
    whole: whole === true,
  };
}

export function deleteRequest(dir: string, id: string): void {
  if (SESSION_ID.test(id)) rmSync(join(dir, `request-${id}.json`), { force: true });
}

/**
 * Writes the runner's verdict, `0600`, unless a verdict is there already: false then, so a request
 * takes one verdict only. Never through a symlink in its place.
 */
export function writeVerdict(dir: string, verdict: SpoolVerdict): boolean {
  if (!SESSION_ID.test(verdict.id)) return false;
  let fd: number;
  try {
    fd = openSync(
      join(dir, `verdict-${verdict.id}.json`),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    return false;
  }
  try {
    writeSync(fd, JSON.stringify(verdict));
  } finally {
    closeSync(fd);
  }
  return true;
}

export function readVerdict(dir: string, id: string): SpoolVerdict | null {
  const value = readAction(dir, "verdict", id);
  if (value === null || value.id !== id) return null;
  const { behavior, at } = value;
  if ((behavior !== "allow" && behavior !== "deny") || !Number.isSafeInteger(at)) return null;
  return { id, behavior, at: at as number };
}

/**
 * Removes a verdict, and says whether this call did: the hook takes it to apply it, and the runner
 * takes back one the hook didn't take in time. Only one of them can.
 */
export function takeVerdict(dir: string, id: string): boolean {
  if (!SESSION_ID.test(id)) return false;
  try {
    unlinkSync(join(dir, `verdict-${id}.json`));
    return true;
  } catch {
    return false;
  }
}

export function writeSocket(dir: string, session: string, socket: SpoolSocket): void {
  if (SESSION_ID.test(session)) writeAside(dir, "socket", session, JSON.stringify(socket));
}

export function readSocket(dir: string, session: string): SpoolSocket | null {
  const value = readAction(dir, "socket", session);
  if (value === null) return null;
  const { at, path } = value;
  if (!Number.isSafeInteger(at) || typeof path !== "string") return null;
  if (!isAbsolute(path) || path.length > MAX_SOCKET_PATH_CHARS) return null;
  return { at: at as number, path };
}

export function deleteSocket(dir: string, session: string): void {
  if (SESSION_ID.test(session)) rmSync(join(dir, `socket-${session}.json`), { force: true });
}

/** The requests, verdicts and inbox addresses in the spool, by their ids. */
export function listActions(dir: string): {
  requests: string[];
  verdicts: string[];
  sockets: string[];
} {
  const listed = listNames(dir, MAX_SPOOL_ENTRIES);
  const found = { requests: [] as string[], verdicts: [] as string[], sockets: [] as string[] };
  for (const name of listed?.names ?? []) {
    for (const [pattern, list] of [
      [REQUEST_NAME, found.requests],
      [VERDICT_NAME, found.verdicts],
      [SOCKET_NAME, found.sockets],
    ] as const) {
      const id = pattern.exec(name)?.[1];
      if (id !== undefined && SESSION_ID.test(id)) list.push(id);
    }
  }
  return found;
}

/** A small JSON object from `<kind>-<id>.json`; null when the id isn't a UUID, or nothing checks out. */
function readAction(dir: string, kind: string, id: string): Record<string, unknown> | null {
  if (!SESSION_ID.test(id)) return null;
  const text = readSmall(join(dir, `${kind}-${id}.json`), MAX_ACTION_FILE_BYTES);
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
