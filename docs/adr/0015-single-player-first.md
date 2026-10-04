# ADR-0015: Kelpie is single-player until multi-user lands, with seams for it

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

The scope of this decision is the time **until multi-user lands** ([Epic 7](https://github.com/guedesdiogo/kelpie/issues/60)), however many delivery phases that covers. It is not tied to phase 1.

- **Only the owner talks to agents,** on their enabled channel identities.
  - Enabling an identity still takes a pairing step that proves it belongs to the owner.
  - The owner reaches every agent and every content scope.
- **Where state lives without Postgres:**
  - the `Directory` Durable Object holds the owner, the owner's identities and the audit log of access changes;
  - each agent's `AgentHost` holds that agent's configuration, its channels and its task board ([ADR-0011](0011-agent-task-board.md)), with no projection into Postgres;
  - the registry of which agents exist is designed in Story 3.10;
  - the `projector` worker (ADR-0002) waits for Postgres.
- **Postgres is added when a feature needs it,** such as multi-user or the task board's projections, and that feature's ADR says so. [ADR-0012](0012-drizzle-data-layer.md) already applies to Durable Object SQLite; its Postgres part applies when Postgres arrives.
- **Groups.** Channels ignore group chats. A group event is acknowledged and dropped, like an unknown sender.
- **Configuration** is done by the owner only. [ADR-0013](0013-self-configuration.md)'s commands that invite users or grant access wait for multi-user.
- **Personal data.** It is the owner's own, plus whatever third parties appear in the owner's conversations.
  - The per-user Durable Object ([ADR-0006](0006-personal-data-storage.md)) stays, keyed by the owner's `userId`.
  - Erasure covers two cases: the owner's data, and a third party's request about the owner's conversations, which deletes or pseudonymizes that content in conversation storage and archives.
  - Erasure for colleagues returns with multi-user.
- **Seams.** These are binding, so that multi-user is an addition, not a rewrite:
  - every message and record carries the `userId` of its author, not one per conversation: memory, conversations, tasks, outbox and audit;
  - access goes only through `admit(identity, agentId)`. Its result, `Admission`, is either `{ admitted: true, userId, role }` or `{ admitted: false, reason }`, where `reason` is `"unknown_identity"`, `"no_grant"` or `"group_chat"`;
  - `ingress` calls `admit` before anything wakes, and the conversation passes the admitted `userId` and `role` along;
  - owner-only checks, such as configuration commands, test `role === "owner"` from that result, never an id compared with a stored owner id;
  - the Context Store keeps its content-scope parameter, filled with every scope for the owner;
  - no code reads "the only user" from a global.

This changes the following earlier decisions until multi-user lands:
- [ADR-0001](0001-single-tenant-self-hosted.md): one instance serves the owner alone, not internal users.
- [ADR-0003](0003-channel-adapters.md): direct conversations only.
- [ADR-0004](0004-access-control.md): the allowlist holds only the owner's identities. Roles, grants and content scopes wait.
- [ADR-0006](0006-personal-data-storage.md): erasure as described above.
- [ADR-0007](0007-system-of-record-database.md): no Postgres until a feature needs it.
- [ADR-0011](0011-agent-task-board.md): the people on the board are the owner, and the board has no Postgres projection.
- ADR-0012: only the Durable Object SQLite part applies.
- ADR-0013: owner-only commands.

## Consequences

- Story 3.5 becomes the owner's allowlist, and no Neon project is needed until Postgres returns.
  - The multi-user code already written is kept on branch `park/multi-user-access`: the Postgres schema, an `AccessService` with versioned pushes to the `Directory`, and the review findings it still has to address. Epic 7 starts from it.
- Stories 3.6 and 3.7 handle direct conversations only, Story 3.10's commands are owner-only, and Story 3.11 bootstraps the owner.
- The README says that Kelpie is single-user for now and that multi-user has no date.
- Work partners can't use the agents until multi-user lands.

## Alternatives considered

- **Keep multi-user now.** Work partners could use the agents sooner, but the first version would carry the consistency and personal-data risks above.
- **Single-player without seams.** Faster now, but multi-user would mean reworking the data model, memory scoping and every access check.

## References

- [Decision 3.14 (#59)](https://github.com/guedesdiogo/kelpie/issues/59), [Epic 7 (#60)](https://github.com/guedesdiogo/kelpie/issues/60)
- Viability study [§2](../viability-study.md#2-scope), [§4.6](../viability-study.md#46-users-and-access-control), [§4.7](../viability-study.md#47-data), [§13](../viability-study.md#13-delivery-plan)
