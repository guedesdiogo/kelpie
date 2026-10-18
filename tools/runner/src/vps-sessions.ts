import { lstatSync, realpathSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { isPrivateDir } from "./files.ts";
import { checkoutOf } from "./git.ts";
import { forLog } from "./journal.ts";
import {
  INVISIBLE,
  LINE_BREAK,
  MAX_BRANCH_CHARS,
  MAX_EXCERPT_CHARS,
  MAX_REPOSITORY_CHARS,
  MAX_SESSIONS_BYTES,
  MAX_TITLE_CHARS,
  MAX_VPS_SESSIONS,
  MAX_WAITS_BYTES,
  type RunnerVpsSession,
  type RunnerVpsSessions,
  type RunnerVpsWait,
  type RunnerVpsWaits,
} from "./protocol.ts";
import { cut, excerptOf, redact } from "./redact.ts";
import { ownUid } from "./secrets.ts";
import { readSessionFiles, type SessionFile } from "./session-files.ts";
import { deleteExcerpt, listExcerpts, readEvents, readExcerpt, type SpoolEvent } from "./spool.ts";
import { prLinkOf, transcriptFinder } from "./transcripts.ts";
import { lifeOf, type SessionLife } from "./waits.ts";

// Every Claude Code session on the VPS but the runner's own, read only (ADR-0057, #433): from the
// session files Claude Code keeps, and the spool the session-event hook writes. Kelpie keeps no
// copy: `channel-egress` asks for them when Master's tool, or the notices, need them.

/** An excerpt is deleted after this long, if its session hasn't ended first (ADR-0057 §2). */
export const EXCERPT_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** A hook's temporary file older than this was left by a hook that was stopped. */
const TEMPORARY_RETENTION_MS = 60_000;

/** A one-line field's breaks, each made a space before it leaves. */
const LINE_BREAKS = new RegExp(LINE_BREAK.source, "g");
/** What shows nothing, removed from every text before it leaves. */
const INVISIBLES = new RegExp(INVISIBLE.source, "gu");
/**
 * The most of a field redacted: a session's `name` can take most of its 64 KiB file, and every
 * field leaves far shorter than this, so a secret near its cut is whole when it is redacted.
 */
export const MAX_REDACTED_CHARS = 4_096;

/**
 * The fields `/sessions` drops, in this order, from the least recent session up, before it drops
 * sessions themselves.
 */
export const LIST_DROP_ORDER = ["excerpt", "title", "prUrl", "branch", "repository"] as const;

/** What started a session, by its `entrypoint`: the spike saw `claude-desktop`, and `cli`. */
const STARTED_BY = new Map<string, RunnerVpsSession["startedBy"]>([
  ["claude-desktop", "app"],
  ["cli", "terminal"],
]);

export interface VpsSessionsOptions {
  /** Claude Code's folder, `~/.claude`, which holds `sessions/` and `projects/`. */
  claudeDir: string;
  /** The session-event hook's spool. */
  spoolDir: string;
  /** The runner's own work folder: the sessions there are the `claude-code` route's. */
  workDir: string;
  /** Whether the runner holds the session's id, as one of the `claude-code` route's. */
  holds: (id: string) => boolean;
  /** The runner's secrets, redacted by value from everything that leaves. */
  secrets: readonly string[];
  /** The runner's log. */
  warn: (message: string) => void;
  now?: () => number;
  alive?: (pid: number) => boolean;
  uid?: number;
}

interface Observed {
  file: SessionFile;
  life: SessionLife;
}

/** A folder by its real path, and by its name, for when the real one can't be known. */
interface Place {
  real: string | null;
  lexical: string;
}

export class VpsSessions {
  readonly #options: VpsSessionsOptions;
  // The spool's directory is refused once per run in the log, not on every call; so is a failed
  // deletion.
  #refusedSpool = false;
  #failedSweep = false;

  constructor(options: VpsSessionsOptions) {
    this.#options = options;
  }

  /** `GET /sessions`: every session, the most recent state first, within MAX_SESSIONS_BYTES. */
  list(): RunnerVpsSessions {
    const { now, observed, spool } = this.#observe();
    observed.sort(
      (a, b) => (b.life.since ?? -1) - (a.life.since ?? -1) || (a.file.id < b.file.id ? -1 : 1),
    );
    // The project folders are listed once for all the sessions, if any needs them.
    const transcriptOf = transcriptFinder(this.#options.claudeDir);
    const sessions = observed
      .slice(0, MAX_VPS_SESSIONS)
      .map((entry) => this.#describe(entry, spool, transcriptOf));
    return withinBytes(
      sessions,
      LIST_DROP_ORDER,
      (kept, truncated) => ({ ok: true, now, sessions: kept, truncated }),
      MAX_SESSIONS_BYTES,
      observed.length > MAX_VPS_SESSIONS,
    );
  }

  /**
   * `GET /sessions/waits?since=`: the waits opened at `since` or later and still open, oldest
   * first, within MAX_WAITS_BYTES.
   */
  waits(since: number): RunnerVpsWaits {
    const { now, observed } = this.#observe();
    const open = observed.flatMap(({ file, life }) =>
      life.wait && life.wait.openedAt >= since ? [{ file, wait: life.wait }] : [],
    );
    open.sort((a, b) => a.wait.openedAt - b.wait.openedAt);
    const waits = open.slice(0, MAX_VPS_SESSIONS).map(
      ({ file, wait }): RunnerVpsWait => ({
        sessionId: file.id,
        kind: wait.kind,
        openedAt: wait.openedAt,
        title: this.#line(file.name, MAX_TITLE_CHARS),
        repository: this.#line(checkoutOf(file.cwd).repository, MAX_REPOSITORY_CHARS),
      }),
    );
    return withinBytes(
      waits,
      ["title", "repository"],
      (kept, truncated) => ({ ok: true, now, waits: kept, truncated }),
      MAX_WAITS_BYTES,
      open.length > MAX_VPS_SESSIONS,
    );
  }

  /** Each session's file and life, and whether the spool may be read; old excerpts go meanwhile. */
  #observe(): { now: number; observed: Observed[]; spool: boolean } {
    const { claudeDir, alive } = this.#options;
    const now = (this.#options.now ?? Date.now)();
    const read = readSessionFiles(claudeDir, alive);
    const spool = this.#spoolUsable();
    const events = new Map<string, SpoolEvent[]>();
    for (const event of spool ? readEvents(this.#options.spoolDir) : []) {
      const list = events.get(event.session);
      if (list) list.push(event);
      else events.set(event.session, [event]);
    }
    const work = placeOf(this.#options.workDir);
    const observed = (read?.files ?? [])
      .filter((file) => !this.#isOwn(file, work))
      .map((file) => ({ file, life: lifeOf(file, events.get(file.id) ?? [], now) }));
    if (spool) this.#sweep(now, observed, read?.complete === true);
    return { now, observed, spool };
  }

  /**
   * The `claude-code` route's sessions: in the runner's work folder, or held by their id. A folder
   * is compared by its real path, through any symlink, and by its name, for when it is gone.
   */
  #isOwn(file: SessionFile, work: Place): boolean {
    if (this.#options.holds(file.id)) return true;
    if (file.cwd === null) return false;
    const cwd = placeOf(file.cwd);
    const within = (inner: string | null, outer: string | null) =>
      inner !== null && outer !== null && (inner === outer || inner.startsWith(`${outer}${sep}`));
    return [cwd.real, cwd.lexical].some(
      (inner) => within(inner, work.real) || within(inner, work.lexical),
    );
  }

  /**
   * Whether the spool may be read: missing until the hook first runs, and refused unless it is a
   * directory of the runner's user that no one else may open, since its lines decide the waits.
   */
  #spoolUsable(): boolean {
    const { spoolDir, uid = ownUid(), warn } = this.#options;
    try {
      lstatSync(spoolDir);
    } catch {
      return false;
    }
    if (isPrivateDir(spoolDir, uid)) return true;
    if (!this.#refusedSpool) {
      warn(
        `The session-event spool ${spoolDir} isn't a directory of this user that no one else may open: its events are ignored`,
      );
      this.#refusedSpool = true;
    }
    return false;
  }

  /**
   * Deletes an excerpt older than EXCERPT_RETENTION_MS, an ended session's, and, when every
   * session file was read, one whose session has no file left. Leftover temporary files go too.
   */
  #sweep(now: number, observed: readonly Observed[], complete: boolean): void {
    const dir = this.#options.spoolDir;
    const lives = new Map(observed.map(({ file, life }) => [file.id, life]));
    const { sessions, temporary } = listExcerpts(dir);
    // Each file on its own: one that can't be deleted, as a directory in an excerpt's name or one
    // the runner may not remove, never stops the others, or the answer.
    for (const session of sessions) {
      const excerpt = readExcerpt(dir, session);
      const life = lives.get(session);
      if (
        excerpt === null ||
        now - excerpt.at >= EXCERPT_RETENTION_MS ||
        life?.state === "ended" ||
        (life === undefined && complete)
      ) {
        this.#tryRemoving(() => deleteExcerpt(dir, session));
      }
    }
    for (const name of temporary) {
      const path = join(dir, name);
      this.#tryRemoving(() => {
        if (now - lstatSync(path).mtimeMs >= TEMPORARY_RETENTION_MS) rmSync(path, { force: true });
      });
    }
  }

  #tryRemoving(remove: () => void): void {
    try {
      remove();
    } catch (error) {
      if (this.#failedSweep) return;
      this.#failedSweep = true;
      this.#options.warn(
        `Couldn't delete an excerpt in the spool ${this.#options.spoolDir}: ${forLog(String(error))}`,
      );
    }
  }

  #describe(
    { file, life }: Observed,
    spool: boolean,
    transcriptOf: ReturnType<typeof transcriptFinder>,
  ): RunnerVpsSession {
    const { secrets } = this.#options;
    const checkout = checkoutOf(file.cwd);
    const transcript = transcriptOf(file.id, file.cwd);
    const prUrl = transcript === null ? null : prLinkOf(transcript);
    const excerpt =
      spool && life.state !== "ended" ? readExcerpt(this.#options.spoolDir, file.id) : null;
    const text =
      excerpt === null
        ? ""
        : excerptOf(
            redact(cut(excerpt.text, MAX_REDACTED_CHARS), secrets).replace(INVISIBLES, ""),
            MAX_EXCERPT_CHARS,
          );
    const startedBy = STARTED_BY.get(file.entrypoint ?? "") ?? "unknown";
    return {
      id: file.id,
      state: life.state,
      since: life.since,
      // Only the app archives a session: a terminal's shows only as ended (ADR-0057 §4).
      archivable: life.archivable && startedBy === "app",
      status: file.status,
      statusUpdatedAt: file.statusUpdatedAt,
      startedAt: file.startedAt,
      alive: file.alive,
      startedBy,
      entrypoint: file.entrypoint,
      title: this.#line(file.name, MAX_TITLE_CHARS),
      repository: this.#line(checkout.repository, MAX_REPOSITORY_CHARS),
      branch: this.#line(checkout.branch, MAX_BRANCH_CHARS),
      // An address the redaction would change isn't shown at all.
      prUrl: prUrl !== null && redact(prUrl, secrets) === prUrl ? prUrl : null,
      excerpt: text.trim() === "" ? null : text,
    };
  }

  /**
   * Untrusted text for a one-line field: redacted, each break a space, without what shows nothing,
   * and cut to `max`; null when nothing is left.
   */
  #line(value: string | null, max: number): string | null {
    if (value === null) return null;
    const line = redact(cut(value, MAX_REDACTED_CHARS), this.#options.secrets)
      .replace(LINE_BREAKS, " ")
      .replace(INVISIBLES, "");
    const text = cut(line, max);
    return text.trim() === "" ? null : text;
  }
}

function placeOf(path: string): Place {
  const lexical = resolve(path);
  try {
    return { real: realpathSync(lexical), lexical };
  } catch {
    return { real: null, lexical };
  }
}

/**
 * `wrap(items)`, whose JSON takes at most `maxBytes`: past it, `fields` become null, in their
 * order, from the last item up, then the last items go. `truncated` is true when anything was
 * dropped, here or before (`dropped`).
 */
export function withinBytes<T extends object, A>(
  items: readonly T[],
  fields: readonly (keyof T)[],
  wrap: (items: T[], truncated: boolean) => A,
  maxBytes: number,
  dropped: boolean,
): A {
  const kept = [...items];
  const sizes = kept.map(bytesOf);
  // `false` is the longer, so the bound holds whatever `truncated` says.
  let total =
    bytesOf(wrap([], false)) +
    sizes.reduce((sum, size) => sum + size, 0) +
    Math.max(kept.length - 1, 0);
  let truncated = dropped;
  for (const field of fields) {
    for (let index = kept.length - 1; index >= 0 && total > maxBytes; index -= 1) {
      const item = kept[index] as T;
      if (item[field] === null) continue;
      const lighter = { ...item, [field]: null };
      const size = bytesOf(lighter);
      total -= (sizes[index] as number) - size;
      kept[index] = lighter;
      sizes[index] = size;
      truncated = true;
    }
  }
  while (total > maxBytes && kept.length > 0) {
    total -= (sizes.pop() as number) + (kept.length > 1 ? 1 : 0);
    kept.pop();
    truncated = true;
  }
  return wrap(kept, truncated);
}

function bytesOf(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
