# ADR-0016: The context vault is the owner's second brain, usable without Kelpie and shared with Hermes

- Status: Accepted
- Date: 2026-10-04
- Issue: [#58](https://github.com/guedesdiogo/kelpie/issues/58)
- Amended by: [ADR-0020](0020-shared-memory-engine.md), third parties' data may enter the vault, an agent may change its own persona, rules or skills when that item's approval is off, and sharing goes through the single writer instead of symlinks and git sync

## Context

The owner wants the GitHub and Obsidian vault to be a second brain: they add content and context to the agents' "brain" by hand, and read and edit it by hand too. It should be independent of Kelpie while still essential to it, so they can switch platforms, or run Kelpie alongside other tools, such as Hermes Agent pointed at the same files.

[ADR-0005](0005-context-store.md) already makes the private GitHub repository the canonical store, behind a `context-store` Worker. It doesn't say that the vault must work without Kelpie. Nor does it say how another agent's files fit in.

A reference check of Hermes Agent at `a4648c5` (2026-10-03; findings on [#41](https://github.com/guedesdiogo/kelpie/issues/41)) found constraints that ADR-0005's defaults would break:
- **Memory format.** Hermes keeps `MEMORY.md` and `USER.md` as entries joined by exactly `\n§\n`, within 2,200 and 1,375 characters.
  - If blank lines appear around `§`, or an entry is oversized, its drift guard refuses further writes.
  - Frontmatter would merge into the first entry.
  - A line-based three-way merge can break the format.
- **Two automatic writers.** Hermes warns that two writers on one memory file compound entries.
- **No commits.** Hermes writes files but never commits them.
- **Persona.** Hermes reads the persona from `SOUL.md`. Story 3.8 had called it `AGENTS.md`.

The owner's answers, on 2026-10-04, to the questions on [#58](https://github.com/guedesdiogo/kelpie/issues/58):
- Hermes's memory format;
- `SOUL.md` for the persona;
- every edit made outside Kelpie counts as the owner's own;
- their own profile may live in the vault.

On writes, they added that the agent shouldn't ask for pull requests itself: a Worker of Kelpie's own should do the pull requests and the sync, transparently to the agent.

## Decision

- **The vault belongs to the owner and works without Kelpie.**
  - It is plain Markdown, Agent Skills (`SKILL.md`), `AGENTS.md` and Hermes's file names.
  - Kelpie-specific files are optional and documented.
  - Every index (full text, embeddings) is derived from the vault and can be rebuilt from it. Removing Kelpie loses no knowledge.
  - The exceptions are secrets, colleagues' personal data and operational state, which never enter the vault.
- **Layout.** Story 3.8 may refine paths, as long as the file names and formats hold. The vault's `README.md` documents the layout for people and for other agents.

  ```
  README.md           how the vault works, for people and other agents
  AGENTS.md           operational rules for every agent
  USER.md             the owner's profile, in Hermes's format (opt-in)
  index.md, log.md    navigation and change log (OKF, Hermes's llm-wiki)
  knowledge/          free-form notes; [[wikilinks]] are followed
  skills/             <category>/<name>/SKILL.md, found recursively
  agents/<agent-id>/
    SOUL.md           the agent's persona
    AGENTS.md         optional rules that override the shared ones
    memories/MEMORY.md
    skills/
  ```
- **Hermes's memory files keep Hermes's format exactly.**
  - `MEMORY.md` and `USER.md` are entries joined by `\n§\n`, within 2,200 and 1,375 characters, with no frontmatter.
  - Kelpie merges them per entry: entries are compared whole, identical ones kept once, and removals from a common base honored. It never writes them over the limit.
  - Every other file merges three-way per file (ADR-0005).
- **Any Markdown the owner adds to `knowledge/` becomes context,** with no required structure. Frontmatter is optional everywhere except Hermes's memory files.
- **Kelpie writes only through the `context-store` Worker.** The agent calls Context Store tools and never sees Git, a commit or a pull request.
  - **Memory, knowledge and `log.md`:** the Worker commits directly, in small commits. `createCommitOnBranch` takes no author, so a message trailer (`Kelpie-Agent: <agent-id>`) names the agent. Knowledge pages may carry OKF's `generated: {by, at}`.
  - **`SOUL.md`, `AGENTS.md` and skills:** the agent proposes, and the Worker opens a pull request for the owner to approve (ADR-0005). An agent never rewrites its own persona or rules.
- **Every write made outside Kelpie counts as the owner's manual edit.** That covers GitHub, Obsidian, any editor and Hermes.
  - These edits go straight to the branch.
  - Kelpie merges them and never force-pushes.
  - Hermes doesn't commit, so its edits reach Kelpie only once the owner's clone pushes them, for example through obsidian-git or a scheduled push.
- **One automatic writer per memory file.** A Kelpie agent and a Hermes profile share a `MEMORY.md` only if Hermes runs with `write_approval: true`; otherwise each keeps its own file.
- **The owner's `USER.md` may live in the vault, as an opt-in.**
  - The owner is the data subject, and accepts that git history keeps what was committed: erasing it means rewriting history.
  - Colleagues' profiles, facts and episodes stay in their Durable Objects ([ADR-0006](0006-personal-data-storage.md)).
  - Kelpie's own writes pass the personal-data gate, and never put a third party's personal data in the vault.

This amends:
- **ADR-0005:**
  - Hermes's memory files merge per entry;
  - the persona file is `SOUL.md`;
  - the owner's profile is the one piece of personal data allowed in the repository.
- **ADR-0006:** the owner's own profile may live in the vault, as an opt-in.

## Consequences

- **Pointing Hermes at the vault.** Symlink a profile's `SOUL.md` and `memories/` files into the vault, because Hermes's atomic writes keep symlinks. Add the vault's `skills/` to `external_dirs`, with `skills.write_approval: true` or the folder read-only.
  - Never make the vault `HERMES_HOME`: it holds `.env`, `auth.json` and `state.db`.
  - The vault's `README.md` carries these steps.
- **Story 3.8 (#41)** gains:
  - the per-entry merge for Hermes's memory files, and their size limits;
  - recursive skill discovery;
  - the `README.md`, `index.md` and `log.md`;
  - attributed commits;
  - a test that an edit made outside Kelpie reaches the next turn.
- **The owner's profile has two homes depending on the opt-in:** the vault's `USER.md`, or their per-user Durable Object. The memory API hides which one is in use.
- **The spike on `createCommitOnBranch` (#28)** confirms whether commits can carry the trailer and how a stale head is refused.

## Alternatives considered

- **Kelpie's own format for memory files** (frontmatter, line merge). Hermes would stop writing to them, and the shared memory would be lost.
- **Separate memory files for Kelpie and Hermes.** No conflicts, but neither learns from the other.
- **Hermes read-only.** Simpler, but Hermes would no longer feed the second brain.
- **`AGENTS.md` as the persona.** It is the coding agents' convention for rules, and Hermes doesn't read it as a persona.
- **Keeping all personal data out of the vault** (ADR-0006 unchanged). Hermes couldn't see the owner's profile, which defeats part of the second brain.

## References

- [#58](https://github.com/guedesdiogo/kelpie/issues/58): the proposal and the owner's answers.
- [#41](https://github.com/guedesdiogo/kelpie/issues/41): the reference check, with links pinned to Hermes Agent `a4648c5` and ai-memory `a98a0c4`.
- [Research 08: "Folder layout", "External human edit flow"](../research/08-database-and-context-storage.md)
- [Research 01: Hermes memory and skills](../research/01-hermes-agent-and-bot-mode.md)
