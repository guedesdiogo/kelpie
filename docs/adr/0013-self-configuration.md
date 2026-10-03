# ADR-0013: Kelpie configures itself through its agents

- Status: Accepted
- Date: 2026-10-03
- Issue: [#47](https://github.com/guedesdiogo/kelpie/issues/47)

## Context

The owner set a principle: once Kelpie is online with the minimum data it needs (at least one model configured), the owner should be able to talk to it, or configure the first channel, and from then on Kelpie should configure as much of the rest as possible by itself.

## Decision

- **Bootstrap minimum:** a deploy, the owner's identity (registered through a one-time bootstrap link) and one model key (a secret the owner sets). The owner then talks to a built-in setup agent in the webchat, which doubles as the setup console.
- **One code path for every configuration change.** Changes are typed configuration commands, such as create an agent, connect a channel, invite a user, grant access, connect a tool or MCP server, or change a model or budget. The admin API, the future management UI and the agents' own tools all call the same commands with the same permission checks. Every change is audited as "requested by user X through agent Y".
- **Who can configure:** only the owner and admins can ask an agent to change configuration (ADR-0004). Members can't.
- **Confirmation:** a change that affects access, cost or external accounts needs an explicit yes in the conversation before the agent runs it. That covers granting access, connecting a channel or tool, and changing the model or budget. Smaller changes, such as names, draft persona edits or schedules, run directly and are audited. Jev's authorization decision (ADR-0009) may flag ambiguous requests, but the yes always comes from a person.
- **Secrets never pass through chat.** When a step needs a secret, such as a bot token or an API key, the command returns a one-time secure form link. The secret goes straight into the encrypted store and never enters the conversation history or the model's context.
- **Limits:**
  - the agent can't change the Cloudflare deployment itself (Workers, bindings, Hyperdrive), because it holds no Cloudflare token at runtime; those steps are a documented checklist;
  - persona and skill changes still go through pull requests (ADR-0005).

## Consequences

- Phase 1 gains Story 3.11 (first-run bootstrap). Story 3.7 (webchat) doubles as the setup console, and Story 3.10 becomes the configuration commands.
- The management UI (phase 3) is a second client of the same commands, not a separate implementation.
- Tests cover:
  - the bootstrap running only once;
  - the setup agent refusing non-owners;
  - no secret ever appearing in a transcript;
  - confirmation being asked before every change to access, cost or external accounts.

## Alternatives considered

- **A configuration UI first, with the agent added later.** Two implementations of every change, and the agent would lag behind.
- **Secrets pasted in chat.** Simpler, but the secret would pass through the channel provider and the model, and would have to be scrubbed from history.

## References

- [ADR-0004](0004-access-control.md), [ADR-0005](0005-context-store.md), [ADR-0009](0009-qualifier-and-jev.md)
- [Story 3.11 (#48)](https://github.com/guedesdiogo/kelpie/issues/48), [Story 3.10 (#43)](https://github.com/guedesdiogo/kelpie/issues/43)
