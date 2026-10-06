// The memory index: derived from the vault, and rebuilt from it at any time (ADR-0020 §2). The
// schema follows ai-memory's at fc4da03 (versioned pages, external-content FTS5, entities, links),
// with every row derived from commits so a rebuild reproduces it exactly.
import { foldKey } from "./entities.ts";
import { gitBlobSha } from "./hash.ts";
import type { Kind, Scope, Tier } from "./layout.ts";
import type { LinkBy, LinkKind } from "./markdown.ts";
import { instantOf, type Level, readNote } from "./note.ts";

export type SqlValue = ArrayBuffer | string | number | null;

/** The part of a SQLite Durable Object's storage the index uses; `ctx.storage` satisfies it. */
export interface IndexStorage {
  sql: {
    exec<T extends Record<string, SqlValue>>(
      query: string,
      ...bindings: SqlValue[]
    ): { toArray(): T[] };
  };
  transactionSync<T>(closure: () => T): T;
}

/** One file a commit added, changed (`content`) or removed (`content: null`). */
export interface VaultChange {
  path: string;
  content: string | null;
}

export interface VaultCommit {
  sha: string;
  /** Committer time, in epoch milliseconds. */
  committedAt: number;
  changes: readonly VaultChange[];
}

/** One version of a note, current or superseded. */
export interface IndexedVersion {
  path: string;
  /** The commit that wrote this version. */
  commit: string;
  blobSha: string;
  /** The commit of the version it replaced at the same path. */
  supersedes: string | null;
  current: boolean;
  /** Ingestion time: when the vault started and stopped holding this version (commit times). */
  recordedAt: number;
  replacedAt: number | null;
  /** The commit that replaced or removed it. */
  replacedBy: string | null;
  id: string | null;
  scope: Scope;
  kind: Kind;
  tier: Tier;
  level: Level | null;
  confidence: number | null;
  evergreen: boolean;
  pinned: boolean;
  /** World time, in epoch milliseconds. */
  validFrom: number | null;
  invalidAt: number | null;
  title: string;
  abstract: string | null;
  body: string;
  frontmatter: Record<string, unknown>;
  warnings: string[];
}

export interface ApplyResult {
  /** False when the commit had already been applied. */
  applied: boolean;
  /** Paths that got a new version. */
  written: string[];
  /** Paths whose current version was removed. */
  removed: string[];
}

export interface SearchOptions {
  limit?: number;
  /** Ingestion time: search the versions the vault held then, instead of the current ones. */
  asOf?: number;
  /** World time: keep only memories valid at this instant. */
  validAt?: number;
}

export interface SearchHit {
  path: string;
  commit: string;
  title: string;
  abstract: string | null;
  current: boolean;
}

export interface ResolvedLink {
  kind: LinkKind;
  by: LinkBy;
  target: string;
  /** The current note it points at, or null when nothing in the vault matches. */
  path: string | null;
}

/** Every derived row, ordered, without SQLite's row ids: two equal dumps are the same index. */
export interface IndexDump {
  commits: { sha: string; seq: number; committedAt: number }[];
  versions: IndexedVersion[];
  entities: { path: string; commit: string; key: string; name: string }[];
  links: { path: string; commit: string; kind: string; by: string; target: string }[];
}

export const SCHEMA_VERSION = 1;

