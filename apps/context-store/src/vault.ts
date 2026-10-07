import { DurableObject } from "cloudflare:workers";
import { EMBEDDING_INPUT_CHARS, type EmbedOutcome } from "@kelpie/llm";
import {
  bodyWithoutHeading,
  coreBlock,
  coreCarries,
  DREAM_PAGE_PATH,
  decideWrite,
  dreamPage,
  foldKey,
  instantOf,
  isDate,
  isScope,
  LIFECYCLE_REPORT_PATH,
  lifecycleFindings,
  lifecycleReport,
  MAX_SOURCES,
  MemoryFormatError,
  MemoryIndex,
  type MemoryInput,
  memoryPath,
  mergeInput,
  type Note,
  pack,
  readNote as parseNote,
  placeOf,
  qualifierJudge,
  type RetrieveOptions,
  readPage,
  renderHits,
  rerank,
  retrieve,
  type Scope,
  type SearchHit,
  sanitizeSecrets,
  summaryPath,
  withAbstract,
  writeMemory,
  writtenAt,
} from "@kelpie/memory";
import type { GatewayQualifyOutcome, QualifierBackend, Question } from "@kelpie/qualifier";
import {
  type FileChange,
  GitHubVaultBackend,
  gitBlobSha,
  type VaultBackend,
  type VaultFile,
} from "@kelpie/vault";
import { parseDocument } from "yaml";
import { hasConflictMarkers } from "./conflicts.ts";
import type {
  CompiledContext,
  ForgetResult,
  HeldFile,
  MemoryCoreResult,
  MemoryHit,
  MemorySearchOptions,
  MemorySearchResult,
  MemoryWriteInput,
  ProposalTarget,
  ProposeResult,
  ReadNoteOptions,
  ReadNoteResult,
  RecallOptions,
  RecallResult,
  SetDreamResult,
  SkillEntry,
  WriteNoteOptions,
  WriteNoteResult,
  WriteResult,
} from "./contract.ts";
import { proposeAbstract, proposeMerge, proposeSummary } from "./dream.ts";
import { mergeOwnerWins } from "./merge.ts";
import {
  agentRulesPath,
  isAgentId,
  isSkillFile,
  isSkillName,
  isWritable,
  personaPath,
  skillPath,
} from "./paths.ts";
import { RESOLVE_MAX_CHARS, type ResolveGateway, resolveConflict } from "./resolve.ts";
import { VAULT_README } from "./vault-readme.ts";

/** Set by the owner at deploy, as Worker secrets (ADR-0021, docs/context-store.md). */
export interface VaultSecrets {
  /** The GitHub App's private key, converted to PKCS#8. */
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_WEBHOOK_SECRET?: string;
}

export type VaultEnv = Env & VaultSecrets;

/** The one Vault object: the single writer (ADR-0020 §3). */
export const VAULT_NAME = "vault";

/** Writes wait this long, so the ones made close together share a commit (ADR-0005). */
const FLUSH_DELAY_MS = 5_000;
/** A push syncs this long after its webhook, so a burst of pushes shares one sync. */
const SYNC_DELAY_MS = 1_000;
/** How often the vault checks for pushes a webhook didn't announce: GitHub doesn't redeliver. */
const RECONCILE_MS = 15 * 60_000;
/** A failed GitHub call is retried after a minute, then twice as long each time, up to an hour. */
const RETRY_MS = 60_000;
const MAX_RETRY_MS = 3_600_000;
const MAX_COMMIT_ATTEMPTS = 3;
/** What one `write` may hold: the vault keeps no file over 1 MiB. */
const MAX_CHANGES = 50;
const MAX_FILE_BYTES = 1_048_576;
const MAX_WRITE_BYTES = 2_000_000;
/** What one commit may hold; a longer queue is committed in several. */
const MAX_BATCH_ROWS = 100;
const MAX_BATCH_BYTES = 2_000_000;
/** Memory's recall (#110): the question read, the block's ceiling, the hits fused and reranked. */
const MAX_QUESTION_CHARS = 2_000;
const MAX_RECALL_TOKENS = 8_000;
const RECALL_LIMIT = 10;
/** As ai-memory: the rerank judges 3 × the limit, up to 30, then the limit is kept. */
const RERANK_CANDIDATES = 30;
const MAX_RECALL_SCOPES = 64;
/** The agent's `memory_search` (#126): a few notes, as hermes's `session_search` returns. */
const SEARCH_K = 3;
const MAX_SEARCH_K = 10;
/** A memory the agent writes without a confidence. */
const DEFAULT_CONFIDENCE = 0.8;
/** Two versions of a note that differ only in their frontmatter's `updated`. */
function sameVersion(a: string, b: string): boolean {
  const unstamped = (text: string) => {
    const end = text.startsWith("---\n") ? text.indexOf("\n---\n", 3) : -1;
    return end === -1
      ? text
      : `${text.slice(0, end).replace(/\nupdated: [^\n]*/, "")}${text.slice(end)}`;
  };
  return unstamped(a) === unstamped(b);
}

const words = (text: string) => text.trim().split(/\s+/u).join(" ");
const instant = (value: string | null | undefined) =>
  value === null || value === undefined ? null : instantOf(value);

/** A note that already says this memory: its title, body and validity. */
function saysTheSame(note: Note, memory: MemoryInput): boolean {
  return (
    foldKey(words(note.title)) === foldKey(words(memory.title)) &&
    words(bodyWithoutHeading(note.title, note.body)) === words(memory.body) &&
    instant(note.validFrom) === instant(memory.validFrom) &&
    instant(note.invalidAt) === instant(memory.invalidAt)
  );
}

/** What the writer takes as one line: printable, with no bidirectional overrides. */
function writable(value: string, max: number): boolean {
  return (
    value.trim() !== "" && value.length <= max && !/[\p{Cc}\u202A-\u202E\u2066-\u2069]/u.test(value)
  );
}

/** A new memory's file name is numbered up to this when its title's path is taken. */
const MAX_PATH_NUMBER = 50;
/** The question's vector waits this long, the rerank this long, then recall goes on without them. */
const EMBED_QUESTION_TIMEOUT_MS = 2_000;
const RERANK_TIMEOUT_MS = 3_000;
/** An embedding call in the alarm is given up after this, so the alarm can't hang on it. */
const EMBED_NOTES_TIMEOUT_MS = 40_000;
/** Notes are embedded in the alarm, a few batches a run, so a large vault doesn't hold it up. */
const EMBED_BATCH = 64;
const EMBED_BATCHES_PER_RUN = 4;
const EMBED_AGAIN_MS = 5_000;
/** Each proposal costs three of GitHub's content-creating requests (ADR-0005). */
const MAX_PROPOSALS_PER_HOUR = 10;
const SYSTEM_AGENT = "context-store";
/** The paths held with conflict markers (#114); a resolved one stays listed, for audit, but free. */
const HELD = "SELECT path FROM held WHERE state != 'resolved'";
/** A held file the model couldn't resolve this many times waits for the owner. */
const MAX_RESOLVE_ATTEMPTS = 3;
const RESOLVE_TIMEOUT_MS = 60_000;
/** The wait between two tries at held files, so a short outage can't spend all of a file's. */
const RESOLVE_RETRY_MS = 5 * 60_000;
/** The report lists the owner's notes Kelpie changed this long ago at most (#149). */
const OWNER_CHANGES_MS = 7 * 24 * 60 * 60_000;
/** How often the lifecycle report is written (#111). */
const LIFECYCLE_EVERY_MS = 24 * 60 * 60_000;
/**
 * Dream (#112): a run starts at most this often, once no turn has touched memory for this long, on
 * the notes Kelpie wrote this recently, and makes this many model calls at most, one per wake.
 */
const DREAM_EVERY_MS = 6 * 60 * 60_000;
const DREAM_QUIET_MS = 30 * 60_000;
const DREAM_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
const DREAM_MAX_CALLS = 8;
const DREAM_TIMEOUT_MS = 30_000;
/** While a run is on, the alarm comes back this soon for its next step. */
const DREAM_STEP_MS = 5_000;
/** Ended runs are kept this long, with what they used. */
const DREAM_RUNS_MS = 30 * 24 * 60 * 60_000;
/**
 * A session page is named by its conversation's local date. A date has ended in every time zone
 * 12 hours after it ends in UTC; 2 more leave room for a conversation still going at midnight.
 */
