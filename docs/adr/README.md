# Architecture decision records

Each file records one decision: its context, the decision, its consequences and the alternatives considered. Decisions are binding. Changing one takes a new ADR that supersedes it, or that amends part of it for a stated scope; the amended ADR then gets an `Amended by` line. The evidence behind the first set is the [viability study](../viability-study.md) and its [research notes](../research/).

| ADR | Decision | Issue |
|---|---|---|
| [0001](0001-single-tenant-self-hosted.md) | Single-tenant, self-hosted, internal use | [#12](https://github.com/guedesdiogo/kelpie/issues/12) |
| [0002](0002-runtime-foundation.md) | Agents SDK and a Durable Object per conversation | [#8](https://github.com/guedesdiogo/kelpie/issues/8) |
| [0003](0003-channel-adapters.md) | Own channel adapters and the channel order | [#9](https://github.com/guedesdiogo/kelpie/issues/9) |
| [0004](0004-access-control.md) | Allowlisted users, channel identities and grants | [#13](https://github.com/guedesdiogo/kelpie/issues/13) |
| [0005](0005-context-store.md) | Context Store over a private GitHub repository | [#7](https://github.com/guedesdiogo/kelpie/issues/7) |
| [0006](0006-personal-data-storage.md) | Personal data in a Durable Object per user | [#4](https://github.com/guedesdiogo/kelpie/issues/4) |
| [0007](0007-system-of-record-database.md) | Postgres via Hyperdrive, provider by configuration | [#6](https://github.com/guedesdiogo/kelpie/issues/6) |
| [0008](0008-llm-authentication.md) | API keys, plus an owner-only subscription opt-in | [#3](https://github.com/guedesdiogo/kelpie/issues/3) |
| [0009](0009-qualifier-and-jev.md) | Jev preferred, never required | [#5](https://github.com/guedesdiogo/kelpie/issues/5) |
| [0010](0010-monorepo-tooling.md) | Bun workspaces, strict TypeScript, Biome and Vitest with the Workers plugin | [#23](https://github.com/guedesdiogo/kelpie/issues/23) |
| [0011](0011-agent-task-board.md) | Agents run and report their work on Kelpie's own task board | [#44](https://github.com/guedesdiogo/kelpie/issues/44) |
| [0012](0012-drizzle-data-layer.md) | Drizzle ORM (node-postgres over Hyperdrive) for Postgres and Durable Object SQLite | [#46](https://github.com/guedesdiogo/kelpie/issues/46) |
| [0013](0013-self-configuration.md) | Kelpie configures itself through its agents | [#47](https://github.com/guedesdiogo/kelpie/issues/47) |
| [0014](0014-agent-tool-scope.md) | Assistants with a browser, no machine execution | [#18](https://github.com/guedesdiogo/kelpie/issues/18) |
| [0015](0015-single-player-first.md) | Single-player until multi-user lands, with seams for it | [#59](https://github.com/guedesdiogo/kelpie/issues/59) |
| [0016](0016-vault-second-brain.md) | The vault is the owner's second brain, usable without Kelpie and shared with Hermes | [#58](https://github.com/guedesdiogo/kelpie/issues/58) |
| [0017](0017-history-compaction.md) | Long conversations are bounded by Kelpie's own summary checkpoints | [#64](https://github.com/guedesdiogo/kelpie/issues/64) |
| [0018](0018-jev-direct-api.md) | Jev goes through TypeSafe's API first, and end of turn uses thresholds per qualifier | [#27](https://github.com/guedesdiogo/kelpie/issues/27) |
| [0019](0019-llm-gateway-keys.md) | The keys llm-gateway uses to call providers are deploy secrets | [#101](https://github.com/guedesdiogo/kelpie/issues/101) |
| [0020](0020-shared-memory-engine.md) | Kelpie's memory is its own engine on Workers, modelled on ai-memory, over the owner's vault | [#105](https://github.com/guedesdiogo/kelpie/issues/105) |
| [0021](0021-vault-app-secrets.md) | The vault's GitHub App credentials are deploy secrets on context-store | [#41](https://github.com/guedesdiogo/kelpie/issues/41) |
| [0022](0022-clef-qualifier.md) | Each agent chooses its end-of-turn qualifier, Clef on Workers AI by default, Jev as the option | [#117](https://github.com/guedesdiogo/kelpie/issues/117) |

## Format

```markdown
# ADR-NNNN: <decision as a short statement>

- Status: Proposed | Accepted | Superseded by ADR-NNNN
- Date: YYYY-MM-DD
- Issue: <link>
- Amended by: ADR-NNNN, <scope> (optional)

## Context
## Decision
## Consequences
## Alternatives considered
## References
```
