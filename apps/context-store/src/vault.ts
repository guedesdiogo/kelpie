import { DurableObject } from "cloudflare:workers";
import { EMBEDDING_INPUT_CHARS, type EmbedOutcome } from "@kelpie/llm";
import {
  isScope,
  MemoryIndex,
  pack,
  qualifierJudge,
  type RetrieveOptions,
  rerank,
  retrieve,
  type Scope,
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
import type {
  CompiledContext,
  ProposalTarget,
  ProposeResult,
  RecallOptions,
  RecallResult,
  SkillEntry,
  WriteResult,
} from "./contract.ts";
import {
  agentRulesPath,
  isAgentId,
  isSkillFile,
  isSkillName,
  isWritable,
  personaPath,
  skillPath,
} from "./paths.ts";
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
CREATE TABLE IF NOT EXISTS recall_counts (
  path TEXT PRIMARY KEY NOT NULL,
  count INTEGER NOT NULL,
  last_at INTEGER NOT NULL
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

const encoder = new TextEncoder();
const bytes = (text: string | null) => (text === null ? 0 : encoder.encode(text).byteLength);

/** What memory asks of llm-gateway: embeddings, and the qualifier for the rerank. */
export interface MemoryGateway {
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

function errorName(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : "unknown error";
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
    const files = this.#exec<{ path: string; content: string }>("SELECT path, content FROM files");
    const changes = new Map<string, string | null>(
      this.#memory.currentPaths().map((path) => [path, null]),
    );
    for (const { path, content } of files) changes.set(path, content);
    await this.#applyToIndex(head, changes);
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
    const skills = this.#exec<{ path: string; content: string }>(
      "SELECT path, content FROM files WHERE path LIKE '%/SKILL.md' ORDER BY path",
    )
      .filter(({ path }) => isSkillFile(agentId, path))
      .map(({ path, content }) => skillEntry(path, content));
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
    return this.#serialize(async (): Promise<ProposeResult> => {
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
    });
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
    const queued = this.#exec<{ n: number }>("SELECT count(*) AS n FROM queue")[0]?.n ?? 0;
    await this.#alarmBy(
      Date.now() + (queued > 0 ? FLUSH_DELAY_MS : moreToEmbed ? EMBED_AGAIN_MS : RECONCILE_MS),
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
    const empty: RecallResult = { text: "", tokens: 0, paths: [] };
    const budget = Math.min(
      Math.max(Math.floor(Number(options?.budgetTokens)) || 0, 0),
      MAX_RECALL_TOKENS,
    );
    const text = typeof question === "string" ? question.slice(0, MAX_QUESTION_CHARS).trim() : "";
    const scopes = options?.scopes;
    const scopesValid =
      scopes === "all" ||
      (Array.isArray(scopes) &&
        scopes.length <= MAX_RECALL_SCOPES &&
        scopes.every((scope) => isScope(scope)));
    if (!isAgentId(agentId) || text === "" || budget === 0 || !scopesValid) return empty;
    if (this.#backend() === null) return empty;
    try {
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
      const packed = pack(this.#memory, hits.slice(0, RECALL_LIMIT), { budgetTokens: budget });
      if (packed.paths.length > 0) {
        const now = Date.now();
        this.ctx.storage.transactionSync(() => {
          for (const path of packed.paths) {
            this.#exec(
              `INSERT INTO recall_counts (path, count, last_at) VALUES (?, 1, ?)
               ON CONFLICT (path) DO UPDATE SET count = count + 1, last_at = excluded.last_at`,
              path,
              now,
            );
          }
        });
      }
      return packed;
    } catch (error) {
      console.error("Vault: recall failed", errorName(error));
      return empty;
    }
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
        const changed = snapshot
          ? this.#replaceFiles(snapshot.files)
          : this.#apply(diff?.changes ?? []);
        for (const [path, content] of changed) this.#settleQueued(path, content);
        this.#set("head", remote);
        return changed;
      });
      await this.#index(previous, remote, changed);
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
    return changed;
  }

  /** Reconciles the writes queued for a path with the content a sync brought for it. */
  #settleQueued(path: string, incoming: string | null): void {
    const queued = this.#exec<{ id: number; agent: string; content: string | null }>(
      "SELECT id, agent, content FROM queue WHERE path = ? ORDER BY id",
      path,
    );
    if (queued.length === 0) return;
    const landed = queued.findLastIndex((row) => row.content === incoming);
    if (landed !== -1) {
      // Kelpie's own commit, whose answer was lost: those writes are done, later ones still wait.
      this.#exec("DELETE FROM queue WHERE path = ? AND id <= ?", path, queued[landed]?.id ?? 0);
      return;
    }
    for (const { agent, content } of queued) {
      this.#exec(
        "INSERT INTO conflicts (agent, path, content, reason, at) VALUES (?, ?, ?, 'owner_won', ?)",
        agent,
        path,
        content,
        Date.now(),
      );
    }
    this.#exec("DELETE FROM queue WHERE path = ?", path);
    // The path may name a person, so the log holds only how many writes yielded.
    console.warn("Vault: the owner's edit won over queued writes", { writes: queued.length });
  }

  /** The oldest queued writes that fit in one commit, at most `limit`, without `skip`. */
  #nextBatch(limit: number, skip: number | null): QueuedRow[] {
    const rows = this.#exec<QueuedRow>(
      "SELECT id, agent, path, content, summary FROM queue WHERE id != ? ORDER BY id LIMIT ?",
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
      // A write equal to the vault's file, or the removal of a file it doesn't have, is nothing to
      // commit; GitHub would refuse such a removal.
      const writes = [...latest]
        .filter((entry): entry is [string, string] => entry[1] !== null)
        .filter(([path, content]) => this.#fileContent(path) !== content)
        .map(([path, content]) => ({ path, content }));
      const deletions = [...latest]
        .filter(([path, content]) => content === null && this.#fileContent(path) !== null)
        .map(([path]) => path);
      const done = () =>
        this.#exec("DELETE FROM queue WHERE id <= ? AND id != ?", last.id, suspect?.id ?? -1);
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
        writes.forEach(({ path, content }, i) => {
          this.#exec(
            "INSERT OR REPLACE INTO files (path, content, blob_sha) VALUES (?, ?, ?)",
            path,
            content,
            shas[i] ?? "",
          );
        });
        for (const path of deletions) this.#exec("DELETE FROM files WHERE path = ?", path);
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