const DERIVED_SCHEMA = `
CREATE TABLE commits (
  sha TEXT PRIMARY KEY NOT NULL,
  seq INTEGER NOT NULL UNIQUE,
  committed_at INTEGER NOT NULL
);
CREATE TABLE versions (
  rowid INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  commit_seq INTEGER NOT NULL,
  blob_sha TEXT NOT NULL,
  supersedes_commit TEXT,
  is_current INTEGER NOT NULL CHECK (is_current IN (0, 1)),
  recorded_at INTEGER NOT NULL,
  replaced_at INTEGER,
  replaced_by_commit TEXT,
  memory_id TEXT,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL,
  tier TEXT NOT NULL,
  level TEXT,
  confidence REAL,
  evergreen INTEGER NOT NULL,
  pinned INTEGER NOT NULL,
  valid_from INTEGER,
  invalid_at INTEGER,
  title TEXT NOT NULL,
  abstract TEXT,
  body TEXT NOT NULL,
  path_search TEXT NOT NULL,
  link_path TEXT NOT NULL,
  link_name TEXT NOT NULL,
  frontmatter TEXT NOT NULL,
  warnings TEXT NOT NULL,
  UNIQUE (path, commit_sha)
);
CREATE UNIQUE INDEX versions_current_path ON versions (path) WHERE is_current = 1;
CREATE INDEX versions_path_seq ON versions (path, commit_seq);
CREATE INDEX versions_link_path ON versions (link_path) WHERE is_current = 1;
CREATE INDEX versions_link_name ON versions (link_name) WHERE is_current = 1;
CREATE INDEX versions_memory_id ON versions (memory_id) WHERE memory_id IS NOT NULL;
CREATE VIRTUAL TABLE versions_fts USING fts5(
  title, abstract, body, path_search,
  content = 'versions', content_rowid = 'rowid',
  tokenize = "unicode61 remove_diacritics 2"
);
CREATE TRIGGER versions_fts_ai AFTER INSERT ON versions BEGIN
  INSERT INTO versions_fts (rowid, title, abstract, body, path_search)
    VALUES (new.rowid, new.title, new.abstract, new.body, new.path_search);
END;
CREATE TRIGGER versions_fts_ad AFTER DELETE ON versions BEGIN
  INSERT INTO versions_fts (versions_fts, rowid, title, abstract, body, path_search)
    VALUES ('delete', old.rowid, old.title, old.abstract, old.body, old.path_search);
END;
CREATE TRIGGER versions_fts_au AFTER UPDATE OF title, abstract, body, path_search ON versions BEGIN
  INSERT INTO versions_fts (versions_fts, rowid, title, abstract, body, path_search)
    VALUES ('delete', old.rowid, old.title, old.abstract, old.body, old.path_search);
  INSERT INTO versions_fts (rowid, title, abstract, body, path_search)
    VALUES (new.rowid, new.title, new.abstract, new.body, new.path_search);
END;
CREATE TABLE entities (
  version INTEGER NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (version, key)
) WITHOUT ROWID;
CREATE INDEX entities_key ON entities (key);
CREATE TABLE links (
  version INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('link', 'embed', 'source', 'contradicts')),
  by TEXT NOT NULL CHECK (by IN ('path', 'name')),
  target TEXT NOT NULL,
  PRIMARY KEY (version, kind, by, target)
) WITHOUT ROWID;
CREATE INDEX links_target ON links (by, target);
`;

const DERIVED_OBJECTS = [
  "TRIGGER versions_fts_ai",
  "TRIGGER versions_fts_ad",
  "TRIGGER versions_fts_au",
  "TABLE versions_fts",
  "TABLE links",
  "TABLE entities",
  "TABLE versions",
  "TABLE commits",
];

