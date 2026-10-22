import { lstatSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { isPrivateDir } from "./files.ts";
import { checkoutOf } from "./git.ts";
import { isInbox, postToInbox } from "./inbox.ts";
import { forLog } from "./journal.ts";
import {
  checkClaudeCode,
  claudeCodeDirsOf,
  type ProcessCheck,
  type ProcessInfo,
} from "./processes.ts";
import {
  INVISIBLE,
  LINE_BREAK,
  MAX_BRANCH_CHARS,
  MAX_EXCERPT_CHARS,
  MAX_INPUT_CHARS,
  MAX_REPOSITORY_CHARS,
  MAX_REQUESTS_BYTES,
  MAX_SESSIONS_BYTES,
  MAX_TITLE_CHARS,
  MAX_VPS_SESSIONS,
  MAX_WAITS_BYTES,
  type RunnerActAnswer,
  type RunnerActRefusal,
  type RunnerVerdict,
  type RunnerVerdictAnswer,
  type RunnerVpsRequest,
  type RunnerVpsRequests,
  type RunnerVpsSession,
  type RunnerVpsSessions,
  type RunnerVpsWait,
  type RunnerVpsWaits,
} from "./protocol.ts";
import { cut, excerptOf, redact } from "./redact.ts";
import { ownUid } from "./secrets.ts";
import { isAlive, readSessionFiles, type SessionFile } from "./session-files.ts";
import {
  deleteExcerpt,
  deleteRequest,
  deleteSocket,
  listActions,
  listExcerpts,
  readEvents,
  readExcerpt,
  readRequest,
  readSocket,
  readVerdict,
  type SpoolEvent,
  type SpoolRequest,
  takeVerdict,
  writeVerdict,
} from "./spool.ts";
import { prLinkOf, transcriptFinder } from "./transcripts.ts";
import { lifeOf, type SessionLife, threadWaits, WAIT_JOIN_MS } from "./waits.ts";

// Every Claude Code session on the VPS but the runner's own (ADR-0057, #433): from the session
// files Claude Code keeps, and the spool the session-event hook writes. Kelpie keeps no copy:
// `channel-egress` asks for them when Master's tool, or the notices, need them. Since ADR-0069 the
// runner also acts on them: a verdict on a permission prompt the permission hook holds open, a
// message to a session's inbox, and a session's end.

/** An excerpt is deleted after this long, if its session hasn't ended first (ADR-0057 §2). */
export const EXCERPT_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** A hook's temporary file older than this was left by a hook that was stopped. */
const TEMPORARY_RETENTION_MS = 60_000;
/** How long a verdict waits for its hook to take it: the hook looks twice a second. */
export const VERDICT_APPLY_MS = 3_000;
/** How often the runner looks whether the hook took it. */
const VERDICT_CHECK_MS = 100;
/** A verdict whose request is gone is removed once this old: its hook won't take it any more. */
const VERDICT_RETENTION_MS = 60_000;
/**
 * A request is left this long past its hook's deadline before it is removed: the hook removes its
 * own when it ends, and leaves one only when it was killed.
 */
const REQUEST_GRACE_MS = 60_000;
/**
 * An inbox address recorded this long before its session's process started still counts: the
 * session file and the hook take their times apart.
 */
const SOCKET_SLACK_MS = 60_000;

/** A one-line field's breaks, each made a space before it leaves. */
const LINE_BREAKS = new RegExp(LINE_BREAK.source, "g");
/** A tool input's runs of line breaks, with the blanks around them, each shown as one "⏎". */
const BREAK_RUNS = /\s*[\n\r\v\f\u2028\u2029][\s\u2028\u2029]*/gu;
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
  /** How a verdict waits between its looks. */
  sleep?: (ms: number) => Promise<void>;
  /** Claude Code's binaries' folders, which a session's process must run from to be ended. */
  claudeCodeDirs?: readonly string[];
  /** A process as `/proc` shows it, or `unsupported` off Linux. */
  processInfo?: (pid: number) => ProcessInfo | null | "unsupported";
  kill?: (pid: number, signal: "SIGTERM") => void;
  post?: (path: string, text: string) => Promise<boolean>;
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

  /**
   * `GET /sessions/requests`: the permission prompts the hook holds open for Kelpie's verdict
   * (ADR-0069 §1), oldest first, within MAX_REQUESTS_BYTES. The tool's input, which the hook
   * redacted, is redacted again, the runner's own secret by value too, then put on one line, each
   * run of blanks one space, and cut: `truncated` says when it isn't all there.
   */
  requests(): RunnerVpsRequests {
    const { now, observed, spool, events } = this.#observe();
    const open = spool ? this.#openRequests(now, observed, events) : [];
    const requests = open.slice(0, MAX_VPS_SESSIONS).map(
      ({ request, file }): RunnerVpsRequest => ({
        id: request.id,
        sessionId: request.session,
        tool: request.tool,
        ...this.#input(request),
        openedAt: request.at,
        title: this.#line(file.name, MAX_TITLE_CHARS),
        repository: this.#line(checkoutOf(file.cwd).repository, MAX_REPOSITORY_CHARS),
      }),
    );
    return withinBytes(
      requests,
      ["title", "repository"],
      (kept, truncated) => ({ ok: true, now, requests: kept, truncated }),
      MAX_REQUESTS_BYTES,
      open.length > MAX_VPS_SESSIONS,
    );
  }

  /**
   * `POST /sessions/requests/:id`: Kelpie's verdict on an open request, which counts once. It
   * answers `applied` once the hook took it, within VERDICT_APPLY_MS; a verdict the hook didn't
   * take by then is taken back, so it can't apply later, unbeknown to Kelpie.
   */
  async verdict(id: string, behavior: RunnerVerdict): Promise<RunnerVerdictAnswer> {
    const closed = { ok: false, reason: "closed" } as const;
    const { now, observed, spool, events } = this.#observe();
    if (!spool) return closed;
    const dir = this.#options.spoolDir;
    const request = readRequest(dir, id);
    const entry = request && observed.find(({ file }) => file.id === request.session);
    if (!request || !entry || !this.#isOpen(request, entry, now, events, this.#requests())) {
      return closed;
    }
    if (!writeVerdict(dir, { id, behavior, at: now })) return closed;
    const clock = this.#options.now ?? Date.now;
    const sleep = this.#options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
    const until = clock() + VERDICT_APPLY_MS;
    while (clock() < until) {
      await sleep(VERDICT_CHECK_MS);
      if (readVerdict(dir, id) === null) return { ok: true, applied: true };
    }
    // Only one of the hook and the runner can take it: when the hook did, it applied.
    return { ok: true, applied: !takeVerdict(dir, id) };
  }

  /**
   * `POST /sessions/:id/message`: posts the text to the session's inbox, as the `SessionStart`
   * hook recorded it for its running process (ADR-0069 §2).
   */
  async message(id: string, text: string): Promise<RunnerActAnswer> {
    const { observed, spool } = this.#observe();
    const found = this.#live(id, observed);
    if ("reason" in found) return refusal(found.reason);
    // The same check as an end's: the pid is still that session's Claude Code process.
    const check = this.#checkProcess(found.file);
    if (check !== "ok") return refusal(check);
    const { spoolDir, uid = ownUid(), post = postToInbox } = this.#options;
    const socket = spool ? readSocket(spoolDir, id) : null;
    const started = found.file.startedAt;
    // An address recorded before the process started is an older process's, whose pid, and so
    // socket, another session may have taken since.
    if (!socket || started === null || socket.at < started - SOCKET_SLACK_MS) {
      return refusal("no_inbox");
    }
    if (!isInbox(socket.path, uid)) return refusal("no_inbox");
    return (await post(socket.path, text)) ? { ok: true } : refusal("no_inbox");
  }

  /**
   * `POST /sessions/:id/end`: sends the session's process SIGTERM, once it checked that the pid is
   * still that session's Claude Code process, one of the runner's user's (ADR-0069 §3). Claude
   * Code then ends the session cleanly, its `SessionEnd` hooks first.
   */
  end(id: string): RunnerActAnswer {
    const { observed } = this.#observe();
    const found = this.#live(id, observed);
    if ("reason" in found) return refusal(found.reason);
    const check = this.#checkProcess(found.file);
    if (check !== "ok") return refusal(check);
    try {
      (this.#options.kill ?? ((pid, signal) => process.kill(pid, signal)))(
        found.file.pid as number,
        "SIGTERM",
      );
    } catch {
      return refusal("ended");
    }
    return { ok: true };
  }

  /** Whether the session file's pid is still its Claude Code process, one of the runner's user's. */
  #checkProcess(file: SessionFile): ProcessCheck {
    const { claudeDir, uid = ownUid() } = this.#options;
    const dirs = this.#options.claudeCodeDirs ?? claudeCodeDirsOf(dirname(claudeDir), claudeDir);
    return checkClaudeCode(file, {
      uid,
      dirs,
      ...(this.#options.processInfo ? { info: this.#options.processInfo } : {}),
    });
  }

  /**
   * A request's input as it leaves: what shows nothing removed, redacted again, on one line, each
   * break shown as "⏎" and each run of blanks one space, then cut to MAX_INPUT_CHARS. `truncated`
   * when the hook or the runner cut or redacted some of it: no one approves what they can't see.
   */
  #input(request: SpoolRequest): { input: string; truncated: boolean } {
    const kept = cut(request.input, MAX_REDACTED_CHARS);
    const visible = kept.replace(INVISIBLES, "");
    const redacted = redact(visible, this.#options.secrets);
    // Each break shows, so the commands a script's lines run don't read as one's arguments.
    const line = redacted
      .replace(BREAK_RUNS, " \u23ce ")
      .replace(LINE_BREAKS, " ")
      .replace(/\s+/gu, " ")
      .trim();
    const truncated =
      !request.whole ||
      kept !== request.input ||
      visible !== kept ||
      redacted !== visible ||
      line.length > MAX_INPUT_CHARS;
    return { input: line === "" ? "{}" : cut(line, MAX_INPUT_CHARS), truncated };
  }

  /** A session of the server's that still runs, by its id; or why not. */
  #live(
    id: string,
    observed: readonly Observed[],
  ): { file: SessionFile } | { reason: RunnerActRefusal } {
    const entry = observed.find(({ file }) => file.id === id);
    if (!entry) return { reason: "not_found" };
    if (entry.life.state === "ended" || entry.file.alive !== true) return { reason: "ended" };
    return { file: entry.file };
  }

  /** Every request in the spool that checks out. */
  #requests(): SpoolRequest[] {
    const dir = this.#options.spoolDir;
    return listActions(dir).requests.flatMap((id) => readRequest(dir, id) ?? []);
  }

  /** The open requests, oldest first, each with its session's file. */
  #openRequests(
    now: number,
    observed: readonly Observed[],
    events: ReadonlyMap<string, SpoolEvent[]>,
  ): { request: SpoolRequest; file: SessionFile }[] {
    const sessions = new Map(observed.map((entry) => [entry.file.id, entry]));
    const requests = this.#requests();
    const open: { request: SpoolRequest; file: SessionFile }[] = [];
    for (const request of requests) {
      const entry = sessions.get(request.session);
      if (entry && this.#isOpen(request, entry, now, events, requests)) {
        open.push({ request, file: entry.file });
      }
    }
    return open.sort(
      (a, b) => a.request.at - b.request.at || (a.request.id < b.request.id ? -1 : 1),
    );
  }

  /**
   * Whether a request is open: its hook still waits, before its deadline; no verdict was given;
   * its session runs; it is its thread's latest; and its thread's wait opened with it and hasn't
   * closed, so an answer in the app closes it, even before its hook sees it.
   */
  #isOpen(
    request: SpoolRequest,
    { file, life }: Observed,
    now: number,
    events: ReadonlyMap<string, SpoolEvent[]>,
    requests: readonly SpoolRequest[],
  ): boolean {
    const alive = this.#options.alive ?? isAlive;
    if (now >= request.deadline || !alive(request.pid) || life.state === "ended") return false;
    if (readVerdict(this.#options.spoolDir, request.id) !== null) return false;
    // A thread asks one prompt at a time: a later request of its own means this one's prompt was
    // answered, though its hook hasn't seen it yet.
    const later = requests.some(
      (other) =>
        other.session === request.session &&
        other.agent === request.agent &&
        (other.at > request.at || (other.at === request.at && other.id > request.id)),
    );
    if (later) return false;
    const wait = threadWaits(file, events.get(file.id) ?? []).waits.get(request.agent);
    return wait !== undefined && Math.abs(wait.openedAt - request.at) <= WAIT_JOIN_MS;
  }

  /** Each session's file and life, and whether the spool may be read; old excerpts go meanwhile. */
  #observe(): {
    now: number;
    observed: Observed[];
    spool: boolean;
    events: Map<string, SpoolEvent[]>;
  } {
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
    return { now, observed, spool, events };
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
   * session file was read, one whose session has no file left; an inbox address the same way. A
   * request whose hook is gone goes, and a verdict whose request is. Leftover temporary files go
   * too.
   */
  #sweep(now: number, observed: readonly Observed[], complete: boolean): void {
    const dir = this.#options.spoolDir;
    const lives = new Map(observed.map(({ file, life }) => [file.id, life]));
    const alive = this.#options.alive ?? isAlive;
    const actions = listActions(dir);
    for (const id of actions.requests) {
      const request = readRequest(dir, id);
      if (request === null || !alive(request.pid) || now >= request.deadline + REQUEST_GRACE_MS) {
        this.#tryRemoving(() => deleteRequest(dir, id));
      }
    }
    for (const id of actions.verdicts) {
      const verdict = readVerdict(dir, id);
      if (
        readRequest(dir, id) === null &&
        (verdict === null || now - verdict.at >= VERDICT_RETENTION_MS)
      ) {
        this.#tryRemoving(() => takeVerdict(dir, id));
      }
    }
    for (const session of actions.sockets) {
      const life = lives.get(session);
      if (life?.state === "ended" || (life === undefined && complete)) {
        this.#tryRemoving(() => deleteSocket(dir, session));
      }
    }
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
            redact(cut(excerpt.text, MAX_REDACTED_CHARS).replace(INVISIBLES, ""), secrets),
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
   * Untrusted text for a one-line field: without what shows nothing, then redacted, each break a
   * space, and cut to `max`; null when nothing is left.
   */
  #line(value: string | null, max: number): string | null {
    if (value === null) return null;
    // What shows nothing goes first: it could split a key, which would then pass, rejoined.
    const visible = cut(value, MAX_REDACTED_CHARS).replace(INVISIBLES, "");
    const line = redact(visible, this.#options.secrets).replace(LINE_BREAKS, " ");
    const text = cut(line, max);
    return text.trim() === "" ? null : text;
  }
}

function refusal(reason: RunnerActRefusal): RunnerActAnswer {
  return { ok: false, reason };
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
