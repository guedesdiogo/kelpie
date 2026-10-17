// What other Workers call on the Context Store, through a service binding to `ContextStore`.

/** A skill, as its `SKILL.md` frontmatter describes it (Agent Skills). */
export interface SkillEntry {
  name: string;
  description: string;
  path: string;
}

/** The context a turn needs from the vault (ADR-0005, ADR-0016). */
export interface CompiledContext {
  /** `agents/<agent>/SOUL.md`, or null when the vault has none. */
  persona: string | null;
  /** The shared `AGENTS.md`, then the agent's own, when present. */
  rules: { path: string; content: string }[];
  skills: SkillEntry[];
}

/** What a proposal changes: the agent's persona, its rules, or one of its skills. */
export type ProposalTarget =
  | { kind: "persona" }
  | { kind: "rules" }
  | { kind: "skill"; name: string };

export type WriteResult =
  | { ok: true }
  | { ok: false; reason: "vault_off" | "invalid_path" | "too_large" };

export type ProposeResult =
  | { ok: true; url: string }
  | {
      ok: false;
      reason: "vault_off" | "invalid_target" | "unchanged" | "rate_limited" | "failed";
    };

/**
 * A file pushed with conflict markers, kept out of Kelpie's writes (#114): waiting on the model
 * (`held`, with how many tries it has had) or on a pull request with its resolution (`proposed`).
 */
export interface HeldFile {
  path: string;
  state: "held" | "proposed";
  attempts: number;
  at: number;
}

/**
 * What `forget` did: how many of the Context Store's rows named the paths, now gone, and which of
 * the paths the vault still has, as when the rewritten history wasn't pushed.
 */
export type ForgetResult =
  | { ok: true; forgotten: number; stillInVault: string[] }
  | { ok: false; reason: "vault_off" | "invalid_input" | "unavailable" };

/** What a turn asks memory for (#110). */
export interface RecallOptions {
  /**
   * The scopes the turn may see: `"all"` for the owner's direct chat, or a list such as
   * `["conversation/telegram-123"]`, a turn's own conversation, for any other (#131). Required, so
   * no caller gets every scope by default.
   */
  scopes: readonly string[] | "all";
  /** The packed block's budget, in tokens of four characters; at most 8,000. */
  budgetTokens: number;
  /** Ingestion time: what memory held then. */
  asOf?: number;
  /** World time: only memories valid then. */
  validAt?: number;
  /** The agent's qualifier, which reranks the best hits: Clef unless the agent chose Jev. */
  qualifier?: "clef" | "jev";
}

/** Memory for one turn: a block of reference text within the budget, and the notes in it. */
export interface RecallResult {
  text: string;
  tokens: number;
  paths: string[];
  /**
   * The same notes, each with its provenance (#126): `byKelpie` while the vault holds a version
   * Kelpie's own commit wrote, its lines merged into an owner's edit included. An edit from
   * elsewhere, or a conflict the model resolved from the file's own lines, is the owner's.
   */
  notes: { path: string; byKelpie: boolean }[];
}

/** The always-loaded core (#112), as one block within the budget, and the notes in it. */
export interface MemoryCoreResult {
  text: string;
  tokens: number;
  paths: string[];
  /** How many notes didn't fit. */
  omitted: number;
}

/** What the agent's `memory_search` asks (#126): retrieval as recall does, without the packing. */
export interface MemorySearchOptions {
  /** The scopes the turn may see, as for recall. */
  scopes: readonly string[] | "all";
  /** How many notes: 3 when left out, 10 at most. */
  k?: number;
  asOf?: number;
  validAt?: number;
  qualifier?: "clef" | "jev";
}

/** A note `search` found, best first. There is no score: the order is the answer. */
export interface MemoryHit {
  path: string;
  title: string;
  abstract: string | null;
  kind: string;
  scope: string;
  /** World time, in epoch milliseconds. */
  validFrom: number | null;
  invalidAt: number | null;
  /** False for a version an "as of" search found that the vault has replaced since. */
  current: boolean;
  /** As in `RecallResult.notes`. */
  byKelpie: boolean;
  /**
   * The version `writeNote` takes back to change the note (#297). Null when the hit shows a version
   * the vault has replaced, or a queued write is about to: the note must be read first.
   */
  version: string | null;
}

