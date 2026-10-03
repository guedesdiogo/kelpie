# ADR-0002: The Agents SDK and one Durable Object per conversation form the runtime

- Status: Accepted
- Date: 2026-10-03
- Issue: [#8](https://github.com/guedesdiogo/kelpie/issues/8)

## Context

A chat turn needs ordering, dedupe of webhook retries, durable timers for buffering and pacing, and cancellation when the user writes again mid-reply. On Cloudflare:
- Queues don't guarantee order and deliver at least once.
- Workflows add a hop per step.
- A Durable Object gives single-threaded execution, strongly consistent SQLite and alarms with millisecond precision.
- A Durable Object has only one alarm, an alarm handler is limited to 15 minutes, and an idle object is evicted after 70–140 s.

The Agents SDK's `Agent` class multiplexes schedules over that single alarm. It also provides durable fibers with idempotency keys, a remote MCP client with OAuth, sub-agents and a bridge to Workflows. The SDK moves fast: v0.3.7 in February 2026, v0.26 in October, with deprecations along the way.

## Decision

- The hot path of every conversation runs in one `ConversationAgent` Durable Object, which extends `Agent`:
  - dedupe through a unique provider message id;
  - debounce through a re-armed alarm, never `setTimeout`;
  - the turn as a durable fiber;
  - a persisted outbox for paced replies;
  - a generation counter for interruption, preempt-and-merge by default.
- One `AgentHost` Durable Object per agent holds configuration, MCP connections, schedules and the budget.
- Queues carry only idempotent side effects (memory, projections, versioning). Workflows carry long or human-in-the-loop work.
- Domain modules (`Buffer`, `Splitter`, `Outbox`, `InterruptPolicy`) import nothing from the SDK, and SDK versions are pinned.
- The SDK's Think and Messengers layers are not used.
- About ten Workers with narrow jobs: `ingress`, `conversation-runtime`, `channel-egress`, `llm-gateway`, `tools-gateway`, `context-store`, `memory-jobs`, `projector`, `admin-api` / `admin-ui`.

## Consequences

- Ordering and cancellation live in one place and are testable without the network.
- Eviction mid-turn is survivable: recovery resends only outbox entries still `pending`.
- Each SDK upgrade gets contract tests and an ADR. `keepAlive` (experimental) sits behind an adapter.
- Cost depends on Durable Objects hibernating. A spike confirms that a scheduled alarm doesn't keep an object awake (US$ 5 vs US$ 18 per month in the small scenario).

## Alternatives considered

- **Plain Durable Objects without the SDK.** Full control, but reimplementing schedules, fiber recovery and MCP OAuth adds no value to the project.
- **Queue or Workflow per message.** No ordering guarantee in one case, latency and per-step billing in the other.
- **Think and Messengers.** Messengers supports only Telegram and replies by editing one streamed message, which contradicts separate paced bubbles. Think imposes its own memory model, which conflicts with [ADR-0005](0005-context-store.md).

## References

- [Viability study §4.2–§4.4](../viability-study.md#42-the-hot-path-one-durable-object-per-conversation)
- [Research 05: "Agents SDK: use it or not", "Proposed event-driven flow", "Decomposition into workers"](../research/05-cloudflare-limits-and-architecture.md)
- [Research 00: C2 (alarms and hibernation)](../research/00-cross-check.md)
