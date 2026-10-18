import { isAbsolute, join } from "node:path";
import { listNames, readSmall } from "./files.ts";
import { ENTRYPOINT, type RunnerVpsStatus, SESSION_ID } from "./protocol.ts";

// The files Claude Code keeps for each running session, `<claudeDir>/sessions/<pid>.json`. The
// folder is documented, its fields aren't (ADR-0057 §2): a field that is missing, or holds what
// the runner doesn't know, reads as unknown, never as an error.

/** The most session files read in one look. */
export const MAX_SESSION_FILES = 1_000;
/** The largest session file read: Claude Code's are under 1 KB. */
export const MAX_SESSION_FILE_BYTES = 64 * 1024;
/** The longest working folder taken. */
const MAX_CWD_CHARS = 4_096;
const STATUSES: readonly string[] = ["busy", "idle", "waiting"];

/** One session, as its file says. */
export interface SessionFile {
  id: string;
  pid: number | null;
  cwd: string | null;
  /** The title the Claude app shows. */
  name: string | null;
  status: RunnerVpsStatus;
  statusUpdatedAt: number | null;
  startedAt: number | null;
  entrypoint: string | null;
  /** Whether its process runs; null without a pid. */
  alive: boolean | null;
  /**
   * What a `waiting` session waits for, from `waitingFor`: Claude Code's free text, of which only
   * this kind is kept.
   */
  waitingFor: "permission" | "question" | "unknown";
}

/** `waitingFor` as Claude Code 2.1.299 writes it. */
const WAITING_FOR = new Map<string, SessionFile["waitingFor"]>([
  ["permission prompt", "permission"],
  ["input needed", "question"],
]);

/**
 * The sessions in `<claudeDir>/sessions`, one per session id, and whether every file was read;
 * null when the folder can't be read. A file without a session id that is a UUID is skipped. When
 * two files name one session, the one whose process runs wins, then the one that changed last.
 */
export function readSessionFiles(
  claudeDir: string,
  alive: (pid: number) => boolean = isAlive,
): { files: SessionFile[]; complete: boolean } | null {
  const dir = join(claudeDir, "sessions");
  const listed = listNames(dir, MAX_SESSION_FILES);
  if (!listed) return null;
  const byId = new Map<string, SessionFile>();
  for (const name of listed.names) {
    if (!name.endsWith(".json")) continue;
    const text = readSmall(join(dir, name), MAX_SESSION_FILE_BYTES);
    const file = text === null ? null : parseSessionFile(text, alive);
    if (!file) continue;
    const other = byId.get(file.id);
    if (!other || ranks(file, other)) byId.set(file.id, file);
  }
  return { files: [...byId.values()], complete: listed.complete };
}

/** Whether `a` stands for its session rather than `b`. */
function ranks(a: SessionFile, b: SessionFile): boolean {
  if ((a.alive === true) !== (b.alive === true)) return a.alive === true;
  return (a.statusUpdatedAt ?? -1) > (b.statusUpdatedAt ?? -1);
}

/** One session file's fields, each checked; null when it has no session id that is a UUID. */
export function parseSessionFile(
  text: string,
  alive: (pid: number) => boolean,
): SessionFile | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  const { sessionId, pid, cwd, name, status, entrypoint, waitingFor } = fields;
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return null;
  const processId = Number.isSafeInteger(pid) && (pid as number) > 0 ? (pid as number) : null;
  return {
    id: sessionId,
    pid: processId,
    cwd: typeof cwd === "string" && isAbsolute(cwd) && cwd.length <= MAX_CWD_CHARS ? cwd : null,
    name: typeof name === "string" && name.trim() !== "" ? name : null,
    status:
      typeof status === "string" && STATUSES.includes(status)
        ? (status as RunnerVpsStatus)
        : "unknown",
    statusUpdatedAt: timeOf(fields.statusUpdatedAt),
    startedAt: timeOf(fields.startedAt),
    entrypoint: typeof entrypoint === "string" && ENTRYPOINT.test(entrypoint) ? entrypoint : null,
    alive: processId === null ? null : alive(processId),
    waitingFor:
      (typeof waitingFor === "string" && WAITING_FOR.get(waitingFor.trim().toLowerCase())) ||
      "unknown",
  };
}

function timeOf(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

/**
 * Whether a process runs, by signal 0, which checks without sending anything. EPERM means it runs
 * as another user. A pid the system reused after a crash looks alive too.
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === "EPERM";
  }
}