const DREAM_DAY_ENDED_MS = 14 * 60 * 60_000;
/** One day of one conversation Dream may sum up (#112): its summary's path and its pages. */
interface DayCandidate {
  path: string;
  date: string;
  /** The pages' versions, so new pages that day propose it again. */
  key: string;
  pages: { path: string; title: string; body: string }[];
}
/** Duplicates Dream may merge (#112): the survivor first, then the notes it would take in. */
interface MergeCandidate {
  /** The notes' paths, the survivor's first. */
  sources: string[];
  /** Their versions, in the same order. */
  key: string;
  /** Whether they hold the same content, so only the marks would change. */
  same: boolean;
  notes: { path: string; title: string; body: string }[];
}
/** Dream's write of an abstract (#112): the queue's mark, and a headline that names no note. */
const DREAM_SUMMARY = "Write an abstract Dream proposed";
/** Dream's operations, each dry until the owner lets it write (#112). */
const DREAM_OPERATIONS = ["abstracts"] as const;
/** The soonest the alarm wakes for a held file's next try. */
const RESOLVE_WAKE_MS = 1_000;
/** How much of the vault's `AGENTS.md` the model sees with a conflict. */
const RESOLVE_RULES_CHARS = 8_000;
/** The most paths one `forget` names, and the longest path it takes. */
const MAX_FORGET_PATHS = 1_000;
const MAX_PATH_CHARS = 300;
/** The Context Store's own rows that can name a vault path, and so hold a copy of what it was. */
const PATH_TABLES = [
  "queue",
  "conflicts",
  "held",
  "proposals",
  "recall_counts",
  "authored",
  "owner_changes",
  "owner_merges",
  "dream_proposals",
  "dream_writes",
  "dream_summaries",
  "dream_merges",
] as const;
/** A held file's resolution, queued as the owner's text with a conflict settled (#114). */
const RESOLVE_SUMMARY = "Resolve a pushed merge conflict, with the model";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY NOT NULL,
  content TEXT NOT NULL,
  blob_sha TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL,
  path TEXT NOT NULL,
  content TEXT,
  summary TEXT NOT NULL,
  queued_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS conflicts (
  id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL,
  path TEXT NOT NULL,
  content TEXT,
  reason TEXT NOT NULL CHECK (reason IN ('owner_won', 'refused')),
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS proposal_attempts (at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS held (
  path TEXT PRIMARY KEY NOT NULL,
  content TEXT NOT NULL,
  previous TEXT,
  state TEXT NOT NULL CHECK (state IN ('held', 'proposed', 'resolved')),
  attempts INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS recall_counts (
  path TEXT PRIMARY KEY NOT NULL,
  count INTEGER NOT NULL,
  last_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS owner_changes (
  path TEXT NOT NULL,
  at INTEGER NOT NULL,
  removed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS authored (
  path TEXT PRIMARY KEY NOT NULL,
  blob_sha TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS owner_merges (
  path TEXT PRIMARY KEY NOT NULL,
  content TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dream_runs (
  id INTEGER PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  outcome TEXT,
  calls INTEGER NOT NULL DEFAULT 0,
  usage TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS dream_proposals (
  path TEXT PRIMARY KEY NOT NULL,
  blob_sha TEXT NOT NULL,
  abstract TEXT,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dream_summaries (
  path TEXT PRIMARY KEY NOT NULL,
  key TEXT NOT NULL,
  summary TEXT,
  sources TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dream_merges (
  path TEXT PRIMARY KEY NOT NULL,
  key TEXT NOT NULL,
  sources TEXT NOT NULL,
  verdict TEXT CHECK (verdict IN ('same', 'merge', 'distinct')),
  body TEXT,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dream_writes (
  path TEXT PRIMARY KEY NOT NULL,
  blob_sha TEXT NOT NULL,
  abstract TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL,
  path TEXT NOT NULL,
  content_sha TEXT NOT NULL,
  base_blob_sha TEXT,
  branch TEXT NOT NULL,
  pull_request INTEGER NOT NULL,
  url TEXT NOT NULL,
  at INTEGER NOT NULL
);
`;

/**
 * Whether Dream gives a note's current version an abstract (#112): a session page, whose abstract
 * is its first message, or a conclusion without one. A fact the person stated (`explicit`) keeps
 * its own words.
 */
function abstractWanted(version: {
  kind: string;
  abstract: string | null;
  level: string | null;
}): boolean {
  return version.kind === "session" || (version.abstract === null && version.level !== "explicit");
}

const encoder = new TextEncoder();
const bytes = (text: string | null) => (text === null ? 0 : encoder.encode(text).byteLength);

/** What memory asks of llm-gateway: embeddings, and the qualifier for the rerank. */
export interface MemoryGateway extends ResolveGateway {
  embed(texts: string[]): Promise<EmbedOutcome>;
  qualify(
    state: unknown,
    questions: Record<string, Question>,
    backend?: QualifierBackend,
    options?: { timeoutMs?: number },
  ): Promise<GatewayQualifyOutcome>;
}

let gatewayForTesting: MemoryGateway | null | undefined;

/** Tests run in the Worker's isolate and swap llm-gateway with this. Production never calls it. */
export function replaceGatewayForTesting(gateway: MemoryGateway | null | undefined): void {
  gatewayForTesting = gateway;
}

/** Waits for `call` at most `ms`, then answers null; the call isn't cancelled, only ignored. */
async function within<T>(call: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([call.catch(() => null), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

let backendForTesting: VaultBackend | null | undefined;

/** Tests run in the Worker's isolate and swap the backend with this. Production never calls it. */
export function replaceBackendForTesting(backend: VaultBackend | null | undefined): void {
  backendForTesting = backend;
}

/** The GitHub backend, or null while the vault isn't configured. */
function backendFor(env: VaultEnv): VaultBackend | null {
  const { GITHUB_APP_ID, GITHUB_INSTALLATION_ID, VAULT_REPOSITORY, GITHUB_APP_PRIVATE_KEY } = env;
  if (!GITHUB_APP_ID || !GITHUB_INSTALLATION_ID || !VAULT_REPOSITORY || !GITHUB_APP_PRIVATE_KEY) {
    return null;
  }
  return new GitHubVaultBackend({
    appId: GITHUB_APP_ID,
    installationId: GITHUB_INSTALLATION_ID,
    repository: VAULT_REPOSITORY,
    privateKey: GITHUB_APP_PRIVATE_KEY,
    fetch: (input, init) => fetch(input, init),
  });
}

/** An error's name for the logs, never its message: GitHub's and memory's can quote a note (#132). */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown error";
}

interface QueuedRow extends Record<string, SqlStorageValue> {
  id: number;
  agent: string;
  path: string;
  content: string | null;
  summary: string;
}

/**
 * The vault's working copy and its single writer (ADR-0005, ADR-0020 §3). It keeps the files of
 * the synced head in SQLite and queues Kelpie's writes, which reads see at once and an alarm
 * commits in batches. Pushes arrive through the webhook and a periodic reconcile.
 *
 * When a sync brings a change to a file Kelpie has queued:
 * - if the change is one of Kelpie's own queued writes, whose commit landed though GitHub's answer
 *   was lost, the writes up to it are done;
 * - otherwise it is the owner's edit: the owner's version wins and Kelpie's writes are kept as
 *   conflicts. Merging the two is #114's.
 */
export class Vault extends DurableObject<VaultEnv> {
  /** GitHub calls are asynchronous; syncs, flushes and proposals run one at a time. */
  #work: Promise<unknown> = Promise.resolve();
  /** One backend per object, so its installation token is reused until it expires. */
  #cachedBackend: VaultBackend | null | undefined;
  /** Memory's index, derived from the files: it follows every move of `head` (#110). */
  readonly #memory: MemoryIndex;

  constructor(ctx: DurableObjectState, env: VaultEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(SCHEMA);
    this.#memory = new MemoryIndex(ctx.storage);
  }

  #gateway(): MemoryGateway | null {
    if (gatewayForTesting !== undefined) return gatewayForTesting;
    return (this.env.LLM_GATEWAY as unknown as MemoryGateway | undefined) ?? null;
  }

  /** Whether the index holds exactly the files at `head`, and hasn't started over since. */
  #indexedAt(head: string): boolean {
    return (
      this.#get("index_head") === head &&
      this.#memory.lastCommit()?.sha === this.#get("index_commit")
    );
  }

  /**
   * Applies changes to the index as one step toward `head`. Each step gets a fresh id: a head can
   * come back after a rewind, and the index must apply it again rather than skip a known commit.
   */
  async #applyToIndex(head: string, changes: ReadonlyMap<string, string | null>): Promise<void> {
    const seq = Number(this.#get("index_seq") ?? "0") + 1;
    this.#set("index_seq", `${seq}`);
    const id = `${head}#${seq}`;
    await this.#memory.applyCommit({
      sha: id,
      committedAt: Date.now(),
      changes: [...changes].map(([path, content]) => ({ path, content })),
    });
    this.#set("index_head", head);
    this.#set("index_commit", id);
  }

  /**
   * Follows a move of `head` from `previous`: the changes alone when the index was exactly at
   * `previous`, else everything from the working copy, which the move already updated.
   */
  async #index(
    previous: string | null,
    head: string,
    changes: ReadonlyMap<string, string | null>,
  ): Promise<void> {
    if (previous !== null && this.#indexedAt(previous)) await this.#applyToIndex(head, changes);
    else await this.#reindex(head);
  }

  /** The index brought to `head` from the working copy; unchanged notes are skipped. */
  async #reindex(head: string): Promise<void> {
    const changes = new Map<string, string | null>(
      this.#memory.currentPaths().map((path) => [path, null]),
    );
    for (const { path, content } of this.#indexable()) changes.set(path, content);
    await this.#applyToIndex(head, changes);
  }

  /** The working copy as memory indexes it: a held file as it was before its conflict (#114). */
  #indexable(): { path: string; content: string }[] {
    return this.#exec<{ path: string; content: string | null }>(
      `SELECT files.path AS path,
              CASE WHEN held.path IS NULL THEN files.content ELSE held.previous END AS content
       FROM files LEFT JOIN held ON held.path = files.path AND held.content = files.content`,
    ).filter((file): file is { path: string; content: string } => file.content !== null);
  }

  /** Changes as memory indexes them: a held file as it was before its conflict (#114). */
  #indexed(changes: ReadonlyMap<string, string | null>): Map<string, string | null> {
    const held = new Map(
      this.#exec<{ path: string; previous: string | null }>(
        `SELECT held.path AS path, held.previous AS previous FROM held
         JOIN files ON files.path = held.path AND files.content = held.content`,
      ).map((row) => [row.path, row.previous]),
    );
    return new Map(
      [...changes].map(([path, content]) => [
        path,
        held.has(path) ? (held.get(path) ?? null) : content,
      ]),
    );
  }

  /**
   * Brings the index to `head` when it isn't there: after a crash between a move of `head` and its
   * indexing, after a new schema started it over, or when this code first runs on a synced vault.
   */
  async #catchUp(): Promise<void> {
    const head = this.#get("head");
    if (head === null || this.#indexedAt(head)) return;
    await this.#reindex(head);
  }

  #backend(): VaultBackend | null {
    if (backendForTesting !== undefined) return backendForTesting;
    if (this.#cachedBackend === undefined) this.#cachedBackend = backendFor(this.env);
    return this.#cachedBackend;
  }

  #exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): T[] {
    return this.ctx.storage.sql.exec<T>(query, ...bindings).toArray();
  }

  #get(key: string): string | null {
    return (
      this.#exec<{ value: string }>("SELECT value FROM state WHERE key = ?", key)[0]?.value ?? null
    );
  }

  #set(key: string, value: string): void {
    this.#exec("INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)", key, value);
  }

  #serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#work.then(task);
    this.#work = run.catch(() => undefined);
    return run;
  }

  /** A file as Kelpie sees it: its latest queued write, else the synced head's. */
  #visible(path: string): string | null {
    const queued = this.#exec<{ content: string | null }>(
      "SELECT content FROM queue WHERE path = ? ORDER BY id DESC LIMIT 1",
      path,
    )[0];
    if (queued !== undefined) return queued.content;
    // A held file shows its version from before the conflict, never the markers (#114).
    const held = this.#exec<{ previous: string | null }>(
      `SELECT held.previous AS previous FROM held
       JOIN files ON files.path = held.path AND files.content = held.content
       WHERE held.path = ?`,
      path,
    )[0];
    if (held !== undefined) return held.previous;
    return (
      this.#exec<{ content: string }>("SELECT content FROM files WHERE path = ?", path)[0]
        ?.content ?? null
    );
  }

  /** Syncs a vault never synced, and makes sure the reconcile is armed. */
  async #ready(): Promise<void> {
    if (this.#get("head") === null) await this.#serialize(() => this.#sync());
    await this.#alarmBy(Date.now() + RECONCILE_MS);
  }

  async compile(agentId: string): Promise<CompiledContext> {
    const empty: CompiledContext = { persona: null, rules: [], skills: [] };
    if (!isAgentId(agentId) || this.#backend() === null) return empty;
    await this.#ready();
    const rules = ["AGENTS.md", agentRulesPath(agentId)].flatMap((path) => {
      const content = this.#visible(path);
      return content === null ? [] : [{ path, content }];
    });
    const skills = this.#exec<{ path: string }>(
      "SELECT path FROM files WHERE path LIKE '%/SKILL.md' ORDER BY path",
    )
      .filter(({ path }) => isSkillFile(agentId, path))
      .flatMap(({ path }) => {
        // As the agent sees it: a held skill as it was before its conflict.
        const content = this.#visible(path);
        return content === null ? [] : [skillEntry(path, content)];
      });
    return { persona: this.#visible(personaPath(agentId)), rules, skills };
  }

  async read(path: string): Promise<string | null> {
    if (this.#backend() === null) return null;
    await this.#ready();
    return this.#visible(path);
  }

  async write(
    agentId: string,
    changes: { path: string; content: string | null }[],
    summary: string,
  ): Promise<WriteResult> {
    if (this.#backend() === null) return { ok: false, reason: "vault_off" };
    this.#touch();
    const valid =
      isAgentId(agentId) &&
      Array.isArray(changes) &&
      changes.length > 0 &&
      changes.every(
        ({ path, content }) =>
          isWritable(agentId, path) && (content === null || typeof content === "string"),
      );
    if (!valid) return { ok: false, reason: "invalid_path" };
    const sizes = changes.map(({ content }) => bytes(content));
    if (
      changes.length > MAX_CHANGES ||
      sizes.some((size) => size > MAX_FILE_BYTES) ||
      sizes.reduce((sum, size) => sum + size, 0) > MAX_WRITE_BYTES
    ) {
      return { ok: false, reason: "too_large" };
    }
    const now = Date.now();
    const line = oneLine(summary, `Update memory from ${agentId}`);
    this.ctx.storage.transactionSync(() => {
      for (const { path, content } of changes) {
        this.#exec(
          "INSERT INTO queue (agent, path, content, summary, queued_at) VALUES (?, ?, ?, ?, ?)",
          agentId,
          path,
          content,
          line,
          now,
        );
      }
    });
    await this.#alarmBy(now + FLUSH_DELAY_MS);
    return { ok: true };
  }

  async propose(
    agentId: string,
    target: ProposalTarget,
    content: string,
    reason: string,
  ): Promise<ProposeResult> {
    const backend = this.#backend();
    if (backend === null) return { ok: false, reason: "vault_off" };
    const path = proposalPath(agentId, target);
    if (path === null || typeof content !== "string" || bytes(content) > MAX_FILE_BYTES) {
      return { ok: false, reason: "invalid_target" };
    }
    const contentSha = await gitBlobSha(content);
    return this.#serialize(() =>
      this.#propose(backend, agentId, target, path, content, contentSha, reason),
    );
  }

  /** A proposal's branch, commit and pull request. Runs inside `#serialize`. */
  async #propose(
    backend: VaultBackend,
    agentId: string,
    target: ProposalTarget,
    path: string,
    content: string,
    contentSha: string,
    reason: string,
  ): Promise<ProposeResult> {
    const earlier = this.#exec<{ url: string }>(
      "SELECT url FROM proposals WHERE agent = ? AND path = ? AND content_sha = ?",
      agentId,
      path,
      contentSha,
    )[0];
    if (earlier) return { ok: true, url: earlier.url };
    // Attempts count, failed ones included: each costs GitHub requests.
    const hourAgo = Date.now() - 3_600_000;
    this.#exec("DELETE FROM proposal_attempts WHERE at <= ?", hourAgo);
    const recent =
      this.#exec<{ n: number }>("SELECT count(*) AS n FROM proposal_attempts")[0]?.n ?? 0;
    if (recent >= MAX_PROPOSALS_PER_HOUR) return { ok: false, reason: "rate_limited" };

    let branch: string | null = null;
    try {
      await this.#sync();
      const head = this.#get("head") ?? "";
      const base = this.#exec<{ content: string; blob_sha: string }>(
        "SELECT content, blob_sha FROM files WHERE path = ?",
        path,
      )[0];
      if (base?.content === content) return { ok: false, reason: "unchanged" };
      this.#exec("INSERT INTO proposal_attempts (at) VALUES (?)", Date.now());
      const what = target.kind === "skill" ? `skill ${target.name}` : target.kind;
      const headline = `Propose ${what} for ${agentId}`;
      // The agent's words go in a code block, so they render as text: no links, images or
      // mentions in the owner's pull request list.
      const why = oneLine(reason, "No reason given.").replaceAll("`", "'");
      branch = `kelpie/${agentId}/${target.kind === "skill" ? target.name : target.kind}-${Date.now().toString(36)}`;
      await backend.createBranch(branch, head);
      const outcome = await backend.commit({
        branch,
        expectedHead: head,
        headline,
        body: `${why}\n\nKelpie-Agent: ${agentId}`,
        writes: [{ path, content }],
        deletions: [],
      });
      if (outcome.kind !== "committed") {
        throw new Error(`the proposal's commit wasn't made (${outcome.kind})`);
      }
      const pull = await backend.openPullRequest({
        branch,
        base: await this.#branch(backend),
        title: headline,
        body: [
          `Proposed by \`${agentId}\` for the owner's approval (ADR-0020 §5).`,
          `It changes \`${path}\`${base ? `, from blob ${base.blob_sha}` : ", a new file"}.`,
          "The agent's reason:",
          `\`\`\`text\n${why}\n\`\`\``,
        ].join("\n\n"),
      });
      this.#exec(
        `INSERT INTO proposals (agent, path, content_sha, base_blob_sha, branch, pull_request, url, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        agentId,
        path,
        contentSha,
        base?.blob_sha ?? null,
        branch,
        pull.number,
        pull.url,
        Date.now(),
      );
      return { ok: true, url: pull.url };
    } catch (error) {
      console.error("Vault: a proposal failed", errorName(error));
      if (branch !== null) {
        await backend.deleteBranch(branch).catch((cleanup: unknown) => {
          console.error("Vault: a failed proposal's branch stayed", errorName(cleanup));
        });
      }
      return { ok: false, reason: "failed" };
    }
  }

  /** The webhook's call: a push reached `ref`. The alarm syncs a moment later, once per burst. */
  async requestSync(ref: string): Promise<void> {
    if (this.#backend() === null) return;
    const branch = this.#get("branch");
    if (branch !== null && ref !== `refs/heads/${branch}`) return;
    await this.#alarmBy(Date.now() + SYNC_DELAY_MS);
  }

  override async alarm(): Promise<void> {
    if (this.#backend() === null) return;
    try {
      await this.#serialize(() => this.#flush());
      await this.#serialize(() => this.#sync());
      this.#set("failures", "0");
      this.#set("retry_at", "0");
    } catch (error) {
      const failures = Number(this.#get("failures") ?? "0") + 1;
      const retryAt = Date.now() + Math.min(RETRY_MS * 2 ** (failures - 1), MAX_RETRY_MS);
      this.#set("failures", `${failures}`);
      this.#set("retry_at", `${retryAt}`);
      console.error("Vault: a GitHub call failed; retrying", { failures, error: errorName(error) });
      // The retry replaces any sooner alarm: while GitHub fails, writes and pushes wait for it.
      await this.ctx.storage.setAlarm(retryAt);
      return;
    }
    // Memory's work comes after GitHub's and fails on its own, so an llm-gateway outage never
    // delays the vault's writes.
    const moreToEmbed = await this.#embedPending();
    await this.#resolveHeld();
    await this.#lifecycle();
    const dreaming = await this.#dream();
    const queued =
      this.#exec<{ n: number }>(`SELECT count(*) AS n FROM queue WHERE path NOT IN (${HELD})`)[0]
        ?.n ?? 0;
    await this.#alarmBy(
      Date.now() + (queued > 0 ? FLUSH_DELAY_MS : moreToEmbed ? EMBED_AGAIN_MS : RECONCILE_MS),
    );
    // A held file the model can still try wakes the alarm when its next try is due.
    if (this.#gateway() !== null && this.#nextHeld() !== undefined) {
      const due = Number(this.#get("resolve_after") ?? "0");
      await this.#alarmBy(Math.max(due, Date.now() + RESOLVE_WAKE_MS));
    }
    if (dreaming) await this.#alarmBy(Date.now() + DREAM_STEP_MS);
  }

  /**
   * One step of Dream (#112), after the vault's other work: one model call per wake, as a held
   * file's resolution, so a run never holds back GitHub's. A run starts at most every
   * DREAM_EVERY_MS, once no turn has touched memory for DREAM_QUIET_MS, and only with a note to work
   * on; memory used since it started ends it before its next step. It only proposes, the dry run
   * the owner decided on: the report shows the plan. Answers whether a run is still on.
   */
  async #dream(): Promise<boolean> {
    try {
      return await this.#dreamStep();
    } catch (error) {
      console.error("Vault: Dream failed", errorName(error));
      return false;
    }
  }

  async #dreamStep(): Promise<boolean> {
    const gateway = this.#gateway();
    if (gateway === null || this.#backend() === null) return false;
    const now = Date.now();
    const off = this.#get("dream_mode") === "off";
    const activeAt = Number(this.#get("active_at") ?? "0");
    let run = this.#exec<{ id: number; started_at: number; calls: number; usage: string }>(
      "SELECT id, started_at, calls, usage FROM dream_runs WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1",
    )[0];
    if (run !== undefined && (off || activeAt > run.started_at)) {
      return this.#endDream(run.id, off ? "off" : "cancelled");
    }
    if (run === undefined) {
      if (off || now < Number(this.#get("dream_after") ?? "0") || now - activeAt < DREAM_QUIET_MS) {
        return false;
      }
    }
    const note = this.#dreamCandidate(now);
    const day = this.#summaryCandidate(now);
    const group = this.#mergeCandidate(now);
    if (run === undefined) {
      if (note === null && day === null && group === null) {
        // Nothing to do: look again after another quiet spell, not on every wake.
        this.#set("dream_after", `${now + DREAM_QUIET_MS}`);
        return false;
      }
      this.#set("dream_after", `${now + DREAM_EVERY_MS}`);
      const id = this.#exec<{ id: number }>(
        "INSERT INTO dream_runs (started_at) VALUES (?) RETURNING id",
        now,
      )[0]?.id;
      run = { id: id ?? 0, started_at: now, calls: 0, usage: "[]" };
    }
    if (run.calls >= DREAM_MAX_CALLS) return this.#endDream(run.id, "done");
    // The operations with work take turns, so one with much to do can't keep the others waiting.
    const turns = [
      ...(note === null ? [] : ["abstract" as const]),
      ...(day === null ? [] : ["day" as const]),
      ...(group === null ? [] : ["merge" as const]),
    ];
    const turn = turns[run.calls % Math.max(turns.length, 1)];
    if (turn === "day" && day !== null) return this.#summarize(gateway, run, day);
    if (turn === "merge" && group !== null) return this.#merge(gateway, run, group);
    if (note === null) return this.#endDream(run.id, "done");
    if (note.abstract !== undefined) {
      // Proposed while dry, and now let write: no model call.
      await this.#writeAbstract(note, note.abstract);
      return true;
    }
    let proposed: Awaited<ReturnType<typeof proposeAbstract>> | null = null;
    try {
      proposed = await proposeAbstract(gateway, note, DREAM_TIMEOUT_MS);
    } catch (error) {
      console.error("Vault: a Dream step failed", errorName(error));
    }
    const used = proposed?.usage ?? [];
    // A model wrote it: secrets go, as they go from what the agent saves.
    const proposedAbstract =
      proposed?.abstract == null ? null : sanitizeSecrets(proposed.abstract).text;
    const usage = [...(JSON.parse(run.usage) as unknown[]), ...used];
    this.ctx.storage.transactionSync(() => {
      // Kept with the version it was made from: a later version is a note to propose for again.
      // A failure is kept as no answer too, so one note can't fail every run; an outage costs it
      // this version's proposal.
      // Turned off during the call: nothing is kept.
      if (this.#get("dream_mode") !== "off") {
        this.#exec(
          "INSERT OR REPLACE INTO dream_proposals (path, blob_sha, abstract, at) VALUES (?, ?, ?, ?)",
          note.path,
          note.blobSha,
          proposedAbstract,
          Date.now(),
        );
      }
      this.#exec(
        "UPDATE dream_runs SET calls = calls + 1, usage = ? WHERE id = ?",
        JSON.stringify(usage),
        run.id,
      );
    });
    if (proposed === null) return this.#endDream(run.id, "failed");
    if (proposedAbstract !== null && this.#dreamWrites().has("abstracts")) {
      await this.#writeAbstract(note, proposedAbstract);
    }
    // Counts only: the note and the abstract are personal data.
    console.log("Vault: Dream step", {
      calls: run.calls + 1,
      proposed: proposedAbstract !== null,
      output: used.reduce((sum, call) => sum + (Number(call.output) || 0), 0),
    });
    return true;
  }

  /** Ends a run; the report shows its plan when the next alarm writes it. */
  #endDream(id: number, outcome: "done" | "cancelled" | "failed" | "off"): false {
    this.#exec(
      "UPDATE dream_runs SET ended_at = ?, outcome = ? WHERE id = ?",
      Date.now(),
      outcome,
      id,
    );
    this.#set("lifecycle_after", "0");
    return false;
  }

  /**
   * The next note Dream may propose an abstract for (#112), newest first: one whose current version
   * Kelpie wrote (#126) within DREAM_LOOKBACK_MS, a session page or a conclusion without an abstract, with
   * no write waiting, not held, and not proposed for already. The owner's notes are never one, nor
   * a version merged into the owner's edit.
   */
  #dreamCandidate(now: number): {
    path: string;
    blobSha: string;
    title: string;
    body: string;
    /** A proposal made while dry, for this version, now to write. */
    abstract?: string;
  } | null {
    // When written, as the report dates notes: a rebuild indexes every note again as new.
    const recent = this.#memory
      .lifecycleNotes()
      .map((note) => ({ ...note, writtenAt: writtenAt(note) }))
      .filter((note) => note.writtenAt >= now - DREAM_LOOKBACK_MS)
      .sort((a, b) => b.writtenAt - a.writtenAt || (a.path < b.path ? -1 : 1));
    const kelpie = this.#byKelpie(recent.map((note) => note.path));
    const waiting = new Set(
      this.#exec<{ path: string }>("SELECT path FROM queue UNION SELECT path FROM held").map(
        (row) => row.path,
      ),
    );
    const proposed = new Map(
      this.#exec<{ path: string; blob_sha: string }>(
        "SELECT path, blob_sha FROM dream_proposals",
      ).map((row) => [row.path, row.blob_sha]),
    );
    // A version Dream wrote is done with.
    const written = new Map(
      this.#exec<{ path: string; blob_sha: string }>("SELECT path, blob_sha FROM dream_writes").map(
        (row) => [row.path, row.blob_sha],
      ),
    );
    // Kelpie's commit, but holding the owner's lines (#160): the owner's word, so not Dream's.
    const merged = new Set(
      this.#exec<{ path: string }>(
        "SELECT f.path FROM files f JOIN owner_merges m ON m.path = f.path AND m.content = f.content",
      ).map((row) => row.path),
    );
    if (this.#dreamWrites().has("abstracts")) {
      // Proposals made while dry, for the version the vault still holds, and no write tried since.
      const pending = this.#exec<{ path: string; blob_sha: string; abstract: string }>(
        `SELECT p.path, p.blob_sha, p.abstract FROM dream_proposals p
         JOIN files f ON f.path = p.path AND f.blob_sha = p.blob_sha
         WHERE p.abstract IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM dream_writes w WHERE w.path = p.path AND w.at >= p.at)
         ORDER BY p.at`,
      );
      for (const row of pending) {
        if (!kelpie.has(row.path) || waiting.has(row.path) || merged.has(row.path)) continue;
        const version = this.#memory.current(row.path);
        if (version === null || !abstractWanted(version)) continue;
        return {
          path: row.path,
          blobSha: row.blob_sha,
          title: version.title,
          body: version.body,
          abstract: row.abstract,
        };
      }
    }
    for (const note of recent) {
      if (!kelpie.has(note.path) || waiting.has(note.path) || merged.has(note.path)) continue;
      if (proposed.get(note.path) === note.blobSha || written.get(note.path) === note.blobSha) {
        continue;
      }
      const version = this.#memory.current(note.path);
      if (version === null || !abstractWanted(version)) continue;
      return { path: note.path, blobSha: note.blobSha, title: version.title, body: version.body };
    }
    return null;
  }

  /**
   * Turns Dream off, or back on as dry runs (#112): one setting for the whole vault. Off, what it
   * proposed goes, and the next alarm writes the report again without it.
   */
  setDream(mode: unknown, writes?: unknown): SetDreamResult {
    if (mode !== "off" && mode !== "dry") return { ok: false, reason: "invalid" };
    const known = new Set<string>(DREAM_OPERATIONS);
    if (
      writes !== undefined &&
      !(Array.isArray(writes) && writes.every((name) => known.has(name as string)))
    ) {
      return { ok: false, reason: "invalid" };
    }
    // Off forgets which operations may write: turned back on, each is dry until said again.
    const allowed =
      mode === "off"
        ? []
        : writes === undefined
          ? [...this.#dreamWrites()]
          : DREAM_OPERATIONS.filter((name) => (writes as unknown[]).includes(name));
    this.ctx.storage.transactionSync(() => {
      this.#set("dream_mode", mode);
      this.#set("dream_writes", JSON.stringify(allowed));
      if (mode === "off") {
        this.#exec("DELETE FROM dream_proposals");
        this.#exec("DELETE FROM dream_summaries");
        this.#exec("DELETE FROM dream_merges");
        // Dream's page waiting in the queue, or set aside, holds the summaries too.
        this.#exec("DELETE FROM queue WHERE path = ?", DREAM_PAGE_PATH);
        this.#exec("DELETE FROM conflicts WHERE path = ?", DREAM_PAGE_PATH);
        this.#set("lifecycle_after", "0");
      }
    });
    return { ok: true, mode, writes: allowed };
  }

  /**
   * The next day Dream may sum up (#112), newest first: the session pages of one scope's day, ended
   * and within DREAM_LOOKBACK_MS, whose summary the vault doesn't show yet, and not proposed for
   * these pages' versions already. One conversation's day at a time, so two are never mixed (#131).
   */
  #summaryCandidate(now: number): DayCandidate | null {
    // A date before this one has ended in every time zone.
    const ended = new Date(now - DREAM_DAY_ENDED_MS).toISOString().slice(0, 10);
    const oldest = new Date(now - DREAM_LOOKBACK_MS).toISOString().slice(0, 10);
    const days = new Map<string, { date: string; pages: { path: string; blobSha: string }[] }>();
    for (const note of this.#memory.lifecycleNotes()) {
      // A conversation's own scope: where its session pages go, one conversation each (#131).
      if (note.kind !== "session" || !note.scope.startsWith("conversation/")) continue;
      if (!isScope(note.scope)) continue;
      // A session page's date leads its name; a day summary's name is the date alone.
      const date = /\/sessions\/\d{4}\/(\d{4}-\d{2}-\d{2})-[^/]+\.md$/.exec(note.path)?.[1];
      if (date === undefined || !isDate(date) || date >= ended || date < oldest) continue;
      const path = summaryPath(note.scope, date);
      const day = days.get(path) ?? { date, pages: [] };
      day.pages.push({ path: note.path, blobSha: note.blobSha });
      days.set(path, day);
    }
    const proposed = new Map(
      this.#exec<{ path: string; key: string }>("SELECT path, key FROM dream_summaries").map(
        (row) => [row.path, row.key],
      ),
    );
    const newest = [...days].sort(([a, x], [b, y]) =>
      x.date === y.date ? (a < b ? -1 : 1) : x.date < y.date ? 1 : -1,
    );
    for (const [path, day] of newest) {
      if (this.#visible(path) !== null) continue;
      const children = day.pages
        .sort((a, b) => (a.path < b.path ? -1 : 1))
        .flatMap((page) => {
          const version = this.#memory.current(page.path);
          return version === null
            ? []
            : [
                {
                  path: page.path,
                  blobSha: page.blobSha,
                  title: version.title,
                  body: version.body,
                },
              ];
        });
      const key = children.map((page) => page.blobSha).join(",");
      if (children.length === 0 || proposed.get(path) === key) continue;
      // The index can hold another version than the vault, as for a page held on conflict
      // markers: a day whose summary couldn't be kept isn't asked for.
      const sources = children.map((page) => page.path);
      if (!this.#asRead(sources, key)) continue;
      return {
        path,
        date: day.date,
        key,
        pages: children.map(({ path, title, body }) => ({ path, title, body })),
      };
    }
    return null;
  }

  /** Whether these notes are all in the vault, at the versions Dream read (#112). */
  #asRead(sources: readonly string[], key: string): boolean {
    const blobs = key.split(",");
    return (
      sources.length === blobs.length &&
      sources.every(
        (path, i) =>
          this.#exec("SELECT 1 FROM files WHERE path = ? AND blob_sha = ?", path, blobs[i] ?? "")
            .length > 0,
      )
    );
  }

  /**
   * One summary step (#112): one call for one day of one conversation, kept with the versions of
   * the pages it read. Like an abstract, it runs dry: the summary goes to Dream's page, not the vault.
   */
  async #summarize(
    gateway: MemoryGateway,
    run: { id: number; calls: number; usage: string },
    day: DayCandidate,
  ): Promise<boolean> {
    let proposed: Awaited<ReturnType<typeof proposeSummary>> | null = null;
    try {
      proposed = await proposeSummary(gateway, day, DREAM_TIMEOUT_MS);
    } catch (error) {
      console.error("Vault: a Dream step failed", errorName(error));
    }
    const used = proposed?.usage ?? [];
    const summary = proposed?.summary ?? null;
    const usage = [...(JSON.parse(run.usage) as unknown[]), ...used];
    const sources = day.pages.map((page) => page.path);
    this.ctx.storage.transactionSync(() => {
      // A failure is kept as no answer too, so one day can't fail every run. A page forgotten or
      // changed during the call leaves nothing behind: the summary read what's gone.
      if (this.#get("dream_mode") !== "off" && this.#asRead(sources, day.key)) {
        this.#exec(
          "INSERT OR REPLACE INTO dream_summaries (path, key, summary, sources, at) VALUES (?, ?, ?, ?, ?)",
          day.path,
          day.key,
          summary,
          JSON.stringify(sources),
          Date.now(),
        );
      }
      this.#exec(
        "UPDATE dream_runs SET calls = calls + 1, usage = ? WHERE id = ?",
        JSON.stringify(usage),
        run.id,
      );
    });
    if (proposed === null) return this.#endDream(run.id, "failed");
    // Counts only: the pages and the summary are personal data.
    console.log("Vault: Dream step", {
      calls: run.calls + 1,
      summarized: summary !== null,
      output: used.reduce((sum, call) => sum + (Number(call.output) || 0), 0),
    });
    return true;
  }

  /**
   * The next duplicates Dream may merge (#112), newest group first: Kelpie's own notes of one scope
   * and kind that share a title, two or more, as the vault holds them, and not proposed for these
   * versions already. A note is one only as for an abstract: Kelpie wrote its version, and it isn't
   * a fact the person stated, merged into the owner's edit, waiting or held. Nor is it pinned,
   * carried by the core, dated (a session or an event: the same title another day is no
   * duplicate) or expired. The owner's notes in a group stay out, and on the report's list. A group
   * that doesn't fit the model whole isn't merged: a cut would lose what it held.
   */
  #mergeCandidate(now: number): MergeCandidate | null {
    const notes = this.#memory
      .lifecycleNotes()
      .filter(
        (note) =>
          note.kind !== "session" &&
          note.kind !== "event" &&
          !note.pinned &&
          (note.invalidAt === null || note.invalidAt > now) &&
          !coreCarries(note, note.scope.startsWith("agent/") ? note.scope.slice(6) : ""),
      );
    const kelpie = this.#byKelpie(notes.map((note) => note.path));
    const waiting = new Set(
      this.#exec<{ path: string }>("SELECT path FROM queue UNION SELECT path FROM held").map(
        (row) => row.path,
      ),
    );
    const merged = new Set(
      this.#exec<{ path: string }>(
        "SELECT f.path FROM files f JOIN owner_merges m ON m.path = f.path AND m.content = f.content",
      ).map((row) => row.path),
    );
    const groups = new Map<string, typeof notes>();
    for (const note of notes) {
      if (!kelpie.has(note.path) || waiting.has(note.path) || merged.has(note.path)) continue;
      const group = `${note.scope}\n${note.kind}\n${note.titleKey}`;
      groups.set(group, [...(groups.get(group) ?? []), note]);
    }
    const proposed = new Map(
      this.#exec<{ path: string; key: string }>("SELECT path, key FROM dream_merges").map((row) => [
        row.path,
        row.key,
      ]),
    );
    const candidates = [...groups.values()].flatMap((group) => {
      const members = group.flatMap((note) => {
        const version = this.#memory.current(note.path);
        return version === null || version.level === "explicit"
          ? []
          : [
              {
                ...note,
                version,
                written: writtenAt(note),
                linked: this.#memory.backlinks(note.path).length,
              },
            ];
      });
      if (members.length < 2) return [];
      // The survivor is the note most others link to, then the earliest, then the shorter path,
      // since a later one is numbered: most links already lead to it.
      members.sort(
        (a, b) =>
          b.linked - a.linked ||
          a.written - b.written ||
          a.path.length - b.path.length ||
          (a.path < b.path ? -1 : 1),
      );
      return [{ members, newest: Math.max(...members.map((member) => member.written)) }];
    });
    candidates.sort(
      (a, b) =>
        b.newest - a.newest || ((a.members[0]?.path ?? "") < (b.members[0]?.path ?? "") ? -1 : 1),
    );
    for (const { members } of candidates) {
      const sources = members.map((member) => member.path);
      const key = members.map((member) => member.blobSha).join(",");
      if (proposed.get(sources[0] ?? "") === key || !this.#asRead(sources, key)) continue;
      const same = members.every((member) => member.blobSha === members[0]?.blobSha);
      const shown = members.map((member) => ({
        path: member.path,
        title: member.version.title,
        body: member.version.body,
      }));
      if (!same && mergeInput(shown) === null) continue;
      return { sources, key, same, notes: shown };
    }
    return null;
  }

  /**
   * One merge step (#112). The same content needs no model; otherwise one call says whether the
   * notes are one and how they read merged. Kept with the versions it read, it runs dry: the plan
   * goes to Dream's page, not the vault.
   */
  async #merge(
    gateway: MemoryGateway,
    run: { id: number; calls: number; usage: string },
    group: MergeCandidate,
  ): Promise<boolean> {
    let proposed: Awaited<ReturnType<typeof proposeMerge>> | null = null;
    if (!group.same) {
      try {
        proposed = await proposeMerge(gateway, group.notes, DREAM_TIMEOUT_MS);
      } catch (error) {
        console.error("Vault: a Dream step failed", errorName(error));
      }
    }
    const used = proposed?.usage ?? [];
    const verdict = group.same ? "same" : (proposed?.answer?.verdict ?? null);
    const body = proposed?.answer?.verdict === "merge" ? proposed.answer.body : null;
    const usage = [...(JSON.parse(run.usage) as unknown[]), ...used];
    this.ctx.storage.transactionSync(() => {
      // As for a summary: a failure is kept as no answer, so one group can't fail every run, and
      // nothing is kept once a note changed or Dream was turned off during the call.
      if (this.#get("dream_mode") !== "off" && this.#asRead(group.sources, group.key)) {
        // A group that grew or shrank replaces what was proposed for its notes.
        this.#exec(
          `DELETE FROM dream_merges WHERE EXISTS (SELECT 1
             FROM json_each(dream_merges.sources) AS old, json_each(?) AS fresh
             WHERE old.value = fresh.value)`,
          JSON.stringify(group.sources),
        );
        this.#exec(
          "INSERT INTO dream_merges (path, key, sources, verdict, body, at) VALUES (?, ?, ?, ?, ?, ?)",
          group.sources[0] ?? "",
          group.key,
          JSON.stringify(group.sources),
          verdict,
          body,
          Date.now(),
        );
      }
      if (!group.same) {
        this.#exec(
          "UPDATE dream_runs SET calls = calls + 1, usage = ? WHERE id = ?",
          JSON.stringify(usage),
          run.id,
        );
      }
    });
    if (!group.same && proposed === null) return this.#endDream(run.id, "failed");
    // Counts only: the notes and the body are personal data.
    console.log("Vault: Dream step", {
      calls: run.calls + (group.same ? 0 : 1),
      merge: verdict,
      output: used.reduce((sum, call) => sum + (Number(call.output) || 0), 0),
    });
    return true;
  }

  /** The operations the owner lets Dream write with (#112); the others only propose. */
  #dreamWrites(): Set<string> {
    try {
      const stored = JSON.parse(this.#get("dream_writes") ?? "[]") as unknown;
      return new Set(
        Array.isArray(stored) ? stored.filter((name) => typeof name === "string") : [],
      );
    } catch {
      return new Set();
    }
  }

  /**
   * Writes the abstract Dream proposed for a note (#112), through the queue as the report is
   * written, so it doesn't count as memory activity. Only the frontmatter's `abstract` changes, and
   * only while the note is as it was proposed for: its version, Kelpie's, not merged into the
   * owner's edit, not held, with no write waiting. The version it writes isn't proposed for again.
   */
  async #writeAbstract(note: { path: string; blobSha: string }, abstract: string): Promise<void> {
    const content = this.#exec<{ content: string }>(
      "SELECT content FROM files WHERE path = ? AND blob_sha = ?",
      note.path,
      note.blobSha,
    )[0]?.content;
    const next = content === undefined ? null : withAbstract(content, abstract);
    if (content !== undefined && (next === null || next === content)) {
      // Nothing to write: the note already says it, or its frontmatter can't be read.
      this.#exec(
        "UPDATE dream_proposals SET abstract = NULL WHERE path = ? AND blob_sha = ?",
        note.path,
        note.blobSha,
      );
      return;
    }
    if (next === null) return;
    const blobSha = await gitBlobSha(next);
    this.ctx.storage.transactionSync(() => {
      const unchanged =
        this.#exec(
          `SELECT 1 FROM files f JOIN authored a ON a.path = f.path AND a.blob_sha = f.blob_sha
           WHERE f.path = ? AND f.blob_sha = ?
             AND NOT EXISTS (SELECT 1 FROM owner_merges m WHERE m.path = f.path AND m.content = f.content)
             AND NOT EXISTS (SELECT 1 FROM held h WHERE h.path = f.path AND h.state != 'resolved')
             AND NOT EXISTS (SELECT 1 FROM queue q WHERE q.path = f.path)`,
          note.path,
          note.blobSha,
        ).length > 0;
      if (!unchanged) return;
      const now = Date.now();
      this.#exec(
        "INSERT INTO queue (agent, path, content, summary, queued_at) VALUES (?, ?, ?, ?, ?)",
        SYSTEM_AGENT,
        note.path,
        next,
        // The headline outlives a forget in git, so it never names the note.
        DREAM_SUMMARY,
        now,
      );
      this.#exec(
        "INSERT OR REPLACE INTO dream_writes (path, blob_sha, abstract, at) VALUES (?, ?, ?, ?)",
        note.path,
        blobSha,
        abstract,
        now,
      );
    });
  }

  /** A turn touched memory: Dream waits for quiet, and a run in progress stops (#112). */
  #touch(): void {
    this.#set("active_at", `${Date.now()}`);
  }

  /**
   * Resolves one held file a run with the model (#114), after GitHub's work and apart from its
   * backoff. Until per-item approval exists (#113):
   * - a note an agent may write is written, as the owner's clean edit would be, so queued writes
   *   merge on top of it;
   * - a persona, rules or an agent's skill becomes a pull request, and stays held until it merges;
   * - any other file stays held for the owner.
   *
   * A failure, or an answer that doesn't pass the check, counts as a try. After MAX_RESOLVE_ATTEMPTS
   * the file waits for the owner, listed by `held()`.
   */
  async #resolveHeld(): Promise<void> {
    const gateway = this.#gateway();
    const backend = this.#backend();
    if (gateway === null || backend === null) return;
    if (Date.now() < Number(this.#get("resolve_after") ?? "0")) return;
    const row = this.#nextHeld();
    const route = row === undefined ? null : resolution(row.path);
    if (row === undefined || route === null) return;
    // Tries are spaced, whatever wakes the alarm meanwhile, so a short outage can't spend them.
    this.#set("resolve_after", `${Date.now() + RESOLVE_RETRY_MS}`);
    this.#exec("UPDATE held SET attempts = attempts + 1 WHERE path = ?", row.path);
    const rules = (this.#visible("AGENTS.md") ?? "").slice(0, RESOLVE_RULES_CHARS);
    let resolved: string | null;
    try {
      resolved = await resolveConflict(
        gateway,
        {
          path: row.path,
          marked: row.content,
          // A previous version too large to send is left out; the conflict's sides remain.
          previous:
            row.previous !== null && row.previous.length <= RESOLVE_MAX_CHARS ? row.previous : null,
          rules: rules === "" ? VAULT_README : `${VAULT_README}\n\n${rules}`,
        },
        RESOLVE_TIMEOUT_MS,
      );
    } catch (error) {
      console.warn("Vault: resolving a conflict failed", errorName(error));
      return;
    }
    if (resolved === null) {
      console.warn("Vault: a conflict's resolution failed its check");
      return;
    }
    const content = resolved;
    const contentSha = await gitBlobSha(content);
    try {
      await this.#serialize(async () => {
        // The owner may have fixed the file while the model answered: check after a sync.
        await this.#sync();
        const still = () =>
          this.#exec(
            "SELECT 1 AS one FROM held WHERE path = ? AND state = 'held' AND content = ?",
            row.path,
            row.content,
          ).length > 0;
        if (!still()) return;
        if (route.kind === "propose") {
          const proposed = await this.#propose(
            backend,
            route.agentId,
            route.target,
            row.path,
            content,
            contentSha,
            "Kelpie's model resolved a merge conflict that was pushed unresolved. Check it before merging.",
          );
          if (proposed.ok) {
            this.#exec(
              "UPDATE held SET state = 'proposed' WHERE path = ? AND content = ?",
              row.path,
              row.content,
            );
          }
          return;
        }
        this.ctx.storage.transactionSync(() => {
          this.#settleQueued(row.path, content, row.previous);
          if (this.#exec("SELECT 1 AS one FROM queue WHERE path = ?", row.path).length === 0) {
            this.#exec(
              "INSERT INTO queue (agent, path, content, summary, queued_at) VALUES (?, ?, ?, ?, ?)",
              route.agentId,
              row.path,
              content,
              RESOLVE_SUMMARY,
              Date.now(),
            );
          }
          this.#exec(
            "UPDATE held SET state = 'resolved' WHERE path = ? AND content = ?",
            row.path,
            row.content,
          );
        });
      });
    } catch (error) {
      // GitHub failed during the sync or the proposal; the next alarm's sync retries with backoff.
      console.warn("Vault: applying a conflict's resolution failed", errorName(error));
    }
  }

  /**
   * Forgets erased content (#114), once the owner rewrote the vault's history: it syncs to the
   * rewritten head, rebuilds memory's index from the working copy alone, which drops every old
   * version and the vectors of content no version holds, and deletes the rows that name `paths`.
   * A path ending in `/` names a folder. It answers which named files the vault still has. Git is
   * never touched.
   */
  async forget(paths: unknown): Promise<ForgetResult> {
    if (this.#backend() === null) return { ok: false, reason: "vault_off" };
    const valid =
      Array.isArray(paths) &&
      paths.length > 0 &&
      paths.length <= MAX_FORGET_PATHS &&
      paths.every(
        (path) => typeof path === "string" && path.length > 0 && path.length <= MAX_PATH_CHARS,
      );
    if (!valid) return { ok: false, reason: "invalid_input" };
    const named = JSON.stringify(paths);
    // A path, or a folder's whole content when it ends in `/`. The table's column is named in full:
    // json_each has a `path` column of its own.
    const matches = (table: string) => `EXISTS (SELECT 1 FROM json_each(?) AS named
      WHERE ${table}.path = named.value
        OR (substr(named.value, -1) = '/' AND substr(${table}.path, 1, length(named.value)) = named.value))`;
    return this.#serialize(async (): Promise<ForgetResult> => {
      try {
        await this.#sync();
      } catch (error) {
        console.error("Vault: forgetting couldn't sync", errorName(error));
        return { ok: false, reason: "unavailable" };
      }
      const forgotten = this.ctx.storage.transactionSync(() => {
        let rows = 0;
        for (const table of PATH_TABLES) {
          // A file the vault still holds with markers keeps its hold, or reads would show them.
          const keep =
            table === "held"
              ? " AND NOT EXISTS (SELECT 1 FROM files WHERE files.path = held.path AND files.content = held.content)"
              : "";
          const where = `FROM ${table} WHERE ${matches(table)}${keep}`;
          rows += this.#exec<{ n: number }>(`SELECT count(*) AS n ${where}`, named)[0]?.n ?? 0;
          this.#exec(`DELETE ${where}`, named);
        }
        // A day summary sums up its pages, and a merge reads its notes: forgetting one of them
        // forgets it (#112).
        for (const table of ["dream_summaries", "dream_merges"]) {
          const derived = `FROM ${table} WHERE EXISTS (SELECT 1
            FROM json_each(${table}.sources) AS child, json_each(?) AS named
            WHERE child.value = named.value OR (substr(named.value, -1) = '/'
              AND substr(child.value, 1, length(named.value)) = named.value))`;
          rows += this.#exec<{ n: number }>(`SELECT count(*) AS n ${derived}`, named)[0]?.n ?? 0;
          this.#exec(`DELETE ${derived}`, named);
        }
        // A memory report or Dream's page waiting in the queue, or set aside, may name what is
        // being erased: they go, and the next alarm writes them again from what is left.
        for (const page of [LIFECYCLE_REPORT_PATH, DREAM_PAGE_PATH]) {
          this.#exec("DELETE FROM queue WHERE path = ?", page);
          this.#exec("DELETE FROM conflicts WHERE path = ?", page);
        }
        this.#set("lifecycle_after", "0");
        return rows;
      });
      const stillInVault = this.#exec<{ path: string }>(
        `SELECT path FROM files WHERE ${matches("files")} ORDER BY path`,
        named,
      ).map((row) => row.path);
      const head = this.#get("head") ?? "";
      const files = this.#indexable();
      const seq = Number(this.#get("index_seq") ?? "0") + 1;
      this.#set("index_seq", `${seq}`);
      const id = `${head}#${seq}`;
      await this.#memory.rebuild([{ sha: id, committedAt: Date.now(), changes: files }]);
      this.#set("index_head", head);
      this.#set("index_commit", id);
      // The paths may name people, so the log holds only counts.
      console.log("Vault: forgot erased content", {
        paths: paths.length,
        rows: forgotten,
        stillInVault: stillInVault.length,
      });
      return { ok: true, forgotten, stillInVault };
    });
  }

  /**
   * Once a day, after GitHub's work: what memory's index finds (#111), written as one report page
   * in the vault, or the page removed when memory is clean. A day without news changes nothing,
   * since the page is queued only when it differs. It reads the index at the head: if it can't bring
   * it there, it tries again at the next alarm. Any other failure waits for the next day.
   */
  async #lifecycle(): Promise<void> {
    const now = Date.now();
    if (now < Number(this.#get("lifecycle_after") ?? "0")) return;
    try {
      await this.#catchUp();
    } catch (error) {
      console.error("Vault: the memory report waits for the index", errorName(error));
      return;
    }
    this.#set("lifecycle_after", `${now + LIFECYCLE_EVERY_MS}`);
    try {
      const uses = new Map(
        this.#exec<{ path: string; count: number; last_at: number }>(
          "SELECT path, count, last_at FROM recall_counts",
        ).map((row) => [row.path, { count: row.count, lastAt: row.last_at }]),
      );
      const model = this.#get("embedding_model");
      // The owner's notes Kelpie changed in the last week; older records go.
      this.#exec("DELETE FROM owner_changes WHERE at < ?", now - OWNER_CHANGES_MS);
      // A merge's mark, and the note text it keeps, go with its version, unless it waits to commit.
      this.#exec(
        `DELETE FROM owner_merges WHERE path NOT IN (SELECT path FROM queue) AND NOT EXISTS
           (SELECT 1 FROM files f WHERE f.path = owner_merges.path AND f.content = owner_merges.content)`,
      );
      const changed = this.#exec<{ path: string; at: number; removed: number }>(
        "SELECT path, at, removed FROM owner_changes ORDER BY path, at",
      ).map((row) => ({ path: row.path, at: row.at, removed: row.removed === 1 }));
      // Dream's proposals for versions the vault no longer holds go, and runs past their keep.
      this.#exec(
        `DELETE FROM dream_proposals WHERE path NOT IN (SELECT path FROM queue) AND NOT EXISTS
           (SELECT 1 FROM files f
            WHERE f.path = dream_proposals.path AND f.blob_sha = dream_proposals.blob_sha)`,
      );
      this.#exec(
        `DELETE FROM dream_writes WHERE at < ? OR (path NOT IN (SELECT path FROM queue) AND NOT EXISTS
           (SELECT 1 FROM files f WHERE f.path = dream_writes.path AND f.blob_sha = dream_writes.blob_sha))`,
        now - DREAM_LOOKBACK_MS,
      );
      this.#exec(
        "DELETE FROM dream_runs WHERE ended_at IS NOT NULL AND ended_at < ?",
        now - DREAM_RUNS_MS,
      );
      const dream =
        this.#get("dream_mode") === "off"
          ? []
          : [
              ...this.#exec<{ path: string; abstract: string }>(
                `SELECT p.path, p.abstract FROM dream_proposals p
                 JOIN files f ON f.path = p.path AND f.blob_sha = p.blob_sha
                 WHERE p.abstract IS NOT NULL AND p.path NOT IN (SELECT path FROM queue)
                 ORDER BY p.path`,
              ),
              // What it wrote in the last week, while the vault still holds that version.
              ...this.#exec<{ path: string; abstract: string }>(
                `SELECT w.path, w.abstract FROM dream_writes w
                 JOIN files f ON f.path = w.path AND f.blob_sha = w.blob_sha ORDER BY w.path`,
              ).map((row) => ({ ...row, written: true })),
            ];
      try {
        // Dream's plan while dry (#112): its own page, as what it proposes spans lines. A summary
        // the vault now holds, or one long past, goes; so does whatever read a note that changed.
        this.#exec(
          `DELETE FROM dream_summaries WHERE at < ?
             OR EXISTS (SELECT 1 FROM files f WHERE f.path = dream_summaries.path)`,
          now - 2 * DREAM_LOOKBACK_MS,
        );
        for (const row of this.#exec<{ path: string; key: string; sources: string }>(
          "SELECT path, key, sources FROM dream_summaries",
        )) {
          if (!this.#asRead(JSON.parse(row.sources) as string[], row.key)) {
            this.#exec("DELETE FROM dream_summaries WHERE path = ?", row.path);
          }
        }
        for (const row of this.#exec<{ path: string; key: string; sources: string }>(
          "SELECT path, key, sources FROM dream_merges",
        )) {
          if (!this.#asRead(JSON.parse(row.sources) as string[], row.key)) {
            this.#exec("DELETE FROM dream_merges WHERE path = ?", row.path);
          }
        }
        const titled = (path: string) => ({
          path,
          title: this.#memory.current(path)?.title ?? path,
        });
        const page =
          this.#get("dream_mode") === "off"
            ? null
            : dreamPage({
                summaries: this.#exec<{ path: string; summary: string; sources: string }>(
                  "SELECT path, summary, sources FROM dream_summaries WHERE summary IS NOT NULL",
                ).map((row) => ({
                  date: row.path.slice(row.path.lastIndexOf("/") + 1, -".md".length),
                  scope: placeOf(row.path)?.scope ?? "",
                  sources: (JSON.parse(row.sources) as string[]).map(titled),
                  summary: row.summary,
                })),
                // A distinct verdict, or no answer, proposes nothing.
                merges: this.#exec<{ sources: string; verdict: string; body: string | null }>(
                  `SELECT sources, verdict, body FROM dream_merges
                   WHERE verdict = 'same' OR (verdict = 'merge' AND body IS NOT NULL)`,
                ).map((row) => {
                  const [survivor = "", ...merged] = JSON.parse(row.sources) as string[];
                  return {
                    survivor: titled(survivor),
                    merged: merged.map(titled),
                    body: row.verdict === "same" ? null : row.body,
                  };
                }),
              });
        if (page !== this.#visible(DREAM_PAGE_PATH)) {
          this.#exec(
            "INSERT INTO queue (agent, path, content, summary, queued_at) VALUES (?, ?, ?, ?, ?)",
            SYSTEM_AGENT,
            DREAM_PAGE_PATH,
            page,
            "Update Dream's plan",
            now,
          );
        }
      } catch (error) {
        console.error("Vault: Dream's page failed", errorName(error));
      }
      const report = lifecycleReport(
        lifecycleFindings(this.#memory, {
          now,
          uses,
          changed,
          dream,
          ...(model === null ? {} : { model }),
        }),
      );
      if (report === this.#visible(LIFECYCLE_REPORT_PATH)) return;
      this.#exec(
        "INSERT INTO queue (agent, path, content, summary, queued_at) VALUES (?, ?, ?, ?, ?)",
        SYSTEM_AGENT,
        LIFECYCLE_REPORT_PATH,
        report,
        "Update the memory report",
        now,
      );
    } catch (error) {
      console.error("Vault: the memory report failed", errorName(error));
    }
  }

  /** The held file the model can try next: routable, small enough, with tries left. */
  #nextHeld(): { path: string; content: string; previous: string | null } | undefined {
    return this.#exec<{ path: string; content: string; previous: string | null }>(
      `SELECT path, content, previous FROM held
       WHERE state = 'held' AND attempts < ? AND length(content) <= ? ORDER BY at`,
      MAX_RESOLVE_ATTEMPTS,
      RESOLVE_MAX_CHARS,
    ).find((held) => resolution(held.path) !== null);
  }

  /** Files held with conflict markers that wait: on the model, on a pull request, or on the owner. */
  async held(): Promise<HeldFile[]> {
    if (this.#backend() === null) return [];
    return this.#exec<{ path: string; state: HeldFile["state"]; attempts: number; at: number }>(
      "SELECT path, state, attempts, at FROM held WHERE state != 'resolved' ORDER BY at",
    );
  }

  /**
   * Embeds current notes without a vector from the gateway's model, a few batches a run. Answers
   * whether more are waiting; a failure is logged and waits for the next run.
   */
  async #embedPending(): Promise<boolean> {
    const gateway = this.#gateway();
    if (gateway === null) return false;
    try {
      await this.#catchUp();
      for (let run = 0; run < EMBED_BATCHES_PER_RUN; run += 1) {
        const model = this.#get("embedding_model") ?? "";
        const missing = this.#memory.embeddingTexts(model, EMBED_BATCH);
        if (missing.length === 0) return false;
        const outcome = await within(
          gateway.embed(missing.map((item) => item.text.slice(0, EMBEDDING_INPUT_CHARS))),
          EMBED_NOTES_TIMEOUT_MS,
        );
        if (!outcome?.ok || outcome.vectors.length !== missing.length) {
          console.error("Vault: embedding notes failed", {
            reason: outcome === null ? "no answer" : outcome.ok ? "vector count" : outcome.reason,
          });
          return false;
        }
        // The gateway names its model; a new one means every note is embedded again.
        if (outcome.model !== model) {
          this.#set("embedding_model", outcome.model);
          if (model !== "") continue;
        }
        this.#memory.putEmbeddings(
          outcome.model,
          missing.map((item, i) => ({ blobSha: item.blobSha, vector: outcome.vectors[i] ?? [] })),
        );
      }
      return this.#memory.embeddingTexts(this.#get("embedding_model") ?? "", 1).length > 0;
    } catch (error) {
      console.error("Vault: embedding notes failed", errorName(error));
      return false;
    }
  }

  /**
   * The memories that answer a question, packed for one turn (#110). It never waits behind a commit
   * to GitHub, only behind the first sync of a vault never synced; the question's vector and the
   * rerank are skipped when they don't answer in time. What was packed is counted. A failure
   * answers an empty block, so a turn goes on without memory.
   */
  async recall(agentId: string, question: string, options: RecallOptions): Promise<RecallResult> {
    this.#touch();
    const empty: RecallResult = { text: "", tokens: 0, paths: [], notes: [] };
    const budget = Math.min(
      Math.max(Math.floor(Number(options?.budgetTokens)) || 0, 0),
      MAX_RECALL_TOKENS,
    );
    if (budget === 0) return empty;
    try {
      const hits = await this.#hits(agentId, question, options);
      if (hits === null) return empty;
      const packed = pack(this.#memory, hits.slice(0, RECALL_LIMIT), { budgetTokens: budget });
      if (packed.paths.length > 0) {
        const now = Date.now();
        this.ctx.storage.transactionSync(() => {
          for (const path of packed.paths) {
            this.#exec(
              `INSERT INTO recall_counts (path, count, last_at)
               SELECT ?, 1, ? WHERE EXISTS (SELECT 1 FROM files WHERE path = ?)
               ON CONFLICT (path) DO UPDATE SET count = count + 1, last_at = excluded.last_at`,
              path,
              now,
              path,
            );
          }
        });
      }
      const kelpie = this.#byKelpie(packed.paths);
      return {
        ...packed,
        notes: packed.paths.map((path) => ({ path, byKelpie: kelpie.has(path) })),
      };
    } catch (error) {
      console.error("Vault: recall failed", errorName(error));
      return empty;
    }
  }

  /**
   * The always-loaded core (#112), from memory's index. Like recall, it never waits behind a commit
   * to GitHub, only behind the first sync of a vault never synced. It counts no access: loading it
   * into every conversation would keep its notes from ever going cold. A failure answers an empty
   * block, so the conversation goes on without it.
   */
  async core(agentId: string, budgetTokens: number): Promise<MemoryCoreResult> {
    const empty: MemoryCoreResult = { text: "", tokens: 0, paths: [], omitted: 0 };
    const budget = Math.min(Math.max(Math.floor(Number(budgetTokens)) || 0, 0), MAX_RECALL_TOKENS);
    if (budget === 0 || !isAgentId(agentId) || this.#backend() === null) return empty;
    try {
      await this.#ready();
      await this.#catchUp();
      return coreBlock(this.#memory, { agentId, budgetTokens: budget, now: Date.now() });
    } catch (error) {
      console.error("Vault: the core failed", errorName(error));
      return empty;
    }
  }

  /**
   * The notes that answer a query, as hits, for the agent's `memory_search` (#126): recall's
   * retrieval and rerank, without the packing or the access count.
   */
  async search(
    agentId: string,
    query: string,
    options: MemorySearchOptions,
  ): Promise<MemorySearchResult> {
    this.#touch();
    const k = Math.min(
      Math.max(Math.floor(Number(options?.k ?? SEARCH_K)) || SEARCH_K, 1),
      MAX_SEARCH_K,
    );
    if (this.#backend() === null) return { ok: false, reason: "vault_off" };
    try {
      const hits = (await this.#hits(agentId, query, options))?.slice(0, k) ?? [];
      const kelpie = this.#byKelpie(hits.map((hit) => hit.path));
      const found = hits.flatMap((hit) => {
        const version = this.#memory.versionOf(hit.path, hit.commit);
        if (version === null) return [];
        const note: MemoryHit = {
          path: hit.path,
          title: hit.title,
          abstract: hit.abstract,
          kind: hit.kind,
          scope: version.scope,
          validFrom: version.validFrom,
          invalidAt: version.invalidAt,
          current: hit.current,
          byKelpie: hit.current && kelpie.has(hit.path),
        };
        return [{ note, start: bodyWithoutHeading(version.title, version.body).slice(0, 400) }];
      });
      return {
        ok: true,
        text: renderHits(found.map(({ note, start }) => ({ ...note, start }))),
        notes: found.map(({ note }) => note),
      };
    } catch (error) {
      console.error("Vault: search failed", errorName(error));
      return { ok: false, reason: "unavailable" };
    }
  }

  /**
   * A note of memory's index, a page at a time, for the agent's `memory_read` (#126). Only a current
   * note within the scopes opens; anything else, persona and rules included, is "not found", the
   * same answer whether it exists or not. The first page lists the links the scopes allow, and
   * counts as one access.
   */
  async readNote(agentId: string, path: string, options: ReadNoteOptions): Promise<ReadNoteResult> {
    this.#touch();
    const notFound: ReadNoteResult = { ok: false, reason: "not_found" };
    const scopes = options?.scopes;
    const scopesValid =
      scopes === "all" ||
      (Array.isArray(scopes) &&
        scopes.length <= MAX_RECALL_SCOPES &&
        scopes.every((scope) => isScope(scope)));
    if (!isAgentId(agentId) || typeof path !== "string" || path.length > MAX_PATH_CHARS) {
      return notFound;
    }
    if (!scopesValid) return notFound;
    if (this.#backend() === null) return { ok: false, reason: "vault_off" };
    const sees = (scope: string) =>
      scopes === "all" || (scopes as readonly string[]).includes(scope);
    try {
      await this.#ready();
      await this.#catchUp();
      const version = this.#memory.current(path);
      if (version === null || !sees(version.scope)) return notFound;
      const offset = Math.max(Math.floor(Number(options.offset ?? 0)) || 0, 0);
      const links: { title: string; path: string }[] = [];
      if (offset === 0) {
        const seen = new Set([path]);
        // Resolved among the notes the scopes allow, so another scope's note can't take a link.
        const scoped = scopes === "all" ? {} : { scopes: scopes as readonly Scope[] };
        for (const link of this.#memory.links(path, scoped)) {
          if (link.path === null || seen.has(link.path)) continue;
          seen.add(link.path);
          const target = this.#memory.current(link.path);
          if (target !== null && sees(target.scope))
            links.push({ title: target.title, path: link.path });
        }
        this.#exec(
          `INSERT INTO recall_counts (path, count, last_at) VALUES (?, 1, ?)
           ON CONFLICT (path) DO UPDATE SET count = count + 1, last_at = excluded.last_at`,
          path,
          Date.now(),
        );
      }
      const page = readPage(version, {
        offset,
        byKelpie: this.#byKelpie([path]).has(path),
        links,
      });
      return { ok: true, path, text: page.text, nextOffset: page.nextOffset };
    } catch (error) {
      console.error("Vault: reading a note failed", errorName(error));
      return { ok: false, reason: "unavailable" };
    }
  }

  /**
   * The single writer behind the agent's `memory_write` (#126).
   * - **Where:** a found note's `path` takes the memory as its new version. What the model left
   *   out, the note keeps: its id, the owner's keys, tier, confidence, entities, validity,
   *   abstract, `contradicts` links, pin and evergreen flag; the turn's source joins its sources.
   *   Otherwise the memory goes where its title, and an event's date, put it, numbered when another
   *   note holds the path.
   * - **Scopes:** a found note must be one the turn sees. A new memory goes to `global` or the
   *   agent's own scope when the turn sees every scope, or to a scope the turn lists.
   * - **No news:** the same version again, queued or committed, at its path or a numbered one, or
   *   a twin `decideWrite` finds, is `unchanged`, so a retry writes nothing.
   * - **Refused:** session pages, which the runtime writes, and merge conflict markers; a
   *   `deduced` or `inferred` memory aimed at a note that holds the owner's word (`owners_word`, #149);
   *   and any memory aimed at a note the always-loaded core carries (`core_note`, #168).
   * - **The rules decide:** ADR-0009 wants the qualifier measured before it acts, so it is asked
   *   only in the shadow, after the rules add a memory, and its action is logged (#149).
   * Titles, bodies, abstracts and entities lose their secrets first. The path is chosen and the
   * write queued without a pause between them, so concurrent writes can't take the same path.
   */
  async writeNote(
    agentId: string,
    input: MemoryWriteInput,
    options: WriteNoteOptions,
  ): Promise<WriteNoteResult> {
    this.#touch();
    const scopes = options?.scopes;
    const scopesValid =
      scopes === "all" ||
      (Array.isArray(scopes) &&
        scopes.length <= MAX_RECALL_SCOPES &&
        scopes.every((scope) => isScope(scope)));
    const sources = Array.isArray(options?.sources) ? options.sources : [];
    if (!isAgentId(agentId) || !scopesValid || typeof input !== "object" || input === null) {
      return { ok: false, reason: "invalid", problems: ["the request isn't valid"] };
    }
    if (this.#backend() === null) return { ok: false, reason: "vault_off" };
    const sees = (scope: string) =>
      scopes === "all" || (scopes as readonly string[]).includes(scope);
    const clean = (text: unknown) => (typeof text === "string" ? sanitizeSecrets(text).text : text);
    // A model often sends null for a field it leaves out.
    const given = <T>(value: T | null | undefined): T | undefined =>
      value === null ? undefined : value;
    const path = given(input.path);
    const entitiesGiven = given(input.entities);
    try {
      await this.#ready();
      await this.#catchUp();
      const found = typeof path === "string" ? this.#memory.current(path) : null;
      if (path !== undefined && (found === null || !sees(found.scope))) {
        return { ok: false, reason: "not_found" };
      }
      // Seen, but another agent's folder: not this agent's to write (`isWritable`).
      if (found !== null && !isWritable(agentId, found.path)) {
        return { ok: false, reason: "scope_not_allowed" };
      }
      const problems: string[] = [];
      // A note merged into another (#112): what it held is there now, and so is the next version.
      const merged =
        found === null
          ? undefined
          : this.#memory.links(found.path).find((link) => link.kind === "merged_into");
      if (merged !== undefined) {
        problems.push(
          `the note was merged into ${merged.path ?? `[[${merged.target}]]`}: write to that one`,
        );
      }
      if (found !== null && given(input.scope) !== undefined && input.scope !== found.scope) {
        problems.push(`\`scope\` must be the note's own, ${found.scope}`);
      }
      if (found !== null && input.kind !== found.kind) {
        problems.push(`\`kind\` must be the note's own, ${found.kind}`);
      }
      if (input.kind === "session") {
        problems.push("`kind` can't be session: a conversation's pages are written for it");
      }
      if (typeof input.body === "string" && hasConflictMarkers(input.body)) {
        problems.push("`body` holds merge conflict markers");
      }
      if (entitiesGiven !== undefined && !Array.isArray(entitiesGiven)) {
        problems.push("`entities` must be a list of names");
      }
      if (input.kind === "event" && given(input.validFrom) === undefined && found === null) {
        problems.push("an event needs `validFrom`, its date");
      }
      if (problems.length > 0) return { ok: false, reason: "invalid", problems };

      /**
       * The memory as it will be written: what the model gave, and for a found note, what the note
       * holds and the model left out, as far as the writer can write it back.
       */
      const build = (before: Note | null): MemoryInput => {
        const contradicts =
          (before?.frontmatter.relations as { contradicts?: unknown } | undefined)?.contradicts ??
          [];
        const targets = (Array.isArray(contradicts) ? contradicts : [])
          .map((link) =>
            typeof link === "string" ? /^\[\[([^\]|#]+)/.exec(link)?.[1]?.trim() : undefined,
          )
          .filter((name): name is string => !!name && writable(name, 200));
        const allSources = [
          ...new Set([...(before?.sources ?? []).filter((one) => writable(one, 300)), ...sources]),
        ].slice(-MAX_SOURCES);
        const entities =
          entitiesGiven === undefined
            ? before?.entities.map((entity) => entity.name)
            : (entitiesGiven as unknown[]).map((entity) => clean(entity) as string);
        const abstract =
          given(input.abstract) === undefined
            ? before?.abstract && writable(before.abstract, 300)
              ? before.abstract
              : undefined
            : clean(input.abstract);
        const validFrom = given(input.validFrom) ?? before?.validFrom ?? undefined;
        const invalidAt = given(input.invalidAt) ?? before?.invalidAt ?? undefined;
        return {
          scope: found?.scope ?? given(input.scope) ?? "global",
          kind: input.kind,
          title: clean(input.title),
          body: clean(input.body),
          level: input.level,
          confidence: given(input.confidence) ?? before?.confidence ?? DEFAULT_CONFIDENCE,
          ...(before === null ? {} : { tier: before.tier }),
          ...(allSources.length > 0 ? { sources: allSources } : {}),
          ...(entities?.length ? { entities } : {}),
          ...(validFrom === undefined ? {} : { validFrom }),
          ...(invalidAt === undefined ? {} : { invalidAt }),
          ...(abstract ? { abstract } : {}),
          ...(targets.length > 0 ? { contradicts: targets } : {}),
          ...(found?.pinned ? { pinned: true } : {}),
          ...(found?.evergreen ? { evergreen: true } : {}),
        } as MemoryInput;
      };
      // A note as the vault shows it now, queued writes included; a removal waiting in the queue
      // means it is gone.
      const shownAt = (target: string) => {
        const text = this.#visible(target);
        return { text, note: text === null ? null : parseNote(target, text) };
      };
      const first = found === null ? null : shownAt(found.path);
      let memory = build(first?.note ?? null);
      const at = new Date().toISOString();
      try {
        // Checks every field before anything reads them.
        await writeMemory(memory, { at });
      } catch (error) {
        if (error instanceof MemoryFormatError) {
          return { ok: false, reason: "invalid", problems: [...error.problems] };
        }
        throw error;
      }
      const scope = memory.scope;
      if (
        found === null &&
        !(sees(scope) && (scope === "global" || scope === `agent/${agentId}` || scopes !== "all"))
      ) {
        return { ok: false, reason: "scope_not_allowed" };
      }

      let target: string | null = null;
      let text = "";
      if (found !== null) {
        // The note may change while its new version is rendered: render again from what it shows.
        for (let attempt = 0; attempt < 3 && target === null; attempt += 1) {
          const shown = shownAt(found.path);
          if (shown.text === null) return { ok: false, reason: "not_found" };
          // The always-loaded core carries it (#112): the owner changes it, never the agent (#168).
          const pinned = found.pinned || shown.note?.pinned === true;
          if (coreCarries({ path: found.path, scope: found.scope, pinned }, agentId)) {
            return { ok: false, reason: "core_note" };
          }
          if (shown.note && memory.level !== "explicit" && this.#ownersWord(shown.note)) {
            return { ok: false, reason: "owners_word" };
          }
          memory = build(shown.note);
          text = (await writeMemory(memory, { at, existing: shown.text })).text;
          if (this.#visible(found.path) !== shown.text) continue;
          if (sameVersion(shown.text, text)) {
            return { ok: true, action: "unchanged", path: found.path };
          }
          target = found.path;
        }
        if (target === null) return { ok: false, reason: "unavailable" };
      } else {
        const date = memory.kind === "event" ? memory.validFrom?.slice(0, 10) : undefined;
        const own = memoryPath(memory.scope, memory.kind, memory.title, date);
        text = (await writeMemory(memory, { at })).text;
        const decision = await decideWrite(this.#memory, memory, {
          now: Date.now(),
          qualifier: null,
          ownersWord: (note) => this.#ownersWord(note),
        });
        if (decision.action === "NOOP") {
          return { ok: true, action: "unchanged", path: decision.path };
        }
        // From here to the queue, nothing pauses: no other write can take the path meanwhile.
        for (let n = 1; n <= MAX_PATH_NUMBER && target === null; n += 1) {
          const candidate = n === 1 ? own : own.replace(/\.md$/, `-${n}.md`);
          const shown = shownAt(candidate);
          if (shown.text === null) target = candidate;
          else if (shown.note !== null && saysTheSame(shown.note, memory)) {
            return { ok: true, action: "unchanged", path: candidate };
          }
        }
        if (target === null) {
          return {
            ok: false,
            reason: "invalid",
            problems: ["too many notes share this title; choose another"],
          };
        }
      }
      // Never the title: a headline outlives a forget in git's history.
      const written = await this.write(agentId, [{ path: target, content: text }], "Save a memory");
      if (written.ok && found === null) {
        // The rules wrote it; the qualifier is only measured, in the shadow, until it can decide.
        this.ctx.waitUntil(
          this.#shadowDecision(memory, target, options.qualifier === "jev" ? "jev" : "clef"),
        );
      }
      if (written.ok) return { ok: true, action: "written", path: target };
      return { ok: false, reason: written.reason === "too_large" ? "too_large" : "unavailable" };
    } catch (error) {
      if (error instanceof MemoryFormatError) {
        return { ok: false, reason: "invalid", problems: [...error.problems] };
      }
      console.error("Vault: writing a memory failed", errorName(error));
      return { ok: false, reason: "unavailable" };
    }
  }

  /**
   * Retrieval for recall and search (#110): the question's vector if llm-gateway answers in time,
   * the fused streams, and the agent's qualifier's rerank. Null when the input isn't valid or the
   * vault is off.
   */
  async #hits(
    agentId: string,
    question: string,
    options: Pick<RecallOptions, "scopes" | "asOf" | "validAt" | "qualifier">,
  ): Promise<SearchHit[] | null> {
    const text = typeof question === "string" ? question.slice(0, MAX_QUESTION_CHARS).trim() : "";
    const scopes = options?.scopes;
    const scopesValid =
      scopes === "all" ||
      (Array.isArray(scopes) &&
        scopes.length <= MAX_RECALL_SCOPES &&
        scopes.every((scope) => isScope(scope)));
    if (!isAgentId(agentId) || text === "" || !scopesValid) return null;
    if (this.#backend() === null) return null;
    await this.#ready();
    await this.#catchUp();
    const gateway = this.#gateway();
    const embedded =
      gateway === null ? null : await within(gateway.embed([text]), EMBED_QUESTION_TIMEOUT_MS);
    const query = embedded?.ok ? embedded.vectors[0] : undefined;
    if (embedded?.ok && embedded.model !== this.#get("embedding_model")) {
      // A new model on llm-gateway: the notes are embedded again, and until then this stream
      // finds what it can.
      this.#set("embedding_model", embedded.model);
      await this.#alarmBy(Date.now() + EMBED_AGAIN_MS);
    }
    const retrieveOptions: RetrieveOptions = {
      limit: gateway === null ? RECALL_LIMIT : RERANK_CANDIDATES,
      // Expired notes stay out, unless the question asks how things were (#111).
      notExpiredAt: Date.now(),
      ...(scopes === "all" ? {} : { scopes: scopes as readonly Scope[] }),
      ...(typeof options.asOf === "number" ? { asOf: options.asOf } : {}),
      ...(typeof options.validAt === "number" ? { validAt: options.validAt } : {}),
      ...(embedded?.ok && query ? { vector: { model: embedded.model, query } } : {}),
    };
    let hits = retrieve(this.#memory, text, retrieveOptions);
    if (gateway !== null) {
      const backend: QualifierBackend = options.qualifier === "jev" ? "jev" : "clef";
      const judge = qualifierJudge({
        async qualify(state, questions) {
          const outcome = await gateway.qualify(state, questions, backend, {
            timeoutMs: RERANK_TIMEOUT_MS,
          });
          if (!outcome.ok) throw new Error(outcome.reason);
          return outcome.result;
        },
      });
      // A little past the gateway's own limit, for the call's way back.
      hits = await rerank(this.#memory, text, hits, judge, {
        candidates: RERANK_CANDIDATES,
        timeoutMs: RERANK_TIMEOUT_MS + 500,
      });
    }
    return hits;
  }

  /**
   * The qualifier's write decision for a memory the rules added (#149, ADR-0009): logged next to
   * the rules' ADD, actions only, never acted on. Until a labeled set shows it can decide, this is
   * how its answers are measured in use.
   */
  async #shadowDecision(
    memory: MemoryInput,
    written: string,
    backend: QualifierBackend,
  ): Promise<void> {
    const gateway = this.#gateway();
    if (gateway === null) return;
    try {
      // As memory's index embeds a note: title, abstract and body.
      const text = [memory.title, memory.abstract, memory.body]
        .filter((part) => part)
        .join("\n\n")
        .slice(0, EMBEDDING_INPUT_CHARS);
      const embedded = await within(gateway.embed([text]), EMBED_QUESTION_TIMEOUT_MS);
      const values = embedded?.ok ? embedded.vectors[0] : undefined;
      let answered = false;
      const decision = await decideWrite(this.#memory, memory, {
        now: Date.now(),
        qualifier: {
          async qualify(state, questions) {
            const outcome = await gateway.qualify(state, questions, backend, {
              timeoutMs: RERANK_TIMEOUT_MS,
            });
            if (!outcome.ok) throw new Error(outcome.reason);
            answered = true;
            return outcome.result;
          },
        },
        ...(embedded?.ok && values ? { vector: { model: embedded.model, values } } : {}),
        ownersWord: (note) => this.#ownersWord(note),
        // The note just written may be indexed by now: it isn't its own candidate.
        exclude: [written],
      });
      // Actions only: no text, titles or paths.
      console.log("Vault: write decision, in the shadow", {
        rules: "ADD",
        qualifier: decision.action,
        source: decision.source,
        backend,
        answered,
      });
    } catch (error) {
      console.error("Vault: the shadow write decision failed", errorName(error));
    }
  }

  /**
   * Whether a note holds what the person said (#149): `level: explicit`, or a version Kelpie didn't
   * write, whatever its level, since the owner wrote or edited it, or one where Kelpie merged its
   * write into the owner's edit (#160). A conclusion never changes it.
   */
  #ownersWord(note: { path: string; level: string | null }): boolean {
    return (
      note.level === "explicit" ||
      !this.#byKelpie([note.path]).has(note.path) ||
      this.#exec(
        `SELECT 1 FROM files f JOIN owner_merges m ON m.path = f.path AND m.content = f.content
         WHERE f.path = ?`,
        note.path,
      ).length > 0
    );
  }

  /**
   * Records that Kelpie replaced or removed a version it hadn't written, or one that merged its
   * write into the owner's edit (#160), for the report: read before the `files` row changes.
   * Kelpie's own report isn't listed.
   */
  #recordOwnerChange(path: string, removed: boolean, at: number): void {
    if (path === LIFECYCLE_REPORT_PATH || path === DREAM_PAGE_PATH) return;
    this.#exec(
      `INSERT INTO owner_changes (path, at, removed)
       SELECT f.path, ?, ? FROM files f LEFT JOIN authored a ON a.path = f.path
       WHERE f.path = ? AND (a.blob_sha IS NULL OR a.blob_sha != f.blob_sha
         OR EXISTS (SELECT 1 FROM owner_merges m WHERE m.path = f.path AND m.content = f.content))`,
      at,
      removed ? 1 : 0,
      path,
    );
  }

  /** The paths whose version in the vault is one Kelpie's own commit wrote. */
  #byKelpie(paths: readonly string[]): Set<string> {
    if (paths.length === 0) return new Set();
    return new Set(
      this.#exec<{ path: string }>(
        `SELECT f.path FROM files f JOIN authored a ON a.path = f.path AND a.blob_sha = f.blob_sha
         WHERE f.path IN (SELECT value FROM json_each(?))`,
        JSON.stringify(paths),
      ).map((row) => row.path),
    );
  }

  /** Sets the alarm to `at`, unless one is due sooner; never before a pending retry. */
  async #alarmBy(at: number): Promise<void> {
    const when = Math.max(at, Number(this.#get("retry_at") ?? "0"));
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > when) await this.ctx.storage.setAlarm(when);
  }

  async #branch(backend: VaultBackend): Promise<string> {
    const known = this.#get("branch");
    if (known !== null) return known;
    const branch = await backend.defaultBranch();
    this.#set("branch", branch);
    return branch;
  }

  /** Brings the working copy to the remote head. Runs inside `#serialize`. */
  async #sync(): Promise<void> {
    const backend = this.#backend();
    if (backend === null) return;
    let branch = await this.#branch(backend);
    let remote = await backend.branchHead(branch);
    if (remote === null) {
      // The default branch was renamed: read it again.
      branch = await backend.defaultBranch();
      this.#set("branch", branch);
      remote = await backend.branchHead(branch);
    }
    if (remote === null) throw new Error(`the vault has no branch ${branch}`);
    const head = this.#get("head");
    if (remote !== head) {
      const diff = head === null ? null : await backend.diff(head, remote);
      const snapshot = diff === null ? await backend.snapshot(remote) : null;
      const previous = head;
      const changed = this.ctx.storage.transactionSync(() => {
        const bases = this.#queuedBases();
        const incoming: readonly { path: string; content: string | null }[] =
          snapshot?.files ?? diff?.changes ?? [];
        // What the vault had before a push that brings conflict markers, for their resolution.
        const before = new Map(
          incoming
            .filter((file) => file.content !== null && hasConflictMarkers(file.content))
            .map((file) => [file.path, this.#fileContent(file.path)] as const),
        );
        // Queued writes over a version Kelpie didn't write, or merged into the owner's edit: if a
        // commit of theirs landed with its answer lost, the record of the owner's change is taken
        // here, before the files change.
        const owners = new Set(
          this.#exec<{ path: string }>(
            `SELECT DISTINCT q.path FROM queue q JOIN files f ON f.path = q.path
             LEFT JOIN authored a ON a.path = f.path
             WHERE a.blob_sha IS NULL OR a.blob_sha != f.blob_sha
               OR EXISTS (SELECT 1 FROM owner_merges m WHERE m.path = f.path AND m.content = f.content)`,
          ).map((row) => row.path),
        );
        const changed = snapshot
          ? this.#replaceFiles(snapshot.files)
          : this.#apply(diff?.changes ?? []);
        for (const [path, content] of changed) {
          if (content !== null && hasConflictMarkers(content)) {
            // Held as pushed: queued writes would carry the markers, or overwrite the push.
            this.#hold(path, content, before.get(path) ?? null);
            continue;
          }
          this.#exec("DELETE FROM held WHERE path = ? AND state != 'resolved'", path);
          this.#settleQueued(path, content, bases.get(path) ?? null, owners.has(path));
        }
        this.#set("head", remote);
        return changed;
      });
      await this.#index(previous, remote, this.#indexed(changed));
      if (head === null && this.#visible("README.md") === null) {
        this.#exec(
          "INSERT INTO queue (agent, path, content, summary, queued_at) VALUES (?, ?, ?, ?, ?)",
          SYSTEM_AGENT,
          "README.md",
          VAULT_README,
          "Describe the vault's layout",
          Date.now(),
        );
        await this.#alarmBy(Date.now() + FLUSH_DELAY_MS);
      }
    }
    await this.#alarmBy(Date.now() + RECONCILE_MS);
  }

  /** Applies a diff to the files; returns each changed path with its new content. */
  #apply(changes: readonly FileChange[]): Map<string, string | null> {
    for (const change of changes) {
      if (change.content === null) {
        this.#exec("DELETE FROM files WHERE path = ?", change.path);
        this.#exec("DELETE FROM authored WHERE path = ?", change.path);
      } else {
        this.#exec(
          "INSERT OR REPLACE INTO files (path, content, blob_sha) VALUES (?, ?, ?)",
          change.path,
          change.content,
          change.blobSha ?? "",
        );
      }
    }
    return new Map(changes.map((change) => [change.path, change.content]));
  }

  /** Replaces every file with a snapshot's; returns each changed path with its new content. */
  #replaceFiles(files: readonly VaultFile[]): Map<string, string | null> {
    const before = new Map(
      this.#exec<{ path: string; blob_sha: string }>("SELECT path, blob_sha FROM files").map(
        (row) => [row.path, row.blob_sha],
      ),
    );
    this.#exec("DELETE FROM files");
    const changed = new Map<string, string | null>([...before.keys()].map((path) => [path, null]));
    for (const file of files) {
      this.#exec(
        "INSERT INTO files (path, content, blob_sha) VALUES (?, ?, ?)",
        file.path,
        file.content,
        file.blobSha,
      );
      if (before.get(file.path) === file.blobSha) changed.delete(file.path);
      else changed.set(file.path, file.content);
    }
    // A file the vault no longer has leaves no provenance behind.
    this.#exec("DELETE FROM authored WHERE path NOT IN (SELECT path FROM files)");
    return changed;
  }

  /**
   * Holds a file pushed with conflict markers. A file pushed again still unresolved keeps the
   * version from before its first conflict, which is what a resolution needs to see.
   */
  #hold(path: string, content: string, before: string | null): void {
    const earlier = this.#exec<{ previous: string | null; state: string }>(
      "SELECT previous, state FROM held WHERE path = ?",
      path,
    )[0];
    const previous =
      before !== null && hasConflictMarkers(before) ? (earlier?.previous ?? null) : before;
    this.#exec(
      `INSERT OR REPLACE INTO held (path, content, previous, state, attempts, at)
       VALUES (?, ?, ?, 'held', 0, ?)`,
      path,
      content,
      previous,
      Date.now(),
    );
  }

  /**
   * The working copy of every path with queued writes, read before a sync replaces it: what those
   * writes were built on, since a write is made on what a read shows, queued writes included.
   */
  #queuedBases(): Map<string, string | null> {
    return new Map(
      this.#exec<{ path: string; content: string | null }>(
        `SELECT files.path AS path,
                CASE WHEN held.path IS NULL THEN files.content ELSE held.previous END AS content
         FROM files LEFT JOIN held ON held.path = files.path AND held.content = files.content
         WHERE files.path IN (SELECT path FROM queue)`,
      ).map((row) => [row.path, row.content]),
    );
  }

  /**
   * Reconciles the writes queued for a path with the content a sync brought for it: the owner's
   * edit, merged with Kelpie's latest write line by line from `base`, the owner's side winning where
   * they overlap. Without a common version, or when either side removed the file, the owner's edit
   * wins whole. Kelpie's writes that lost lines are set aside in `conflicts`.
   */
  #settleQueued(
    path: string,
    incoming: string | null,
    base: string | null,
    overOwners = false,
  ): void {
    const queued = this.#exec<{
      id: number;
      agent: string;
      content: string | null;
      summary: string;
      queued_at: number;
    }>("SELECT id, agent, content, summary, queued_at FROM queue WHERE path = ? ORDER BY id", path);
    const last = queued.at(-1);
    if (last === undefined) return;
    const landed = queued.findLastIndex((row) => row.content === incoming);
    if (landed !== -1) {
      // Kelpie's own commit, whose answer was lost: those writes are done, later ones still wait.
      this.#exec("DELETE FROM queue WHERE path = ? AND id <= ?", path, queued[landed]?.id ?? 0);
      // It replaced the owner's version (#160): listed, as a flush would have. An owner's own
      // deletion, or an edit equal to the queued one, made before the flush matches too: rare,
      // and the report errs toward listing.
      if (
        overOwners &&
        queued[landed]?.summary !== RESOLVE_SUMMARY &&
        path !== LIFECYCLE_REPORT_PATH &&
        path !== DREAM_PAGE_PATH
      ) {
        this.#exec(
          "INSERT INTO owner_changes (path, at, removed) VALUES (?, ?, ?)",
          path,
          Date.now(),
          incoming === null ? 1 : 0,
        );
      }
      // And the version is Kelpie's (#126), unless it only settled the owner's conflict.
      if (incoming !== null && queued[landed]?.summary !== RESOLVE_SUMMARY) {
        this.#exec(
          "INSERT OR REPLACE INTO authored (path, blob_sha) SELECT path, blob_sha FROM files WHERE path = ?",
          path,
        );
      }
      return;
    }
    // Dream's write is an abstract for the version it read (#112): an edit since wins whole, as a
    // line merge could leave two abstracts in the frontmatter.
    if (last.summary === DREAM_SUMMARY) {
      this.#exec("DELETE FROM queue WHERE path = ?", path);
      return;
    }
    const result =
      incoming !== null && base !== null && last.content !== null
        ? mergeOwnerWins(base, incoming, last.content)
        : null;
    // A merge that still holds conflict markers is never committed: the owner's edit wins whole.
    const merged = result !== null && !hasConflictMarkers(result.content) ? result : null;
    this.#exec("DELETE FROM queue WHERE path = ?", path);
    this.#exec("DELETE FROM owner_merges WHERE path = ?", path);
    if (merged !== null && merged.content !== incoming) {
      // One write, on top of the owner's edit.
      this.#exec(
        "INSERT INTO queue (agent, path, content, summary, queued_at) VALUES (?, ?, ?, ?, ?)",
        last.agent,
        path,
        merged.content,
        last.summary,
        last.queued_at,
      );
      // Once committed it is Kelpie's version (#126), but it holds the owner's lines (#160).
      this.#exec("INSERT INTO owner_merges (path, content) VALUES (?, ?)", path, merged.content);
    }
    if (merged !== null && !merged.overlapped) return;
    for (const { agent, content } of queued) {
      this.#exec(
        "INSERT INTO conflicts (agent, path, content, reason, at) VALUES (?, ?, ?, 'owner_won', ?)",
        agent,
        path,
        content,
        Date.now(),
      );
    }
    // The path may name a person, so the log holds only how many writes yielded.
    console.warn("Vault: the owner's edit won over queued writes", { writes: queued.length });
  }

  /** The oldest queued writes that fit in one commit, at most `limit`, without `skip`. */
  #nextBatch(limit: number, skip: number | null): QueuedRow[] {
    const rows = this.#exec<QueuedRow>(
      `SELECT id, agent, path, content, summary FROM queue
       WHERE id != ? AND path NOT IN (${HELD}) ORDER BY id LIMIT ?`,
      skip ?? -1,
      limit,
    );
    const batch: QueuedRow[] = [];
    let total = 0;
    for (const row of rows) {
      total += bytes(row.content);
      if (batch.length > 0 && total > MAX_BATCH_BYTES) break;
      batch.push(row);
    }
    return batch;
  }

  /**
   * Commits the queued writes, a batch per commit. Runs inside `#serialize`.
   * - A batch GitHub refuses is split in half until one write is refused alone. That write is set
   *   aside in `conflicts` only once the next write, also alone, goes through: then the refusal was
   *   its own. If that one is refused too, GitHub is refusing everything, and nothing is set aside.
   * - A batch whose commit fails is retried at half its size next time, in case it was too large;
   *   the size grows back after a flush that commits everything.
   * - A failed call throws, and the alarm retries later. Writes wait, and stay readable.
   */
  async #flush(): Promise<void> {
    const backend = this.#backend();
    if (backend === null) return;
    const base = Number(this.#get("batch_rows") ?? `${MAX_BATCH_ROWS}`);
    let limit = base;
    let stale = 0;
    let needsSync = true;
    /** A write refused alone, waiting for proof that the refusal was its own. */
    let suspect: QueuedRow | null = null;
    for (;;) {
      if (needsSync) await this.#sync();
      needsSync = false;
      // A sync may have settled the suspect: an owner's edit, or Kelpie's own lost commit.
      if (suspect && !this.#queued(suspect.id)) suspect = null;
      const rows = this.#nextBatch(suspect ? 1 : limit, suspect?.id ?? null);
      const last = rows.at(-1);
      if (last === undefined) {
        if (suspect) throw new Error("GitHub refused a write, and no other write can show why");
        this.#set("batch_rows", `${Math.min(base * 2, MAX_BATCH_ROWS)}`);
        return;
      }
      const latest = new Map(rows.map((row) => [row.path, row.content]));
      const lastRows = new Map(rows.map((row) => [row.path, row]));
      // A write equal to the vault's file, or the removal of a file it doesn't have, is nothing to
      // commit; GitHub would refuse such a removal.
      const writes = [...latest]
        .filter((entry): entry is [string, string] => entry[1] !== null)
        .filter(([path, content]) => this.#fileContent(path) !== content)
        .map(([path, content]) => ({ path, content }));
      const deletions = [...latest]
        .filter(([path, content]) => content === null && this.#fileContent(path) !== null)
        .map(([path]) => path);
      // Writes to a held file were left out of the batch, and stay.
      const done = () =>
        this.#exec(
          `DELETE FROM queue WHERE id <= ? AND id != ? AND path NOT IN (${HELD})`,
          last.id,
          suspect?.id ?? -1,
        );
      if (writes.length === 0 && deletions.length === 0) {
        done();
        continue;
      }
      const agents = [...new Set(rows.map((row) => row.agent))].sort();
      const summaries = [...new Set(rows.map((row) => row.summary))];
      const headline =
        summaries.length === 1
          ? (summaries[0] ?? "")
          : `Update ${latest.size} files from ${agents.join(", ")}`;
      const shas = await Promise.all(writes.map(({ content }) => gitBlobSha(content)));
      const previousHead = this.#get("head");
      let outcome: Awaited<ReturnType<VaultBackend["commit"]>>;
      try {
        outcome = await backend.commit({
          branch: await this.#branch(backend),
          expectedHead: this.#get("head") ?? "",
          headline,
          body: agents.map((agent) => `Kelpie-Agent: ${agent}`).join("\n"),
          writes,
          deletions,
        });
      } catch (error) {
        if (rows.length > 1) this.#set("batch_rows", `${Math.floor(rows.length / 2)}`);
        throw error;
      }
      if (outcome.kind === "stale") {
        stale += 1;
        if (stale >= MAX_COMMIT_ATTEMPTS) throw new Error("the vault kept moving while committing");
        needsSync = true;
        continue;
      }
      stale = 0;
      if (outcome.kind === "refused") {
        if (rows.length > 1) {
          limit = Math.max(1, Math.floor(rows.length / 2));
        } else if (suspect === null) {
          suspect = last;
        } else {
          throw new Error(`GitHub refuses every commit (${outcome.reason})`);
        }
        continue;
      }
      const commit = outcome.commit;
      this.ctx.storage.transactionSync(() => {
        // A version Kelpie didn't write, now replaced or removed by Kelpie: the report lists it (#160).
        const now = Date.now();
        for (const path of [...writes.map((write) => write.path), ...deletions]) {
          if (lastRows.get(path)?.summary === RESOLVE_SUMMARY) continue;
          this.#recordOwnerChange(path, latest.get(path) === null, now);
        }
        writes.forEach(({ path, content }, i) => {
          this.#exec(
            "INSERT OR REPLACE INTO files (path, content, blob_sha) VALUES (?, ?, ?)",
            path,
            content,
            shas[i] ?? "",
          );
          // Provenance (#126): this version is Kelpie's, unless it only settled the owner's conflict.
          if (lastRows.get(path)?.summary === RESOLVE_SUMMARY) {
            this.#exec("DELETE FROM authored WHERE path = ?", path);
          } else {
            this.#exec(
              "INSERT OR REPLACE INTO authored (path, blob_sha) VALUES (?, ?)",
              path,
              shas[i] ?? "",
            );
          }
        });
        for (const path of deletions) {
          this.#exec("DELETE FROM files WHERE path = ?", path);
          this.#exec("DELETE FROM authored WHERE path = ?", path);
          this.#exec("DELETE FROM owner_merges WHERE path = ?", path);
        }
        // A merge's mark lasts while its version does.
        for (const { path, content } of writes) {
          this.#exec("DELETE FROM owner_merges WHERE path = ? AND content != ?", path, content);
        }
        // Writes queued while the commit was in flight have larger ids, and stay.
        done();
        this.#set("head", commit);
      });
      await this.#index(
        previousHead,
        commit,
        new Map<string, string | null>([
          ...writes.map(({ path, content }) => [path, content] as const),
          ...deletions.map((path) => [path, null] as const),
        ]),
      );
      if (suspect) {
        this.#setAside(suspect);
        suspect = null;
      }
      limit = base;
    }
  }

  #queued(id: number): boolean {
    return this.#exec("SELECT 1 AS one FROM queue WHERE id = ?", id).length > 0;
  }

  #fileContent(path: string): string | null {
    return (
      this.#exec<{ content: string }>("SELECT content FROM files WHERE path = ?", path)[0]
        ?.content ?? null
    );
  }

  /** Sets aside one write GitHub refused on its own, so the writes after it go through. */
  #setAside(row: QueuedRow): void {
    this.ctx.storage.transactionSync(() => {
      this.#exec(
        "INSERT INTO conflicts (agent, path, content, reason, at) VALUES (?, ?, ?, 'refused', ?)",
        row.agent,
        row.path,
        row.content,
        Date.now(),
      );
      this.#exec("DELETE FROM queue WHERE id = ?", row.id);
    });
    console.error("Vault: GitHub refused a write; it was set aside");
  }
}

