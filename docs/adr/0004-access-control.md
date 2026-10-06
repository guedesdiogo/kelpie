# ADR-0004: Only allowlisted users on enabled channel identities can reach an agent

- Status: Accepted
- Date: 2026-10-03
- Issue: [#13](https://github.com/guedesdiogo/kelpie/issues/13)
- Amended by: [ADR-0015](0015-single-player-first.md), until multi-user lands (single-player); [ADR-0023](0023-webchat-access-login.md), the webchat logs in with the owner's Access identity, with no pairing of its own

## Context

Kelpie is for internal use ([ADR-0001](0001-single-tenant-self-hosted.md)). The owner set two rules:
- to talk to an agent, a user must be configured and the channel they use must be enabled for them;
- which users reach which agents and which content must be manageable, as in a company where each agent is an extra employee.

No research note covered this.

## Decision

- **Users** are created by the owner or an admin. Each user has one or more **channel identities** (Telegram user id, WhatsApp number, Slack user id, webchat login). Each identity is enabled separately, after a pairing step that proves it belongs to the user.
- **Roles:** owner, admin and member. Owners and admins manage users, identities and grants.
- **Grants** name the agents a user may talk to, and the content scopes they may read or edit (shared knowledge folders, an agent's private notes).
- **Enforcement:**
  - `ingress` drops messages from identities that are not enabled, before any Durable Object wakes or any model is called;
  - the conversation Durable Object checks the user's grant for the agent;
  - the Context Store filters context by content scope;
  - memory is per user.
- **Groups:** an agent in a group chat uses only memories that every participant may see. This rule is ours; research note 02 proposes a separate group scope, which can coexist with it.
- **Storage:** Postgres is the system of record for users, identities, grants and audit ([ADR-0007](0007-system-of-record-database.md)). The hot path doesn't query it. `ingress` reads a `Directory` Durable Object that holds the enabled identities and grants, kept in sync by the admin API. It is strongly consistent, so a revocation applies to the next message, and Neon's scale-to-zero cold start never sits in front of a user. KV is not used for the allowlist, because it can lag by up to 60 s.

## Consequences

- Unknown senders cost one Durable Object lookup and nothing else, which also limits spam and abuse. A single `Directory` object is far below the soft limit of 1,000 requests per second per object for internal use.
- Group memory selection is the main leakage risk, so it gets adversarial tests.
- Three points are settled in the phase that implements them:
  - the pairing flow per channel (one-time code, admin approval);
  - how users see and correct their own memory (an LGPD access right);
  - admin authentication for the management UI.

## Alternatives considered

- **Open channels with per-message moderation.** Contradicts internal use and costs model calls for strangers.
- **Agent-level allowlists only, without content scopes.** Simpler, but every user of an agent would see all of its knowledge.

## References

- [Viability study §4.6](../viability-study.md#46-users-and-access-control)
- [Research 02 §5.2: leakage across users and groups](../research/02-memory-and-learning.md)
