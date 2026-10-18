import type { RunnerVpsState } from "./protocol.ts";
import type { SessionFile } from "./session-files.ts";
import { CONTINUING_REASONS, type SpoolEvent } from "./spool.ts";

// A session's life, from its session file and its hook events (ADR-0057 §4).

/** A session idle this long could be archived (ADR-0057 §4). */
export const ARCHIVE_IDLE_MS = 3 * 60 * 60_000;

/** A wait on the owner, from the hook event that opened it. */
export interface Wait {
  kind: "permission" | "question";
  openedAt: number;
}

export interface SessionLife {
  state: RunnerVpsState;
  /** When the state began; null when nothing says. */
  since: number | null;
  /** The open wait, while the session waits on the owner. */
  wait: Wait | null;
  archivable: boolean;
}

/**
 * The session's state now:
 * - a hook's wait opens on `PermissionRequest`, or on a `Notification` of type
 *   `permission_prompt` or `elicitation_dialog`. A prompt that follows a request joins it. A
 *   question is `AskUserQuestion`'s request, or an elicitation; anything else a permission;
 * - it closes on the session's next `UserPromptSubmit`, `PermissionDenied`, `PostToolUse`,
 *   `PostToolUseFailure`, `Stop`, `StopFailure` or `SessionEnd`, or when the session file turns
 *   `idle`, or `busy` again, after the wait opened;
 * - a file's wait opens while the session file says `waiting`, at the time it said so, and closes
 *   on one of those events after that. Its kind is the file's `waitingFor`: a permission prompt, or
 *   needed input, which is a question, as is anything else;
 * - a session has one wait at most: a file's wait and a hook's are one, opened at the earlier
 *   time, of the hook's kind, which says more;
 * - a session has ended when its process is gone, or after a `SessionEnd` whose reason isn't
 *   `clear` or `resume`, until another event comes;
 * - otherwise its file says: `busy` is working.
 */
export function lifeOf(file: SessionFile, events: readonly SpoolEvent[], now: number): SessionLife {
  let wait: Wait | null = null;
  let endedAt: number | null = null;
  let lastAt: number | null = null;
  // The last event that closes a wait: a file's wait that opened before it is closed too.
  let closedAt: number | null = null;
  // Hooks run as processes of their own, so their lines may land a little out of order.
  for (const event of [...events].sort((a, b) => a.at - b.at)) {
    lastAt = event.at;
    endedAt = null;
    switch (event.event) {
      case "PermissionRequest":
        wait ??= { kind: event.question ? "question" : "permission", openedAt: event.at };
        break;
      case "Notification":
        if (event.type === "permission_prompt") wait ??= { kind: "permission", openedAt: event.at };
        if (event.type === "elicitation_dialog") wait ??= { kind: "question", openedAt: event.at };
        break;
      case "SessionEnd":
        wait = null;
        closedAt = event.at;
        if (!CONTINUING_REASONS.includes(event.reason ?? "")) endedAt = event.at;
        break;
      default:
        wait = null;
        closedAt = event.at;
    }
  }
  const changed = file.statusUpdatedAt;
  if (
    wait &&
    (file.status === "idle" || file.status === "busy") &&
    changed !== null &&
    changed > wait.openedAt
  ) {
    wait = null;
  }
  if (file.status === "waiting" && changed !== null && (closedAt === null || closedAt <= changed)) {
    const kind = file.waitingFor === "permission" ? "permission" : "question";
    wait = wait
      ? { kind: wait.kind, openedAt: Math.min(wait.openedAt, changed) }
      : { kind, openedAt: changed };
  }
  if (file.alive === false || endedAt !== null) {
    return {
      state: "ended",
      since: endedAt ?? latest(changed, lastAt),
      wait: null,
      archivable: true,
    };
  }
  if (wait) {
    const state = wait.kind === "question" ? "waiting_answer" : "waiting_permission";
    return { state, since: wait.openedAt, wait, archivable: false };
  }
  if (file.status === "idle") {
    const archivable = changed !== null && now - changed >= ARCHIVE_IDLE_MS;
    return { state: "idle", since: changed, wait: null, archivable };
  }
  const state = file.status === "unknown" ? "unknown" : "working";
  return { state, since: changed, wait: null, archivable: false };
}

function latest(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  return b === null ? a : Math.max(a, b);
}