/**
 * How a held file's resolution is applied: written as the agent that may write it, proposed as a
 * pull request, or not at all.
 */
function resolution(
  path: string,
):
  | { kind: "write"; agentId: string }
  | { kind: "propose"; agentId: string; target: ProposalTarget }
  | null {
  const own = /^agents\/([^/]+)\//.exec(path)?.[1] ?? null;
  const writer = own ?? SYSTEM_AGENT;
  if (isWritable(writer, path)) return { kind: "write", agentId: writer };
  if (own === null || !isAgentId(own)) return null;
  if (path === personaPath(own))
    return { kind: "propose", agentId: own, target: { kind: "persona" } };
  if (path === agentRulesPath(own))
    return { kind: "propose", agentId: own, target: { kind: "rules" } };
  const name = /^agents\/[^/]+\/skills\/([^/]+)\/SKILL\.md$/.exec(path)?.[1];
  return isSkillName(name)
    ? { kind: "propose", agentId: own, target: { kind: "skill", name } }
    : null;
}

function proposalPath(agentId: string, target: ProposalTarget): string | null {
  if (!isAgentId(agentId) || typeof target !== "object" || target === null) return null;
  if (target.kind === "persona") return personaPath(agentId);
  if (target.kind === "rules") return agentRulesPath(agentId);
  if (target.kind === "skill" && isSkillName(target.name)) return skillPath(agentId, target.name);
  return null;
}