/** The hits, or why there are none to give: memory off, or failing, isn't empty memory. */
export type MemorySearchResult =
  | {
      ok: true;
      /** The hits as the model reads them, in #110's fence; empty when there are none. */
      text: string;
      notes: MemoryHit[];
    }
  | { ok: false; reason: "vault_off" | "unavailable" };

/** What the agent's `memory_read` asks (#126). */
export interface ReadNoteOptions {
  /** The scopes the turn may see, as for recall. */
  scopes: readonly string[] | "all";
  /** Where the page starts in the note's body, as `nextOffset` gave it; 0 when left out. */
  offset?: number;
}

/**
 * A page of a note, fenced, under 10,000 characters, and where the next one starts. A note outside
 * the scopes, outside memory's index, or missing is the same "not found". `version` is the
 * version the page shows, which `writeNote` takes back (#297).
 */
export type ReadNoteResult =
  | { ok: true; path: string; text: string; nextOffset: number | null; version: string }
  | { ok: false; reason: "not_found" | "vault_off" | "unavailable" };

/** A memory as the agent's `memory_write` gives it (#126). */
export interface MemoryWriteInput {
  title: string;
  /** Markdown, without the title heading. */
  body: string;
  /** One of memory's kinds: `note`, `person`, `preference`… */
  kind: string;
  /** `explicit` when the person said it, `deduced` or `inferred` when Kelpie concluded it. */
  level: string;
  /** 0 to 1; 0.8 when left out. */
  confidence?: number;
  /** `global` when left out; it must be one the turn may write. */
  scope?: string;
  entities?: string[];
  validFrom?: string;
  invalidAt?: string;
  abstract?: string;
  /** A note found with search or read: the memory becomes its new version. */
  path?: string;
  /**
   * Required with `path`: the version search or read showed, or the last write returned (#297). A
   * note changed since is `changed`, and nothing is written.
   */
  version?: string;
}

export interface WriteNoteOptions {
  /** The scopes the turn may see, as for recall. */
  scopes: readonly string[] | "all";
  /** Where the memory came from, given by the runtime, never by the model. */
  sources: readonly string[];
  /** The agent's qualifier, asked in the shadow (#149): Clef unless the agent chose Jev. */
  qualifier?: "clef" | "jev";
}

/**
 * What `writeNote` did. `unchanged` names the note that already says it. Either way, `version` is
 * the note's version now, for the next write to it. `invalid` lists what the memory gets wrong,
 * for the model to fix; a path the turn can't see, outside memory, or missing is `not_found`.
 */
export type WriteNoteResult =
  | { ok: true; action: "written" | "unchanged"; path: string; version: string }
  | { ok: false; reason: "invalid"; problems: string[] }
  | {
      ok: false;
      /**
       * `owners_word`: a deduced or inferred memory can't change a note the person stated.
       * `core_note`: no memory changes a note the always-loaded core carries (#168).
       * `changed`: the note changed since the version the memory names (#297).
       */
      reason:
        | "not_found"
        | "changed"
        | "scope_not_allowed"
        | "owners_word"
        | "core_note"
        | "too_large"
        | "vault_off"
        | "unavailable";
    };

