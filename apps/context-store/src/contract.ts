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
}