/** One line of at most 200 characters, for a commit headline or a pull request's reason. */
function oneLine(text: unknown, fallback: string): string {
  const line = typeof text === "string" ? text.replace(/\s+/g, " ").trim().slice(0, 200) : "";
  return line === "" ? fallback : line;
}

/**
 * A skill's name and description from its `SKILL.md` frontmatter; its folder names it otherwise.
 * Both become one line each, so a description can't add sections to the system prompt.
 */
function skillEntry(path: string, content: string): SkillEntry {
  const folder = path.split("/").at(-2) ?? path;
  const match = /^\u{FEFF}?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  let fields: Record<string, unknown> = {};
  if (match?.[1] !== undefined && match[1].length <= 16_384) {
    try {
      const doc = parseDocument(match[1], { uniqueKeys: true });
      const value = doc.errors.length === 0 ? doc.toJS({ maxAliasCount: 0 }) : null;
      if (typeof value === "object" && value !== null && !Array.isArray(value)) fields = value;
    } catch {
      // Aliases or a malformed block: the folder still names the skill.
    }
  }
  const line = (value: unknown, max: number) => {
    if (typeof value !== "string") return null;
    const text = value
      .replace(/\s+/g, " ")
      .replace(/^[#\s]+/, "")
      .trim()
      .slice(0, max);
    return text === "" ? null : text;
  };
  return {
    name: line(fields.name, 64) ?? line(folder, 64) ?? "skill",
    description: line(fields.description, 1_024) ?? "",
    path,
  };
}