export interface ContextStoreContract {
  /** Empty when the vault is off. */
  compile(agentId: string): Promise<CompiledContext>;
  read(path: string): Promise<string | null>;
  /**
   * Writes or removes memory and knowledge files (a null content removes). They are committed in a
   * batch shortly after; reads see them at once. Persona, rules and skills go through `propose`.
   */
  write(
    agentId: string,
    changes: { path: string; content: string | null }[],
    summary: string,
  ): Promise<WriteResult>;
  /**
   * Opens a pull request for the owner to approve (ADR-0020 §5: approval on, the default). The same
   * change proposed again returns the first pull request; at most 10 are opened an hour.
   */
  propose(
    agentId: string,
    target: ProposalTarget,
    content: string,
    reason: string,
  ): Promise<ProposeResult>;
  /**
   * The memories that answer a question, packed for the turn (#110): retrieval with the question's
   * vector, reranked by the qualifier, within the budget. An empty block when the vault is off.
   */
  recall(agentId: string, question: string, options: RecallOptions): Promise<RecallResult>;
  /**
   * The always-loaded core (#112): the notes the owner pinned in the global scope or the agent's
   * own, the owner's profile and the agent's self-model, within the budget (at most 8,000 tokens).
   * It counts no access. An empty block when the vault is off, or on any failure.
   */
  core(agentId: string, budgetTokens: number): Promise<MemoryCoreResult>;
  /**
   * The notes that answer a query, for the agent's `memory_search` (#126): the same retrieval as
   * recall, returned as hits. Nothing when the vault is off or the input isn't valid.
   */
  search(agentId: string, query: string, options: MemorySearchOptions): Promise<MemorySearchResult>;
  /**
   * A note of memory's index, a page at a time, for the agent's `memory_read` (#126): only within
   * the scopes, with the links they allow on the first page, which counts as one access.
   */
  readNote(agentId: string, path: string, options: ReadNoteOptions): Promise<ReadNoteResult>;
  /**
   * The single writer behind the agent's `memory_write` (#126): a new memory, or a found note's new
   * version, checked, sanitized and queued like any write. The same memory again changes nothing.
   */
  writeNote(
    agentId: string,
    input: MemoryWriteInput,
    options: WriteNoteOptions,
  ): Promise<WriteNoteResult>;
}

/**
 * The owner's actions on the vault (#114), on an entrypoint of their own that only admin-api binds:
 * the Workers that run conversations, where prompt injection lands, can't reach them.
 */
export interface ContextStoreAdminContract {
  /** Files pushed with conflict markers that still wait, for the owner to see. */
  held(): Promise<HeldFile[]>;
  /**
   * After the owner rewrote the vault's history to erase content: Kelpie forgets its own copies.
   * Memory's index is rebuilt from the vault as it is now, and the rows that name `paths` go; a
   * path ending in `/` names a folder. Git is never touched.
   */
  forget(paths: string[]): Promise<ForgetResult>;
  /**
   * Turns Dream off, or back on (#112): one setting for the vault, `dry` until the owner says
   * otherwise. `writes` names the operations that may write; the others only propose. Off forgets
   * them.
   */
  setDream(mode: "off" | "dry", writes?: readonly string[]): Promise<SetDreamResult>;
}

/** With the operations that may write, each dry until the owner names it (`abstracts`). */
export type SetDreamResult =
  | { ok: true; mode: "off" | "dry"; writes: string[] }
  | { ok: false; reason: "invalid" };

/** An actor as ingress builds it from the Directory's admission (ADR-0058 §2). */
export interface FilesActor {
  userId: string;
  role: string;
  via: string;
}

/** One of an agent's own files that isn't a skill (ADR-0058 §2). */
export type AgentFileKind = "soul" | "rules" | "memory";

/** A file as the editor reads it: its text, and the version a save names back. */
export interface AgentFileState {
  content: string;
  /** Git's blob SHA of `content`. */
  version: string;
}

/** Where an installed skill came from, as the Vault object recorded it. */
export type SkillOrigin =
  | {
      kind: "github";
      owner: string;
      repo: string;
      ref: string | null;
      path: string;
      commit: string;
    }
  | { kind: "archive"; filename: string }
  | { kind: "text" }
  | { kind: "created" };

/** One of the agent's own skills: `agents/<id>/skills/<name>/SKILL.md`. */
export interface AgentSkillState extends AgentFileState {
  name: string;
  description: string;
  /** Null for a skill the editor didn't write, as one added on GitHub. */
  origin: SkillOrigin | null;
  /** An installed skill whose `SKILL.md` changed since it was installed. */
  edited: boolean;
}

export interface AgentFilesState {
  soul: AgentFileState | null;
  rules: AgentFileState | null;
  memory: AgentFileState | null;
  skills: AgentSkillState[];
}

export type AgentFilesResult =
  | { ok: true; files: AgentFilesState }
  | { ok: false; reason: "vault_off" | "forbidden" | "invalid_input" | "unavailable" };

/**
 * A change one Save makes, with the version the editor started from (null for a file the vault
 * didn't have). A null content removes the file: rules, or a whole skill.
 */
