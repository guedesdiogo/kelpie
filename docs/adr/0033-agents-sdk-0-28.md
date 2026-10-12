# ADR-0033: conversation-runtime runs on Agents SDK 0.28.0, and adopts none of its new features

- Status: Accepted
- Date: 2026-10-12
- Issue: [#266](https://github.com/guedesdiogo/kelpie/issues/266)
- Requested by the owner on 2026-10-12: «pode fazer»

## Context

[ADR-0002](0002-runtime-foundation.md) pins the Agents SDK and gives each upgrade contract tests and an ADR. This is the first upgrade since the SDK came in, at 0.26.0.

What Kelpie uses of the SDK, all in `apps/conversation-runtime`:
- `ConversationAgent` and `AgentHost` extend `Agent`.
- **Schedules over the one alarm:** `schedule`, `getScheduleById`, `cancelSchedule` and `getSchedules`, for flushes, session closes, checkpoints and notes.
- **Durable fibers:** `startFiber`, `deleteFibers` and `onFiberRecovered`, for the turn.
- **The webchat socket:** `onConnect`, `onMessage`, `getConnections` and connection state, with `sendIdentityOnConnect: false`, no protocol messages, and read-only connections.

Routing is the Durable Object namespace's own `getByName`, not the SDK's. Kelpie doesn't use `keepAlive`, the agent's `setState`, the MCP client, Channels or the harnesses.

The npm package ships no changelog, so this reads `packages/agents/CHANGELOG.md` at the `agents@0.28.0` tag:
- **0.27.0** (2026-10-07): four experimental harnesses, `agents/websearch`, and `agents/channels` moved to `agents/experimental/channels` (breaking). `WebSockets` gains `use`. `removeMcpServer()` clears the server's OAuth state. Fixes in Streams, Tasks, `useAgentChat`, `WebChannelClient`, x402 and `agents tui`.
- **0.28.0** (2026-10-09): `agents/lifecycle`, the Scheduler, State, WebSockets and `MCPClientManager` become stable. New `browserTool` and `agents/webfetch`. ThinkHarness keeps its sessions in `agents/harness/store`.

## Decision

`agents` is pinned to exactly 0.28.0. Kelpie's code doesn't change.

**The changes that touch what Kelpie uses, and what was checked:**

| Change | What was checked |
|---|---|
| Scheduler and Lifecycle become stable (0.28.0) | `Agent.schedule()` delegates to them. Their compiled code differs from 0.26.0 only in doc comments. A new test covers several schedules on the one alarm. |
| `WebSockets.use` (0.27.0) | Handlers added with `use` run before the configured ones. Kelpie adds none, and the compiled change only loops over that empty list first. The webchat suite passes, and a new test covers what a page's SDK frames can do. |
| State becomes stable (0.28.0) | Kelpie keeps no SDK state. Its compiled code differs only in doc comments. |
| `removeMcpServer()` clears OAuth state (0.27.0) | `AgentHost` connects no MCP server yet, so nothing calls it. |
| A routed Task wake with no owner ends quietly (0.27.0) | Kelpie uses no Tasks. |

Everything else is in entry points Kelpie doesn't import.

**Beyond the changelog,** the two compiled packages were compared:
- The chunk that holds `Agent`, fibers included, is identical apart from chunk names.
- The runtime dependencies are the same. Only optional `@opencode/*` peers were added.
- The types Kelpie imports didn't change, and typecheck passes.

**The contract tests,** on the real SDK in workerd:
- **Schedules:** `ConversationAgent schedules` (new). Two due schedules, armed against their time order, run on one alarm in time order, and the alarm is re-armed for the later one.
- **Fiber recovery:** `ConversationAgent recovery` and the tool loop's eviction tests evict mid-turn and fire the fiber's alarm; `onFiberRecovered` picks the turn up.
- **Webchat frames:** a socket gets only Kelpie's `history` frame when it opens, with no SDK identity or state. A new test sends the SDK's state and RPC frames from a page: no state is written and no method runs.

**Rollback safety.** The SDK's tables (`cf_agents_jobs`, `cf_agents_fibers`, `cf_agents_runs` and the others) are created by the same statements in both versions. The only new tables belong to `agents/harness/store` and ThinkHarness, which Kelpie doesn't load. A rollback to a 0.26.0 build reads storage written by 0.28.0, so it is not a rollback barrier ([ADR-0029](0029-continuous-deployment-and-rollback.md)).

**Not adopted:** the MCP client, the `browser`, `web_fetch` and `web_search` tools, the harnesses, Channels, `WebSockets.use`, and Lifecycle capabilities used directly. Each would take its own story.

## Consequences

- No change in behaviour is expected. The deploy's watch and automatic rollback apply as for any merge.
- The two new tests stay for later upgrades.
- A page that sends the SDK's own frames gets the SDK's error frames back: `cf_agent_state_error`, or a failed `rpc`. They carry no state or identity.

## Alternatives considered

- **Staying on 0.26.0.** The SDK moves fast, and each skipped release makes the next upgrade larger.
- **Adopting the now-stable Scheduler or WebSockets directly.** `Agent`'s methods remain the stable surface, and Kelpie's code needs no change to keep using them.

## References

- [ADR-0002](0002-runtime-foundation.md): SDK versions are pinned, and each upgrade gets contract tests and an ADR
- [ADR-0029](0029-continuous-deployment-and-rollback.md): rollbacks and their barriers
- [Agents SDK changelog at `agents@0.28.0`](https://github.com/cloudflare/agents/blob/48d9c36f5f1ff18a91fbf0659b9a8e026d1cac43/packages/agents/CHANGELOG.md)
- [Changes from 0.26.0 to 0.28.0](https://github.com/cloudflare/agents/compare/74570a19aafc676dd85831a31af047817e7bba12...48d9c36f5f1ff18a91fbf0659b9a8e026d1cac43)
