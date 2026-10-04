# ADR-0013: Kelpie configures itself through its agents

- Status: Accepted
- Date: 2026-10-03
- Issue: [#47](https://github.com/guedesdiogo/kelpie/issues/47)

## Context

The owner set a principle: once Kelpie is online with the minimum it needs (at least one model configured), the owner should be able to talk to it or configure the first channel. From then on, Kelpie should configure as much of the rest as possible by itself.

## Decision

- **Bootstrap minimum:**
  - a deploy;
  - one model key, as a secret the owner sets;
  - the owner's identity, registered through a bootstrap link.

  The bootstrap link carries a one-time token that the owner generates and sets as a secret at deploy. The token includes its own expiry time. It works once, and the bootstrap endpoint stays disabled after the owner registers. The owner then talks to a built-in setup agent in the webchat, which doubles as the setup console.
- **One code path for every configuration change.**
  - Changes are typed configuration commands: create an agent, connect a channel, invite a user, grant access, connect a tool or MCP server, change a model or budget.
  - The admin API, the future management UI and the agents' own tools all call the same commands, with the same permission checks.
  - Every change is audited as "requested by user X through agent Y".
- **Who can configure:**
  - Only the owner and admins can ask an agent to change configuration (ADR-0004). Members can't.
  - Only the owner can promote or remove admins and turn on the subscription opt-in (ADR-0008).
- **Confirmation.**
  - A change that affects access, cost or external accounts needs an explicit yes before the agent runs it. That covers granting access, connecting a channel or tool, and changing the model or budget.
  - The yes must come from the owner or admin who asked, in the same conversation. In a group, nobody else's answer counts. During a background task (ADR-0011), the agent moves the task to Waiting and asks the requester.
  - Content from tools, web pages, documents or other agents never triggers a configuration command and never counts as a yes.
  - Smaller changes, such as names, draft persona edits or schedules, run directly and are audited.
  - The qualifier (Jev when configured, ADR-0009) may flag an ambiguous request, but the yes always comes from a person.
- **Secrets never pass through chat.**
  - When a step needs a secret, such as a bot token or an API key, the command returns a one-time secure form link.
  - The secret goes straight into Kelpie's secret store, a Durable Object holding values encrypted at the application level (AES-GCM) under a key kept as a Worker secret.
  - It never enters the conversation history or the model's context.
  - This narrows ADR-0001 and viability study §2, which place platform secrets in Worker secrets or the Secrets Store. Those stay for what the owner sets at deploy: the first model key, the bootstrap token and the encryption key. Code running at runtime can't write Worker secrets without a Cloudflare token, and it has none.
- **Limits:**
  - The agent can't change the Cloudflare deployment itself (Workers, bindings, Hyperdrive), because it holds no Cloudflare token at runtime. Those steps are a documented checklist.
  - Persona and skill changes still go through pull requests (ADR-0005).

## Consequences

- Phase 1 gains Story 3.11 (first-run bootstrap). Story 3.7 (webchat) doubles as the setup console, and Story 3.10 becomes the configuration commands.
- The management UI (phase 3) is a second client of the same commands, not a separate implementation.
- Tests cover:
  - the bootstrap running only once, and its link expiring;
  - the setup agent refusing members, and refusing owner-only commands from admins;
  - no secret ever appearing in a transcript;
  - confirmation being asked before every change to access, cost or external accounts, and only the requester's yes counting;
  - tool output never triggering a configuration command.

## Alternatives considered

- **A configuration UI first, with the agent added later.** Every change would be implemented twice, and the agent would lag behind.
- **Secrets pasted in chat.** Simpler, but the secret would pass through the channel provider and the model, and would have to be scrubbed from history.

## References

- [ADR-0001](0001-single-tenant-self-hosted.md), [ADR-0004](0004-access-control.md), [ADR-0005](0005-context-store.md), [ADR-0008](0008-llm-authentication.md), [ADR-0009](0009-qualifier-and-jev.md), [ADR-0011](0011-agent-task-board.md)
- [Story 3.11 (#48)](https://github.com/guedesdiogo/kelpie/issues/48), [Story 3.10 (#43)](https://github.com/guedesdiogo/kelpie/issues/43)
