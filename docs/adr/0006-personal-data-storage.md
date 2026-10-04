# ADR-0006: Personal data lives in a Durable Object per user, outside git

- Status: Accepted
- Date: 2026-10-03
- Issue: [#4](https://github.com/guedesdiogo/kelpie/issues/4)
- Amended by: [ADR-0015](0015-single-player-first.md) for phase 1 (single-player)

## Context

The original brief kept user profiles alongside the rest of the agent's context, as versioned Markdown in GitHub and/or Obsidian. Git history is immutable in practice: forks, caches and clones keep deleted content. That conflicts with the right to erasure under the LGPD (Brazil's data protection law) and the GDPR. Colleagues using an internal instance are still data subjects.

The research offered three ways to keep personal data out of git:
- revisions in Postgres served as virtual Markdown files;
- a Durable Object per user plus R2;
- per-user encrypted files in git, with the key destroyed on erasure.

## Decision

- User profiles, user facts and conversation episodes live in a Durable Object per user, with larger files in R2.
- Retrieval uses FTS5 inside that object and Vectorize for embeddings.
- The Context Store exposes this data as virtual Markdown files that the user and admins can read, edit and export.
- Nothing personal is committed to the context repository ([ADR-0005](0005-context-store.md)).

## Consequences

- Erasing a user is a workflow, not one call. It deletes or pseudonymizes:
  - the user's Durable Object storage, R2 objects and vectors (a separate step);
  - the user's messages in conversation Durable Objects and in R2 archives;
  - their identity, grant and projection rows in Postgres, with audit rows pseudonymized;
  - their KV routing entries.
- Some copies are outside Kelpie's reach for a while: Durable Object point-in-time recovery keeps deleted data for 30 days, and model providers keep logs and backups under their own terms. The privacy notes must say so.
- This choice gives up the single transactional `DELETE` that keeping personal data in Postgres would have allowed, which the cross-check preferred once Postgres was in scope.
- Each user's data is physically isolated in its own object, which helps against leakage between colleagues.
- A personal-data gate (sanitizer first, Jev only on already-masked text) runs before anything is written to git.

## Alternatives considered

- **Postgres revisions as virtual files.** Erasure in one transaction, but it puts personal data in the external database.
- **Encrypted files in git.** Meets the brief literally, but the files can't be read or diffed in GitHub or Obsidian.
- **Plain Markdown in git.** Can't honor erasure requests.

## References

- [Viability study §4.7, §4.9](../viability-study.md#47-data)
- [Research 02 §3, §5.3, §6](../research/02-memory-and-learning.md)
- [Research 08: "LGPD/GDPR"](../research/08-database-and-context-storage.md)
- [Research 00 §1C item 1](../research/00-cross-check.md)
