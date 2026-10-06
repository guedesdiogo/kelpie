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
   * The scopes the turn may see, such as `["global", "conversation/telegram-123"]`, or `"all"` for
   * a private chat with the owner. Required, so no caller gets every scope by default.
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
}

export interface MemorySearchResult {
  notes: MemoryHit[];
}

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
   * The notes that answer a query, for the agent's `memory_search` (#126): the same retrieval as
   * recall, returned as hits. Nothing when the vault is off or the input isn't valid.
   */
  search(agentId: string, query: string, options: MemorySearchOptions): Promise<MemorySearchResult>;
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
}
