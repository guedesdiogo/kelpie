# ADR-0015: Phase 1 is single-player, with seams for multi-user

- Status: Accepted
- Date: 2026-10-03
- Issue: [#59](https://github.com/guedesdiogo/kelpie/issues/59)

## Context

The approved scope served the owner and their work partners: roles, grants per agent and per content, Postgres as the system of record, and a `Directory` Durable Object kept in step with it ([ADR-0004](0004-access-control.md), [ADR-0007](0007-system-of-record-database.md)). Building that in Story 3.5 showed where the cost sits. Three reviews of the code found their main risks in keeping Postgres and the `Directory` consistent: version regression after a restore, a lock held across the push, a connection shared by concurrent operations, and personal data leaking through database errors.

The owner then asked to build the whole platform as single-player first and leave multiple users for later, to simplify the first version. Their answers to the follow-up questions:
- single player, with seams so that multi-user can come later without a rewrite;
- multi-user has no date, and returns when there is a real need;
- Postgres is deferred until it is needed;
- direct conversations only.

## Decision

- **Only the owner talks to agents in phase 1,** on their enabled channel identities.
  - The `Directory` Durable Object is the source of truth for those identities.
  - Enabling an identity still takes a pairing step that proves it belongs to the owner.
  - The owner reaches every agent.
- **Seams that stay, so multi-user is an addition, not a rewrite:**
  - every record carries a `userId`: memory, conversations, tasks, outbox and audit;
  - access decisions go only through `admit(identity, agentId)` and its `Admission` result;
  - the Context Store keeps its content-scope parameter, which v1 always fills with the owner's scope;
  - no code reads "the only user" from a global; it receives a `userId`.
- **Postponed until multi-user returns** ([Epic 7](https://github.com/guedesdiogo/kelpie/issues/60)):
  - colleagues as users, with roles (owner, admin, member);
  - grants per agent and per content;
  - group chats and the group-memory rule;
  - the erasure workflow for colleagues;
  - admins in the configuration commands.
- **Postgres is deferred until a feature needs it:** multi-user, or the task board's projections. Until then, state lives in Durable Objects. ADR-0012's choice of Drizzle for Durable Object SQLite applies from phase 1; its Postgres part applies when Postgres arrives.
- **Groups.** Channels ignore group chats in phase 1. A group event is acknowledged and dropped, like an unknown sender.
- **Configuration** is done by the owner only.

What this changes in earlier decisions, for phase 1:
- [ADR-0003](0003-channel-adapters.md): direct conversations only.
- [ADR-0004](0004-access-control.md): the allowlist holds only the owner's identities. Roles, grants and content scopes wait for multi-user.
- [ADR-0006](0006-personal-data-storage.md): the per-user Durable Object stays, keyed by the owner's `userId`. The erasure workflow for colleagues waits for multi-user.
- [ADR-0007](0007-system-of-record-database.md): Postgres is not part of phase 1.
- [ADR-0011](0011-agent-task-board.md): the people on the board are the owner, and the board lives in `AgentHost` until Postgres arrives for its projections.
- ADR-0013 (self-configuration, in review in [#56](https://github.com/guedesdiogo/kelpie/pull/56)): owner-only.

## Consequences

- Story 3.5 becomes the owner's allowlist, and phase 1 no longer needs a Neon project.
  - The multi-user code already written is kept on branch `park/multi-user-access`: the Postgres schema, an `AccessService` with versioned pushes to the `Directory`, and the review findings it still has to address. Epic 7 starts from it.
- Stories 3.6 and 3.7 handle direct conversations only, Story 3.10's commands are owner-only, and Story 3.11 bootstraps the owner.
- The README says that the first version is single-user.
- Work partners can't use the agents until multi-user returns.

## Alternatives considered

- **Keep multi-user in phase 1.** Work partners could use the agents sooner, but phase 1 carries the consistency and personal-data risks above.
- **Single-player without seams.** Faster now, but multi-user would mean reworking the data model, memory scoping and every access check.

## References

- [Decision 3.14 (#59)](https://github.com/guedesdiogo/kelpie/issues/59), [Epic 7 (#60)](https://github.com/guedesdiogo/kelpie/issues/60)
- [Viability study §2, §13](../viability-study.md#2-scope)
