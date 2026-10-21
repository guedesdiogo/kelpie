import type { RunnerVpsState } from "./protocol.ts";
import type { SessionFile } from "./session-files.ts";
import { CONTINUING_REASONS, type SpoolEvent } from "./spool.ts";

// A session's life, from its session file and its hook events (ADR-0057 §4).

/** A session idle this long could be archived (ADR-0057 §4). */
export const ARCHIVE_IDLE_MS = 3 * 60 * 60_000;
/**
 * A file's wait and a hook's this close are one prompt's: the file follows the hook's request by
 * a moment, and its `permission_prompt` by 6 s.
 */
export const WAIT_JOIN_MS = 60_000;

/** A wait on the owner, from the hook event or the session file that opened it. */
export interface Wait {
  kind: "permission" | "question";
  openedAt: number;
}

export interface SessionLife {
  state: RunnerVpsState;
  /** When the state began; null when nothing says. */
  since: number | null;
  /** The open wait, while the session waits on the owner: the latest opened of its threads'. */
  wait: Wait | null;
  archivable: boolean;
}

/**
 * A session's thread, by its events' `agent` (#482): `undefined` for the main thread, whose events
 * carry none, as every line from before #482; a subagent's id; or `null` for the subagents whose
 * id isn't a short token, taken for one thread.
 */
type Thread = string | null | undefined;

/**
 * The session's state now:
 * - each of its threads has a wait of its own. A subagent's events never close or join the main
 *   thread's wait, nor the main thread's a subagent's: a review subagent working in the background
 *   no longer closes the main thread's question (#482);
 * - a hook's wait opens on its thread's `PermissionRequest`, or `Notification` of type
 *   `permission_prompt` or `elicitation_dialog`: a subagent's prompt waits on the owner too. A
 *   prompt within WAIT_JOIN_MS of its thread's open wait joins it; a later one is the thread's next
 *   prompt, and replaces it. A question is `AskUserQuestion`'s request, or an elicitation; anything
 *   else a permission;
 * - it closes on its thread's next `UserPromptSubmit`, `PermissionDenied`, `PostToolUse`,
 *   `PostToolUseFailure`, `Stop` or `StopFailure`, and on the session's `SessionEnd`, whichever
 *   thread's. The main thread's also closes when the session file turns `idle`, or `busy` again,
 *   after it opened; a subagent's doesn't, as the file's status is taken for the main thread's;
 * - a file's wait is the main thread's. It opens while the session file says `waiting`, at the
 *   time it said so, and closes on one of the main thread's closing events after that. Its kind is
 *   the file's `waitingFor`: a permission prompt, or needed input, which is a question, as is
 *   anything else. It and the main thread's hook wait within WAIT_JOIN_MS are one, opened at the
 *   earlier time, of the hook's kind, which says more. Further apart, the later is the next prompt
 *   and the earlier is stale, as when a hook's close was lost;
 * - the session's wait is the latest opened of its threads' open waits. So a new prompt shows, and
 *   is told, while another thread's older one waits, or one whose close was lost;
 * - a session has ended when its process is gone, or after a `SessionEnd` whose reason isn't
 *   `clear` or `resume`, until another event comes. A process that started after the end, as
 *   after a reboot, took the session up again: its end is stale;
 * - otherwise its file says: `busy` is working.
 */
export function lifeOf(file: SessionFile, events: readonly SpoolEvent[], now: number): SessionLife {
  const waits = new Map<Thread, Wait>();
  let endedAt: number | null = null;
  let lastAt: number | null = null;
  // The main thread's last event that closes a wait: a file's wait that opened before it is closed
  // too. A subagent's events close only its own.
  let closedAt: number | null = null;
  // Hooks run as processes of their own, so their lines may land a little out of order.
  for (const event of [...events].sort((a, b) => a.at - b.at)) {
    lastAt = event.at;
    endedAt = null;
    const thread: Thread = event.agent;
    switch (event.event) {
      case "PermissionRequest":
        open(waits, thread, {
          kind: event.question ? "question" : "permission",
          openedAt: event.at,
        });
        break;
      case "Notification":
        if (event.type === "permission_prompt") {
          open(waits, thread, { kind: "permission", openedAt: event.at });
        }
        if (event.type === "elicitation_dialog") {
          open(waits, thread, { kind: "question", openedAt: event.at });
        }
        break;
      case "SessionEnd":
        waits.clear();
        closedAt = event.at;
        if (!CONTINUING_REASONS.includes(event.reason ?? "")) endedAt = event.at;
        break;
      default:
        waits.delete(thread);
        if (thread === undefined) closedAt = event.at;
    }
  }
  // The session file speaks for the main thread only.
  let main = waits.get(undefined) ?? null;
  const changed = file.statusUpdatedAt;
  if (
    main &&
    (file.status === "idle" || file.status === "busy") &&
    changed !== null &&
    changed > main.openedAt
  ) {
    main = null;
  }
  if (file.status === "waiting" && changed !== null && (closedAt === null || closedAt <= changed)) {
    const kind = file.waitingFor === "permission" ? "permission" : "question";
    if (!main || changed - main.openedAt > WAIT_JOIN_MS) main = { kind, openedAt: changed };
    else if (main.openedAt - changed <= WAIT_JOIN_MS) {
      main = { kind: main.kind, openedAt: Math.min(main.openedAt, changed) };
    }
  }
  if (main) waits.set(undefined, main);
  else waits.delete(undefined);
  let wait: Wait | null = null;
  for (const candidate of waits.values()) {
    if (!wait || candidate.openedAt > wait.openedAt) wait = candidate;
  }
  const restarted =
    endedAt !== null && file.alive === true && file.startedAt !== null && file.startedAt > endedAt;
  if (file.alive === false || (endedAt !== null && !restarted)) {
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

/**
 * The thread's wait once a hook says one opens: its open one, which the prompt joins, within
 * WAIT_JOIN_MS; past it, the new one, as the open one's close was lost.
 */
function open(waits: Map<Thread, Wait>, thread: Thread, next: Wait): void {
  const current = waits.get(thread);
  waits.set(thread, current && next.openedAt - current.openedAt <= WAIT_JOIN_MS ? current : next);
}

function latest(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  return b === null ? a : Math.max(a, b);
}
