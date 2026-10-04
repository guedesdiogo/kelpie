# ADR-0005: A Context Store worker versions agent context in a private GitHub repository

- Status: Accepted
- Date: 2026-10-03
- Issue: [#7](https://github.com/guedesdiogo/kelpie/issues/7)
- Amended by: [ADR-0016](0016-vault-second-brain.md), the vault's layout, Hermes's memory files (merged per entry), the persona in `SOUL.md` and the owner's own profile

## Context

Persona, rules, skills and agent knowledge must be files that people and other agents can read and edit. They must be versioned, preferably in GitHub and/or Obsidian, behind a dedicated worker so that agents never deal with storage.

The relevant facts:
- **GitHub:** `createCommitOnBranch` writes many files in one call, with `expectedHeadOid` for optimistic concurrency. GitHub allows about 80 content-creating requests per minute and 500 per hour, and it does not redeliver failed webhooks.
- **Obsidian:** Obsidian Sync has no public API, and its headless client is a Node CLI that can't run in Workers. The obsidian-git plugin works on desktop.
- **Other options:** R2 has no object versioning. Cloudflare Artifacts is Git-compatible, but it entered open beta on 2026-10-01 and its binding can't write.

## Decision

- The `context-store` Worker is the only component that reads or writes context storage. Agents call it over RPC.
- The canonical backend is one private GitHub repository per instance, accessed through a GitHub App. A Durable Object keeps the working copy, so agents read their own writes immediately.
- Writes are batched into `createCommitOnBranch` calls. Human edits arrive through the push webhook and merge three-way per file, and a reconciliation cron covers missed webhooks.
- Persona, rules and skills change only through pull requests a human approves.
- Skills follow the Agent Skills format (`SKILL.md`), and agent instructions follow `AGENTS.md`.
- The Context Store filters what it returns by the user's content scopes ([ADR-0004](0004-access-control.md)).
- Personal data never enters the repository ([ADR-0006](0006-personal-data-storage.md)).
- The backend sits behind an interface. Artifacts can become a second backend later.

## Consequences

- People edit context on GitHub, in any editor, or in Obsidian through obsidian-git (desktop only).
- Agents may write freely to the working copy; what reaches the persona goes through review.
- A spike confirms that `createCommitOnBranch` works from a Worker through a GitHub App.

## Alternatives considered

- **R2 with homemade versioning.** Reinvents git without its tooling.
- **Obsidian Sync.** No API, and its client needs Node.
- **Artifacts as the canonical store.** A beta product with a read-only binding and no GitHub mirror.
- **One repository per agent.** Breaks reuse of shared skills and multiplies credentials.

## References

- [Viability study §4.8](../viability-study.md#48-context-the-context-store-worker)
- [Research 08: (B) options, "Context Store worker design", "Folder layout"](../research/08-database-and-context-storage.md)
- [Research 00: C12, C15](../research/00-cross-check.md)
