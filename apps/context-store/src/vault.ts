import { DurableObject } from "cloudflare:workers";
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

/** Set by the owner with `wrangler secret put` (docs/context-store.md). */
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
const RETRY_MS = 60_000;
const MAX_COMMIT_ATTEMPTS = 3;
const MAX_CONTENT_LENGTH = 262_144;
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
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL,
  path TEXT NOT NULL,
  base_blob_sha TEXT,
  branch TEXT NOT NULL,
  pull_request INTEGER NOT NULL,
  url TEXT NOT NULL,
  at INTEGER NOT NULL
);
`;

let backendForTesting: VaultBackend | null | undefined;

/** Tests run in the Worker's isolate and swap the backend with this. Production never calls it. */
export function replaceBackendForTesting(backend: VaultBackend | null | undefined): void {
  backendForTesting = backend;
}

/** The GitHub backend, or null while the vault isn't configured. */
function backendFor(env: VaultEnv): VaultBackend | null {
  if (backendForTesting !== undefined) return backendForTesting;
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

/**
 * The vault's working copy and its single writer (ADR-0005, ADR-0020 §3). It keeps the files of
 * the synced head in SQLite and queues Kelpie's writes, which reads see at once and an alarm
 * commits in a batch. Pushes arrive through the webhook and a periodic reconcile. When the owner
 * changed a file Kelpie was about to write, the owner's version wins and Kelpie's write is kept as
 * a conflict; merging the two is #114's.
 */
export class Vault extends DurableObject<VaultEnv> {
  /** GitHub calls are asynchronous; syncs, flushes and proposals run one at a time. */
  #work: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: VaultEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(SCHEMA);
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

  async compile(agentId: string): Promise<CompiledContext> {
    const empty: CompiledContext = { persona: null, rules: [], skills: [] };
    if (!isAgentId(agentId) || backendFor(this.env) === null) return empty;
    if (this.#get("head") === null) await this.#serialize(() => this.#sync());
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
    if (backendFor(this.env) === null) return null;
    if (this.#get("head") === null) await this.#serialize(() => this.#sync());
    return this.#visible(path);
  }

  async write(
    agentId: string,
    changes: { path: string; content: string | null }[],
    summary: string,
  ): Promise<WriteResult> {
    if (backendFor(this.env) === null) return { ok: false, reason: "vault_off" };
    const valid =
      isAgentId(agentId) &&
      changes.length > 0 &&
      changes.every(
        ({ path, content }) =>
          isWritable(agentId, path) &&
          (content === null ||
            (typeof content === "string" && content.length <= MAX_CONTENT_LENGTH)),
      );
    if (!valid) return { ok: false, reason: "invalid_path" };
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
    const backend = backendFor(this.env);
    if (backend === null) return { ok: false, reason: "vault_off" };
    const path = proposalPath(agentId, target);
    if (path === null || typeof content !== "string" || content.length > MAX_CONTENT_LENGTH) {
      return { ok: false, reason: "invalid_target" };
    }
    return this.#serialize(async () => {
      await this.#sync();
      const head = this.#get("head") ?? "";
      const base = this.#exec<{ content: string; blob_sha: string }>(
        "SELECT content, blob_sha FROM files WHERE path = ?",
        path,
      )[0];
      if (base?.content === content) return { ok: false, reason: "unchanged" } as const;
      const what = target.kind === "skill" ? `skill ${target.name}` : target.kind;
      const branch = `kelpie/${agentId}/${target.kind === "skill" ? target.name : target.kind}-${Date.now().toString(36)}`;
      const headline = `Propose ${what} for ${agentId}`;
      const why = oneLine(reason, "No reason given.");
      await backend.createBranch(branch, head);
      const outcome = await backend.commit({
        branch,
        expectedHead: head,
        headline,
        body: `${why}\n\nKelpie-Agent: ${agentId}`,
        writes: [{ path, content }],
        deletions: [],
      });
      if (outcome.kind !== "committed") throw new Error("the proposal's branch moved");
      const pull = await backend.openPullRequest({
        branch,
        base: await this.#branch(backend),
        title: headline,
        body: `${why}\n\nProposed by \`${agentId}\`. It changes \`${path}\`${base ? `, from blob ${base.blob_sha}` : ", a new file"}. Approval is on for this item (ADR-0020 §5).`,
      });
      this.#exec(
        `INSERT INTO proposals (agent, path, base_blob_sha, branch, pull_request, url, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        agentId,
        path,
        base?.blob_sha ?? null,
        branch,
        pull.number,
        pull.url,
        Date.now(),
      );
      return { ok: true, url: pull.url } as const;
    });
  }

  /** The webhook's call: a push reached `ref`. The alarm syncs a moment later, once per burst. */
  async requestSync(ref: string): Promise<void> {
    if (backendFor(this.env) === null) return;
    const branch = this.#get("branch");
    if (branch !== null && ref !== `refs/heads/${branch}`) return;
    await this.#alarmBy(Date.now() + SYNC_DELAY_MS);
  }

  override async alarm(): Promise<void> {
    if (backendFor(this.env) === null) return;
    try {
      await this.#serialize(() => this.#flush());
      await this.#serialize(() => this.#sync());
    } catch (error) {
      console.error("Vault: sync failed; retrying", errorName(error));
      await this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
      return;
    }
    const queued = this.#exec<{ n: number }>("SELECT count(*) AS n FROM queue")[0]?.n ?? 0;
    await this.ctx.storage.setAlarm(Date.now() + (queued > 0 ? FLUSH_DELAY_MS : RECONCILE_MS));
  }

  async #alarmBy(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
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
    const backend = backendFor(this.env);
    if (backend === null) return;
    const branch = await this.#branch(backend);
    const remote = await backend.branchHead(branch);
    if (remote === null) throw new Error(`the vault has no branch ${branch}`);
    const head = this.#get("head");
    if (remote === head) return;
    const diff = head === null ? null : await backend.diff(head, remote);
    const snapshot = diff === null ? await backend.snapshot(remote) : null;
    this.ctx.storage.transactionSync(() => {
      const changed = snapshot
        ? this.#replaceFiles(snapshot.files)
        : this.#apply(diff?.changes ?? []);
      for (const path of changed) this.#yieldToOwner(path);
      this.#set("head", remote);
    });
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

  /** Applies a diff to the files; returns the paths it changed. */
  #apply(changes: readonly FileChange[]): string[] {
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
    return changes.map((change) => change.path);
  }

  /** Replaces every file with a snapshot's; returns the paths whose content changed. */
  #replaceFiles(files: readonly VaultFile[]): string[] {
    const before = new Map(
      this.#exec<{ path: string; blob_sha: string }>("SELECT path, blob_sha FROM files").map(
        (row) => [row.path, row.blob_sha],
      ),
    );
    this.#exec("DELETE FROM files");
    const changed = new Set(before.keys());
    for (const file of files) {
      this.#exec(
        "INSERT INTO files (path, content, blob_sha) VALUES (?, ?, ?)",
        file.path,
        file.content,
        file.blobSha,
      );
      if (before.get(file.path) === file.blobSha) changed.delete(file.path);
      else changed.add(file.path);
    }
    return [...changed];
  }

  /** The owner changed a file Kelpie had queued: theirs wins, and Kelpie's is kept as a conflict. */
  #yieldToOwner(path: string): void {
    const queued = this.#exec<{ agent: string; content: string | null }>(
      "SELECT agent, content FROM queue WHERE path = ? ORDER BY id",
      path,
    );
    if (queued.length === 0) return;
    for (const { agent, content } of queued) {
      this.#exec(
        "INSERT INTO conflicts (agent, path, content, at) VALUES (?, ?, ?, ?)",
        agent,
        path,
        content,
        Date.now(),
      );
      console.warn("Vault: the owner's edit won over a queued write", { agent, path });
    }
    this.#exec("DELETE FROM queue WHERE path = ?", path);
  }

  /** Commits the queued writes in one commit. Runs inside `#serialize`. */
  async #flush(): Promise<void> {
    const backend = backendFor(this.env);
    if (backend === null) return;
    for (let attempt = 1; attempt <= MAX_COMMIT_ATTEMPTS; attempt += 1) {
      await this.#sync();
      const rows = this.#exec<{
        id: number;
        agent: string;
        path: string;
        content: string | null;
        summary: string;
      }>("SELECT id, agent, path, content, summary FROM queue ORDER BY id");
      if (rows.length === 0) return;
      const latest = new Map(rows.map((row) => [row.path, row.content]));
      const writes = [...latest]
        .filter((entry): entry is [string, string] => entry[1] !== null)
        .map(([path, content]) => ({ path, content }));
      const deletions = [...latest].filter(([, content]) => content === null).map(([path]) => path);
      const agents = [...new Set(rows.map((row) => row.agent))].sort();
      const summaries = [...new Set(rows.map((row) => row.summary))];
      const headline =
        summaries.length === 1
          ? (summaries[0] ?? "")
          : `Update ${latest.size} files from ${agents.join(", ")}`;
      const head = this.#get("head") ?? "";
      const shas = await Promise.all(writes.map(({ content }) => gitBlobSha(content)));
      const outcome = await backend.commit({
        branch: await this.#branch(backend),
        expectedHead: head,
        headline,
        body: agents.map((agent) => `Kelpie-Agent: ${agent}`).join("\n"),
        writes,
        deletions,
      });
      if (outcome.kind === "stale") continue;
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
        const ids = rows.map((row) => row.id);
        this.#exec(`DELETE FROM queue WHERE id IN (${ids.map(() => "?").join(", ")})`, ...ids);
        this.#set("head", outcome.commit);
      });
      return;
    }
    throw new Error("the vault kept moving while committing");
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

/** A skill's name and description from its `SKILL.md` frontmatter; its folder names it otherwise. */
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
  const text = (value: unknown, max: number) =>
    typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, max) : null;
  return {
    name: text(fields.name, 64) ?? folder,
    description: text(fields.description, 1_024) ?? "",
    path,
  };
}