// Embeddings are keyed by content and model, so they stay valid across a rebuild and are kept as a
// cache: computing them costs a model call. Retrieval (#110) fills and reads them.
const CACHE_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS embeddings (
  blob_sha TEXT NOT NULL,
  model TEXT NOT NULL,
  dims INTEGER NOT NULL CHECK (dims > 0),
  vector BLOB NOT NULL,
  PRIMARY KEY (blob_sha, model)
) WITHOUT ROWID;
`;

/** Path text for full-text search: `memory/people/ana-souza.md` also matches "ana" and "souza". */
function pathSearch(path: string): string {
  const segments = path.replace(/[/.]/g, " ");
  return `${segments} ${segments.replace(/[-_]/g, " ")}`;
}

function linkKeys(path: string): { linkPath: string; linkName: string } {
  const linkPath = path.slice(0, -3).toLowerCase();
  return { linkPath, linkName: linkPath.slice(linkPath.lastIndexOf("/") + 1) };
}

/** Words of a query, each quoted, so no user text is read as FTS5 syntax. */
export function ftsQuery(text: string): string | null {
  const words = [...new Set(foldKey(text).match(/[\p{L}\p{N}]+/gu) ?? [])]
    .filter((word) => word.length >= 2)
    .slice(0, 32);
  return words.length === 0 ? null : words.map((word) => `"${word}"`).join(" OR ");
}

type VersionRow = {
  path: string;
  commit_sha: string;
  blob_sha: string;
  supersedes_commit: string | null;
  is_current: number;
  recorded_at: number;
  replaced_at: number | null;
  replaced_by_commit: string | null;
  memory_id: string | null;
  scope: string;
  kind: string;
  tier: string;
  level: string | null;
  confidence: number | null;
  evergreen: number;
  pinned: number;
  valid_from: number | null;
  invalid_at: number | null;
  title: string;
  abstract: string | null;
  body: string;
  frontmatter: string;
  warnings: string;
};

const VERSION_COLUMNS = `v.path, v.commit_sha, v.blob_sha, v.supersedes_commit, v.is_current, v.recorded_at,
  v.replaced_at, v.replaced_by_commit, v.memory_id, v.scope, v.kind, v.tier, v.level, v.confidence,
  v.evergreen, v.pinned, v.valid_from, v.invalid_at, v.title, v.abstract, v.body, v.frontmatter,
  v.warnings`;

function toVersion(row: VersionRow): IndexedVersion {
  return {
    path: row.path,
    commit: row.commit_sha,
    blobSha: row.blob_sha,
    supersedes: row.supersedes_commit,
    current: row.is_current === 1,
    recordedAt: row.recorded_at,
    replacedAt: row.replaced_at,
    replacedBy: row.replaced_by_commit,
    id: row.memory_id,
    scope: row.scope as Scope,
    kind: row.kind as Kind,
    tier: row.tier as Tier,
    level: row.level as Level | null,
    confidence: row.confidence,
    evergreen: row.evergreen === 1,
    pinned: row.pinned === 1,
    validFrom: row.valid_from,
    invalidAt: row.invalid_at,
    title: row.title,
    abstract: row.abstract,
    body: row.body,
    frontmatter: JSON.parse(row.frontmatter) as Record<string, unknown>,
    warnings: JSON.parse(row.warnings) as string[],
  };
}

/**
 * The index over one vault, in a SQLite Durable Object. Commits are applied one at a time, in
 * history order: the caller serializes them, as the Context Store's single writer does.
 */
export class MemoryIndex {
  readonly #storage: IndexStorage;

  constructor(storage: IndexStorage) {
    this.#storage = storage;
    this.#storage.transactionSync(() => {
      this.#exec(CACHE_SCHEMA);
      const version = this.#exec<{ value: string }>(
        "SELECT value FROM meta WHERE key = 'schema_version'",
      )[0]?.value;
      if (version === undefined) {
        this.#exec(DERIVED_SCHEMA);
        this.#exec(
          "INSERT INTO meta (key, value) VALUES ('schema_version', ?)",
          `${SCHEMA_VERSION}`,
        );
      } else if (version !== `${SCHEMA_VERSION}`) {
        throw new Error(`memory index schema ${version} isn't ${SCHEMA_VERSION}; rebuild it`);
      }
    });
  }

  #exec<T extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): T[] {
    return this.#storage.sql.exec<T>(query, ...bindings).toArray();
  }

  /** Applies one commit. A commit applied before is skipped, so replays are harmless. */
  async applyCommit(commit: VaultCommit): Promise<ApplyResult> {
    // Hashing is asynchronous and SQLite work is synchronous, so the hashes come first.
    const changes = await Promise.all(
      [...commit.changes]
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .map(async (change) => ({
          ...change,
          blobSha: change.content === null ? null : await gitBlobSha(change.content),
        })),
    );
    return this.#storage.transactionSync(() => {
      const result: ApplyResult = { applied: false, written: [], removed: [] };
      if (this.#exec("SELECT 1 AS one FROM commits WHERE sha = ?", commit.sha).length > 0) {
        return result;
      }
      result.applied = true;
      const seq =
        (this.#exec<{ seq: number | null }>("SELECT max(seq) AS seq FROM commits")[0]?.seq ?? 0) +
        1;
      this.#exec(
        "INSERT INTO commits (sha, seq, committed_at) VALUES (?, ?, ?)",
        commit.sha,
        seq,
        commit.committedAt,
      );
      for (const change of changes) {
        const current = this.#exec<{ rowid: number; blob_sha: string; commit_sha: string }>(
          "SELECT rowid, blob_sha, commit_sha FROM versions WHERE path = ? AND is_current = 1",
          change.path,
        )[0];
        if (current !== undefined && current.blob_sha === change.blobSha) continue;
        const note = change.content === null ? null : readNote(change.path, change.content);
        // Outside the index: persona, rules, skills, root files, anything but Markdown.
        if (change.content !== null && note === null) continue;
        if (current !== undefined) {
          this.#exec(
            `UPDATE versions SET is_current = 0, replaced_at = ?, replaced_by_commit = ?
             WHERE rowid = ?`,
            commit.committedAt,
            commit.sha,
            current.rowid,
          );
          if (note === null) result.removed.push(change.path);
        }
        if (note === null || change.blobSha === null) continue;
        // A path removed and written again continues its chain, as ai-memory resurrects a
        // tombstone instead of orphaning it.
        const previous =
          current?.commit_sha ??
          this.#exec<{ commit_sha: string }>(
            "SELECT commit_sha FROM versions WHERE path = ? ORDER BY commit_seq DESC LIMIT 1",
            change.path,
          )[0]?.commit_sha ??
          null;
        const { linkPath, linkName } = linkKeys(change.path);
        const rowid = this.#exec<{ rowid: number }>(
          `INSERT INTO versions (path, commit_sha, commit_seq, blob_sha, supersedes_commit, is_current,
             recorded_at, memory_id, scope, kind, tier, level, confidence, evergreen, pinned,
             valid_from, invalid_at, title, abstract, body, path_search, link_path, link_name,
             frontmatter, warnings)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING rowid`,
          change.path,
          commit.sha,
          seq,
          change.blobSha,
          previous,
          commit.committedAt,
          note.id,
          note.scope,
          note.kind,
          note.tier,
          note.level,
          note.confidence,
          note.evergreen ? 1 : 0,
          note.pinned ? 1 : 0,
          note.validFrom === null ? null : instantOf(note.validFrom),
          note.invalidAt === null ? null : instantOf(note.invalidAt),
          note.title,
          note.abstract,
          note.body,
          pathSearch(change.path),
          linkPath,
          linkName,
          JSON.stringify(note.frontmatter),
          JSON.stringify(note.warnings),
        )[0]?.rowid;
        if (rowid === undefined) throw new Error("the version insert returned no row id");
        for (const entity of note.entities) {
          this.#exec(
            "INSERT INTO entities (version, key, name) VALUES (?, ?, ?)",
            rowid,
            entity.key,
            entity.name,
          );
        }
        for (const link of note.links) {
          this.#exec(
            "INSERT OR IGNORE INTO links (version, kind, by, target) VALUES (?, ?, ?, ?)",
            rowid,
            link.kind,
            link.by,
            link.target,
          );
        }
        result.written.push(change.path);
      }
      return result;
    });
  }

  /**
   * Drops every derived row and replays the vault's history, oldest commit first. Embeddings are
   * kept: they are keyed by content, so they stay valid.
   */
  async rebuild(history: Iterable<VaultCommit> | AsyncIterable<VaultCommit>): Promise<void> {
    this.#storage.transactionSync(() => {
      for (const object of DERIVED_OBJECTS) this.#exec(`DROP ${object}`);
      this.#exec(DERIVED_SCHEMA);
    });
    for await (const commit of history) await this.applyCommit(commit);
  }

  /** The last commit applied, which is where the next sync starts. */
  lastCommit(): { sha: string; committedAt: number } | null {
    const row = this.#exec<{ sha: string; committed_at: number }>(
      "SELECT sha, committed_at FROM commits ORDER BY seq DESC LIMIT 1",
    )[0];
    return row === undefined ? null : { sha: row.sha, committedAt: row.committed_at };
  }

  current(path: string): IndexedVersion | null {
    const row = this.#exec<VersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM versions v WHERE v.path = ? AND v.is_current = 1`,
      path,
    )[0];
    return row === undefined ? null : toVersion(row);
  }

  /** Every version written at a path, oldest first, the current one last. */
  history(path: string): IndexedVersion[] {
    return this.#exec<VersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM versions v WHERE v.path = ? ORDER BY v.commit_seq`,
      path,
    ).map(toVersion);
  }

  /** The version the vault held at a path at an instant (ingestion time), if any. */
  versionAt(path: string, at: number): IndexedVersion | null {
    const row = this.#exec<VersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM versions v
       WHERE v.path = ? AND v.recorded_at <= ? AND (v.replaced_at IS NULL OR v.replaced_at > ?)
       ORDER BY v.commit_seq DESC LIMIT 1`,
      path,
      at,
      at,
    )[0];
    return row === undefined ? null : toVersion(row);
  }

  /** Full-text search, best first. Current versions only, unless `asOf` asks for the past. */
  search(text: string, options: SearchOptions = {}): SearchHit[] {
    const query = ftsQuery(text);
    if (query === null) return [];
    const filters: string[] = [];
    const bindings: SqlValue[] = [query];
    if (options.asOf === undefined) {
      filters.push("v.is_current = 1");
    } else {
      filters.push("v.recorded_at <= ? AND (v.replaced_at IS NULL OR v.replaced_at > ?)");
      bindings.push(options.asOf, options.asOf);
    }
    if (options.validAt !== undefined) {
      filters.push("(v.valid_from IS NULL OR v.valid_from <= ?)");
      filters.push("(v.invalid_at IS NULL OR v.invalid_at > ?)");
      bindings.push(options.validAt, options.validAt);
    }
    bindings.push(options.limit ?? 10);
    return this.#exec<{
      path: string;
      commit_sha: string;
      title: string;
      abstract: string | null;
      is_current: number;
    }>(
      `SELECT v.path, v.commit_sha, v.title, v.abstract, v.is_current
       FROM versions_fts JOIN versions v ON v.rowid = versions_fts.rowid
       WHERE versions_fts MATCH ? AND ${filters.join(" AND ")}
       ORDER BY bm25(versions_fts, 4.0, 2.0, 1.0, 2.0), v.path
       LIMIT ?`,
      ...bindings,
    ).map((row) => ({
      path: row.path,
      commit: row.commit_sha,
      title: row.title,
      abstract: row.abstract,
      current: row.is_current === 1,
    }));
  }

  /**
   * Resolves a link as Obsidian does: a path names one note; a file name is searched vault-wide,
   * preferring the linking note's folder, then the shortest path.
   */
  resolve(from: string, by: LinkBy, target: string): string | null {
    const candidates = this.#exec<{ path: string }>(
      `SELECT path FROM versions WHERE is_current = 1 AND ${by === "path" ? "link_path" : "link_name"} = ?`,
      target,
    ).map((row) => row.path);
    if (candidates.length <= 1) return candidates[0] ?? null;
    const folder = from.slice(0, from.lastIndexOf("/") + 1);
    const rank = (path: string) => [
      path.slice(0, path.lastIndexOf("/") + 1) === folder ? 0 : 1,
      path.split("/").length,
      path.length,
    ];
    return (
      candidates.sort((a, b) => {
        const [ra, rb] = [rank(a), rank(b)];
        for (let i = 0; i < ra.length; i += 1) {
          const diff = (ra[i] ?? 0) - (rb[i] ?? 0);
          if (diff !== 0) return diff;
        }
        return a < b ? -1 : 1;
      })[0] ?? null
    );
  }

  /** The current version's links, each resolved against the current vault. */
  links(path: string): ResolvedLink[] {
    return this.#exec<{ kind: string; by: string; target: string }>(
      `SELECT l.kind, l.by, l.target FROM links l JOIN versions v ON v.rowid = l.version
       WHERE v.path = ? AND v.is_current = 1 ORDER BY l.kind, l.by, l.target`,
      path,
    ).map((row) => ({
      kind: row.kind as LinkKind,
      by: row.by as LinkBy,
      target: row.target,
      path: this.resolve(path, row.by as LinkBy, row.target),
    }));
  }

  /** Current notes whose links resolve to this path. */
  backlinks(path: string): string[] {
    const { linkPath, linkName } = linkKeys(path);
    const rows = this.#exec<{ path: string; by: string; target: string }>(
      `SELECT DISTINCT v.path, l.by, l.target FROM links l JOIN versions v ON v.rowid = l.version
       WHERE v.is_current = 1
         AND ((l.by = 'path' AND l.target = ?) OR (l.by = 'name' AND l.target = ?))
       ORDER BY v.path`,
      linkPath,
      linkName,
    );
    const sources = rows
      .filter((row) => this.resolve(row.path, row.by as LinkBy, row.target) === path)
      .map((row) => row.path);
    return [...new Set(sources)];
  }

  dump(): IndexDump {
    return {
      commits: this.#exec<{ sha: string; seq: number; committed_at: number }>(
        "SELECT sha, seq, committed_at FROM commits ORDER BY seq",
      ).map((row) => ({ sha: row.sha, seq: row.seq, committedAt: row.committed_at })),
      versions: this.#exec<VersionRow>(
        `SELECT ${VERSION_COLUMNS} FROM versions v ORDER BY v.path, v.commit_seq`,
      ).map(toVersion),
      entities: this.#exec<{ path: string; commit: string; key: string; name: string }>(
        `SELECT v.path, v.commit_sha AS "commit", e.key, e.name
         FROM entities e JOIN versions v ON v.rowid = e.version
         ORDER BY v.path, v.commit_seq, e.key`,
      ),
      links: this.#exec<{ path: string; commit: string; kind: string; by: string; target: string }>(
        `SELECT v.path, v.commit_sha AS "commit", l.kind, l.by, l.target
         FROM links l JOIN versions v ON v.rowid = l.version
         ORDER BY v.path, v.commit_seq, l.kind, l.by, l.target`,
      ),
    };
  }
}
