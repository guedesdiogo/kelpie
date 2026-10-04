# ADR-0012: Drizzle ORM is the data layer for Postgres and Durable Object SQLite

- Status: Accepted
- Date: 2026-10-03
- Issue: [#46](https://github.com/guedesdiogo/kelpie/issues/46)
- Amended by: [ADR-0015](0015-single-player-first.md), until multi-user lands (single-player)

## Context

ADR-0007 chose Postgres via Hyperdrive as the system of record, with the provider chosen by configuration, but not how code talks to the database. Kelpie has two stores:
- Postgres, for users, identities, grants, tasks and audit;
- the SQLite inside each Durable Object, for conversation and agent state.

Facts checked on 2026-10-03:
- **Hyperdrive and Drizzle.** Hyperdrive has official guides for Drizzle ORM, Prisma ORM (through `@prisma/adapter-pg`), node-postgres and Postgres.js.
  - The Drizzle guide uses node-postgres (`pg`). It says Drizzle with the Postgres.js driver over Hyperdrive "is not currently supported".
  - Hyperdrive recommends node-postgres in general, as the driver most compatible with its caching.
  - Database drivers need the `nodejs_compat` compatibility flag.
- **Drizzle (`drizzle-orm` 0.45.3).** It exports drivers for node-postgres, Postgres.js, D1 and `durable-sqlite`, the SQLite of Durable Objects. A 1.0 line is in beta and release candidate on npm.
- **Prisma.** Its `latest` tag was 8.0.0-rc.19, a release candidate. Support for Durable Object SQLite was not confirmed.

## Decision

- Drizzle ORM is the data layer for both stores:
  - Postgres through Hyperdrive, with the node-postgres driver (`pg`) and one client per request, as the Hyperdrive guide shows;
  - Durable Object SQLite through `drizzle-orm/durable-sqlite`.
- Schemas are written in TypeScript, and drizzle-kit generates the migrations:
  - for Postgres, they run in CI and at deploy;
  - for Durable Objects, they are applied in the object's constructor under `blockConcurrencyWhile`.
- `drizzle-orm` (on the 0.45 line) and `drizzle-kit` are pinned to exact versions, because the library is pre-1.0.
- Queries live in each module's repository layer, so domain modules never import Drizzle (ADR-0002).
- Every Postgres provider allowed by ADR-0007 uses the same Postgres dialect. Switching providers stays a configuration change.

## Consequences

- One schema language and one migration tool cover both stores, with types from schema to query.
- Workers that talk to Postgres enable `nodejs_compat`.
- Upgrades follow Drizzle's changelog. Moving to 1.0, or any material API change, takes an ADR.
- The raw SQL in the phase 0 `DebounceBuffer` gets ported when the `ConversationAgent` replaces it (Story 3.3).

## Alternatives considered

- **Drizzle with Postgres.js.** Not supported over Hyperdrive, according to the Hyperdrive guide.
- **Prisma.** Mature, but heavier, a major version still in release candidate, and no confirmed path for Durable Object SQLite.
- **Kysely.** A query builder with no schema or migration generator.
- **Plain SQL.** No dependency, but types written by hand for every query.

## References

- [Hyperdrive: Drizzle ORM](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/drizzle-orm/)
- [Hyperdrive: connect to Postgres (driver recommendation)](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/)
- [ADR-0007](0007-system-of-record-database.md)