export type AgentFileChange =
  | { file: AgentFileKind; content: string | null; version: string | null }
  | { file: "skill"; name: string; content: string | null; version: string | null }
  | {
      file: "install";
      /** What `fetchSkill` staged, and the hash the owner reviewed. */
      staged: string;
      hash: string;
      /** The `SKILL.md` it replaces, as the editor read it, or null for a new skill. */
      version: string | null;
    };

/** What became of one change: saved, or why not. A conflict shows the newer version. */
export type AgentFileOutcome =
  | { status: "saved"; version: string | null }
  | { status: "conflict"; current: AgentFileState | null }
  | {
      status: "refused";
      reason:
        | "invalid"
        | "too_large"
        | "held"
        | "memory_format"
        | "memory_too_long"
        | "skill_invalid"
        | "staged_gone"
        /** A staged skill whose scan blocked it: hidden characters. */
        | "blocked";
    };

export type SaveAgentFilesResult =
  | {
      ok: true;
      /** One per change, in the save's order. */
      outcomes: AgentFileOutcome[];
      /** The commit, or null when nothing was written. */
      commit: string | null;
      /** The changes that put back what this save replaced, for Undo. */
      undo: AgentFileChange[];
      files: AgentFilesState;
    }
  | { ok: false; reason: "vault_off" | "forbidden" | "invalid_input" | "unavailable" };

/** Where a skill to stage comes from (ADR-0058 §5). */
export type SkillSourceInput =
  | { kind: "github"; url: string }
  | { kind: "archive"; filename: string; bytes: Uint8Array }
  | { kind: "text"; content: string }
  /** The installed skill's branch or tag again, for "Look for an update". */
  | { kind: "update"; name: string };

/** A skill staged for the owner's review, outside the vault. */
export interface StagedSkill {
  id: string;
  name: string;
  description: string;
  origin: SkillOrigin;
  /** Every file kept, `SKILL.md` first, relative to the skill's folder. */
  files: { path: string; bytes: number; script: boolean; binary: boolean }[];
  /** The files left out: hidden ones, such as `.DS_Store`. */
  leftOut: { path: string; why: "hidden" }[];
  skillMd: string;
  bytes: number;
  hash: string;
  scan: {
    verdict: "clean" | "caution" | "blocked";
    findings: { path: string; line: number; kind: string; excerpt: string }[];
    more: number;
  };
  /** The skill of the same name it would replace, if the agent has one. */
  replaces: {
    version: string;
    /** Changed since it was installed, so the owner's edits would go. */
    edited: boolean;
    /** Each file that differs from what is installed now, when the Vault object knows it. */
    changes: { path: string; change: "added" | "changed" | "removed" }[];
    /** The `SKILL.md`'s lines, as a difference from the one in the vault. */
    diff: { op: "=" | "+" | "-"; text: string }[];
  } | null;
}

export type FetchSkillResult =
  | { ok: true; staged: StagedSkill }
  | {
      ok: false;
      reason:
        | "vault_off"
        | "forbidden"
        | "invalid_input"
        | "invalid_address"
        | "not_found"
        | "unreachable"
        | "too_large"
        | "too_many_files"
        | "not_zip"
        | "no_skill"
        | "many_skills"
        | "unsafe_path"
        | "link"
        | "encrypted"
        | "invalid_skill"
        | "up_to_date"
        | "no_source"
        | "unavailable";
      /** The path at fault, the skills an archive holds, or what a `SKILL.md` gets wrong. */
      detail?: string;
      names?: string[];
    };

/**
 * The owner's edits of one agent's own files from the webchat (ADR-0058), on an entrypoint only
 * ingress binds. It reaches `SOUL.md`, `AGENTS.md`, `memories/MEMORY.md` and `skills/<name>/` under
 * `agents/<id>/`, and nothing else in the vault.
 */
export interface AgentFilesContract {
  files(actor: FilesActor, agentId: string): Promise<AgentFilesResult>;
  /** Every change in one commit, with `Kelpie-Via: webchat`; a newer version is a conflict. */
  save(
    actor: FilesActor,
    agentId: string,
    changes: AgentFileChange[],
  ): Promise<SaveAgentFilesResult>;
  /** Fetches, checks and stages a skill for the owner's review, outside the vault, for an hour. */
  fetchSkill(
    actor: FilesActor,
    agentId: string,
    source: SkillSourceInput,
  ): Promise<FetchSkillResult>;
}
