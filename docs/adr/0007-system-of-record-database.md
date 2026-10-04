# ADR-0007: Postgres via Hyperdrive is the system of record, with the provider chosen by configuration

- Status: Accepted
- Date: 2026-10-03
- Issue: [#6](https://github.com/guedesdiogo/kelpie/issues/6)
- Amended by: [ADR-0015](0015-single-player-first.md) for phase 1 (single-player)

## Context

The owner asked not to be limited to D1. The options studied:
- **Neon via Hyperdrive:** free tier with scale-to-zero and no weekly pause, branching, pgvector.
- **Supabase:** its free tier pauses after a week without use.
- **PlanetScale Postgres:** no free tier, from US$ 5/month, billed by Cloudflare.
- **D1:** single-threaded, 10 GB per database, static bindings.
- **Turso.**

Cloudflare has no managed Postgres of its own. Two Hyperdrive facts matter: its query cache is on by default and is not invalidated by writes, and its pool runs in transaction mode.

The owner also set a rule for the open-source project: be open to more than one provider, but not to anything; pick one for the first version, and build it so that adding another is easy and configurable.

## Decision

- Postgres is the system of record for users, channel identities, grants, agents, channels, audit and projections, reached through Hyperdrive.
- Neon is the first provider. A `PostgresProvider` configuration value selects the provider, so Supabase and PlanetScale adapters can be added later. Provider-specific features stay usable inside their adapter.
- Hot conversation state stays in Durable Object SQLite ([ADR-0002](0002-runtime-foundation.md)). Personal data stays in per-user Durable Objects ([ADR-0006](0006-personal-data-storage.md)).
- Data that must not be stale goes through a cache-disabled Hyperdrive binding.
- The hot path doesn't depend on Postgres: `ingress` reads the `Directory` Durable Object ([ADR-0004](0004-access-control.md)), and conversations run on Durable Object state.
- The D1-only profile is out.

## Consequences

- Switching providers is mostly a connection string, because all three sit behind Hyperdrive.
- CI can use a Neon branch per pull request.
- The first query after scale-to-zero pays a cold start (duration unmeasured).
- The same pattern (one adapter first, a configurable interface) applies to every connector. It is recorded as a design rule in `CLAUDE.md`.

## Alternatives considered

- **D1 + Durable Objects only.** No external vendor, but erasure takes two steps, D1 caps at 10 GB per database, and cross-entity reporting is harder. Dropped by the owner.
- **Supabase first.** The weekly pause hurts a demo that reviewers open occasionally.
- **Turso.** Durable Object SQLite gives the same database-per-entity pattern without another vendor.

## References

- [Viability study §6](../viability-study.md#6-database-options)
- [Research 08: (A) database comparison](../research/08-database-and-context-storage.md)
- [Research 00: C11 (Hyperdrive cache)](../research/00-cross-check.md)
