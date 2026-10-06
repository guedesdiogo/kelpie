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

/** What a turn asks memory for (#110). */
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

/** What `forget` did: how many of the Context Store's rows named the paths, now gone. */
export type ForgetResult =
  | { ok: true; forgotten: number }
  | { ok: false; reason: "vault_off" | "invalid_input" };

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
  /** Files pushed with conflict markers that still wait (#114), for the owner to see. */
  held(): Promise<HeldFile[]>;
  /**
   * After the owner rewrote the vault's history to erase content (#114): Kelpie forgets its own
   * copies. Memory's index is rebuilt from the vault as it is now, and the rows that name `paths`
   * go. Git is never touched.
   */
  forget(paths: string[]): Promise<ForgetResult>;
}
