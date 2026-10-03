# ADR-0012: Drizzle ORM is the data layer for Postgres and Durable Object SQLite

- Status: Accepted
- Date: 2026-10-03
- Issue: [#46](https://github.com/guedesdiogo/kelpie/issues/46)

## Context

ADR-0007 chose Postgres via Hyperdrive as the system of record, with the provider chosen by configuration. It didn't choose how code talks to the database. Kelpie has two stores: Postgres (users, identities, grants, tasks, audit) and the SQLite inside each Durable Object (conversation and agent state).

Facts checked on 2026-10-03:
- **Hyperdrive guides:** official guides exist for Drizzle ORM, Prisma ORM (through `@prisma/adapter-pg`), node-postgres and postgres.js.
- **Drizzle (`drizzle-orm` 0.45.3):** exports drivers for postgres.js, node-postgres, D1 and `durable-sqlite`. That last one is the SQLite of Durable Objects.
- **Kysely:** Hyperdrive's postgres.js guide notes that Kysely sets `prepare: false`, so Hyperdrive can't cache its prepared statements and needs extra round trips.
- **Prisma:** its `latest` tag was 8.0.0-rc.19, a release candidate. Support for Durable Object SQLite was not confirmed.

## Decision

- Drizzle ORM is the data layer for both stores:
  - Postgres through Hyperdrive, with the postgres.js driver;
  - Durable Object SQLite through `drizzle-orm/durable-sqlite`.
- Schemas are written in TypeScript. drizzle-kit generates the migrations: for Postgres they run in CI and deploy; for Durable Objects they are applied in the object's constructor under `blockConcurrencyWhile`.
- The Drizzle version is pinned, because the library is pre-1.0.
- Queries live in each module's repository layer, so domain modules never import Drizzle (ADR-0002).
- Every Postgres provider allowed by ADR-0007 uses the same Postgres dialect. Switching providers stays a configuration change.

## Consequences

- One schema language and one migration tool cover both stores, with types from schema to query.
- Upgrades follow Drizzle's changelog, with an ADR if the API changes materially.
- The raw SQL in the phase 0 `DebounceBuffer` gets ported when the `ConversationAgent` replaces it (Story 3.3).

## Alternatives considered

- **Prisma.** Mature, but heavier, a major version in release candidate, and no confirmed Durable Object SQLite path.
- **Kysely.** A query builder with no schema generator, and the Hyperdrive prepared-statement caveat.
- **Plain SQL.** No dependency, but types written by hand for every query.

## References

- [Hyperdrive: Drizzle ORM](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/drizzle-orm/)
- [Hyperdrive: postgres.js](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/postgres-js/)
- [ADR-0007](0007-system-of-record-database.md)
