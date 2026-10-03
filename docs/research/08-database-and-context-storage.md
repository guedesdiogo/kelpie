> Research note written on 2026-10-03 for the Kelpie viability study, translated from Portuguese. Corrections across notes are tracked in [00-cross-check.md](00-cross-check.md).

# 08 — Database and storage for the AI's context

> Read-only research, done on 2026-10-03. Nothing was created in Cloudflare, GitHub, Neon, Supabase, Turso or any other service.
> **Conventions.** Every claim about a limit, price or capability has its URL next to it. "(unverified)" marks what I did not confirm in a source. "(third-party source)" marks a blog, aggregator or post that is not official documentation. Numbers read from pricing pages reflect what was published on this date and may change.

---

## TL;DR

**(A) Database: hybrid architecture, with one point of attention on multi-tenancy.**

- **Hot state:** Durable Objects SQLite, via the Agents SDK (`this.sql`), with one instance per tenant × agent and, when it makes sense, per conversation. This is Cloudflare's native answer to "one database per tenant".
- **System of record:** Postgres via Hyperdrive, with **Neon** as the default. The reasons: a free tier with scale-to-zero and no weekly pause, branching per PR, and pgvector included. Postgres holds tenants, users, agents, channels, usage, audit, memories with embeddings, and the Context Store index.
- **Blobs** go in **R2**, **metrics** in **Analytics Engine**, and **events for exact reports** go to Postgres or **Basin Pipelines → Iceberg on R2**.
- **D1** is still useful as a single control-plane database in the "100% Cloudflare" profile. It is not good as a per-tenant database: the documentation only shows static bindings, one per database in wrangler.
- **The rule that matters most:** with Hyperdrive, every tenant query carries an explicit `tenant_id` and goes through a binding **without cache**. RLS stays as defense in depth, inside a transaction.

**(B) Context in `.md` files: the agent only talks to a Context Store worker. GitHub is the source of truth today; Cloudflare Artifacts comes in as a second backend.**

- **Where each thing lives:**
  - Working copy and manifest: in one DO per tenant, which gives read-your-own-writes.
  - Canonical: one private repo per tenant, via a GitHub App.
  - Commits: batched via `createCommitOnBranch`, with `expectedHeadOid` for optimistic concurrency.
  - Human edits: arrive through a push webhook and get a per-file 3-way merge.
  - Embedding reindexing: via Queue.
- **Obsidian:** the path that works today is **obsidian-git → tenant repo**, desktop only. Obsidian Headless Sync is a Node 22 CLI and does not run in Workers without a container.
- **Cloudflare Artifacts is not a rumor.** It has been in open beta since 2026-10-01 and is Git compatible. Against it: it requires Workers Paid, billing starts on 2026-10-14, the binding and REST are read-only (writing requires the git protocol), the import is one-time and public repos only, and there is no documented mirroring to GitHub.
- **LGPD (Brazil's General Data Protection Law):** end-user PII (profiles and memories) **does not go into git**. It stays in Postgres or the DO, and the Context Store exposes it as virtual `.md` files. Only skills, persona, AGENTS.md and learnings without PII go into git. Crypto-shredding applies to blobs with PII in R2.

---

## (A) Database comparison

### Comparison table

| Option | Multi-tenant isolation | Latency from Workers | Free tier / small scale | Operations | Maturity (Oct/2026) | Portfolio value |
|---|---|---|---|---|---|---|
| **D1** | One shared database with `tenant_id`. Database per tenant is limited by the static binding in wrangler ([config](https://developers.cloudflare.com/workers/wrangler/configuration/)) | Native binding, no connection round trips ([Hyperdrive FAQ](https://developers.cloudflare.com/hyperdrive/reference/faq/)). Read replicas with the Sessions API ([read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)) | Free: 10 databases, 500 MB per database, 5 GB per account. Paid: 50,000 databases, 10 GB per database, 1 TB per account ([limits](https://developers.cloudflare.com/d1/platform/limits/)) | Zero ops. Single, sequential writer per database ([limits](https://developers.cloudflare.com/d1/platform/limits/)) | GA | Medium: it is Cloudflare's "default" |
| **SQLite in Durable Objects** | One object per tenant, agent or conversation. Physical isolation | Storage runs on the same thread as the code ([changelog](https://developers.cloudflare.com/changelog/product/durable-objects/2/)) | Free: 5 GB total. Paid: 5 GB-month included + US$0.20/GB-month ([pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)) | Zero ops. Cross-tenant queries require a sink | GA since Apr/2025, with 10 GB per object ([changelog](https://developers.cloudflare.com/changelog/product-group/storage/5/)) | High: "actor per tenant" pattern and Agents SDK |
| **Neon + Hyperdrive** | RLS or `tenant_id`. Schema or project per tenant is also possible (100 projects on free) | Hyperdrive does connection setup at the edge and pools close to the database ([how it works](https://developers.cloudflare.com/hyperdrive/concepts/how-hyperdrive-works/)). Cold start after scale-to-zero (time unverified) | Free: 100 projects, 1 GB per project (*), 100 CU-h per project, scale-to-zero after 5 min ([pricing](https://neon.com/pricing)). Hyperdrive Free: 100k queries/day ([pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/)) | Low. Branching on all plans ([pricing](https://neon.com/pricing)) | GA. Now part of Databricks ("Lakebase Postgres") ([pricing](https://neon.com/pricing)) | High: Postgres, branching per PR, pgvector |
| **Supabase + Hyperdrive** | RLS with `auth.uid()` and `auth.jwt()` ([RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)) | Same as Neon via Hyperdrive. Also has HTTP access via supabase-js (not measured) | Free: 2 projects, 500 MB, **pauses after 1 week without use**. Pro: US$25/month with US$10 of compute credits ([pricing](https://supabase.com/pricing)) | Low, but Auth, Storage and Realtime overlap with what Cloudflare already offers | GA | Medium: shows RLS, but weakens the "Cloudflare-first" story |
| **PlanetScale Postgres + Hyperdrive** | RLS or `tenant_id` | Native integration: the database is created in the Cloudflare dashboard and billed on its invoice since 2026-06-18 ([changelog](https://developers.cloudflare.com/changelog/post/2026-06-18-planetscale-databases-cloudflare-billing/)) | **No free tier.** PS-5 single node at US$5/month; 3-node HA at US$15/month ([pricing](https://planetscale.com/pricing)) | Low. Development branches and MCP ([Hyperdrive/PlanetScale](https://developers.cloudflare.com/hyperdrive/planetscale/)) | GA | High for production. Natural upgrade path |
| **Turso (libSQL)** | Database per tenant (unlimited databases on paid plans) | `@tursodatabase/serverless` driver using only `fetch`, presented as "experimental" ([blog](https://turso.tech/blog/introducing-turso-serverless-javascript-driver), [docs](https://docs.turso.tech/sdk/ts/reference)) | Free: 100 databases, 5 GB, 500 M rows read and 10 M written per month. Developer at US$4.99 with unlimited databases ([pricing](https://turso.tech/pricing)) | One more vendor. Does not use Hyperdrive | Turso Cloud runs libSQL; the rewritten-in-Rust "Turso" is in beta ([CTO's post on X](https://x.com/penberg/status/2032373944007688226), third-party source) | Medium: DO SQLite delivers the same pattern without an extra vendor |
| **Cloudflare's own managed Postgres** | — | — | — | — | **Not found.** What exists is the partnership with PlanetScale, billed by Cloudflare ([changelog](https://developers.cloudflare.com/changelog/post/2026-06-18-planetscale-databases-cloudflare-billing/)) | — |

(*) Neon's pricing page shows **1 GB per project** on free. Earlier 2025 versions cited 0.5 GB (unverified). The discrepancy is recorded.

### Details that decide

**D1**

- Prices:
  - Free: 5 M rows read/day, 100k rows written/day, 5 GB.
  - Paid: 25 billion reads/month included + US$0.001/M; 50 M writes/month + US$1.00/M; 5 GB + US$0.75/GB-month ([pricing](https://developers.cloudflare.com/d1/platform/pricing/)).
- Each database processes queries **in sequence**: a 1 ms query gives about 1,000 qps, a 100 ms query about 10 qps ([limits](https://developers.cloudflare.com/d1/platform/limits/)).
- Time Travel keeps 7 days on Free and 30 days on Paid ([limits](https://developers.cloudflare.com/d1/platform/limits/)).
- **Database per tenant:** the limit of 50,000 databases can be raised on request ([limits](https://developers.cloudflare.com/d1/platform/limits/)). But the documentation only shows access via a binding declared in wrangler, one per database ([config](https://developers.cloudflare.com/workers/wrangler/configuration/)). Creating thousands of bindings or going through the REST API from the Worker is possible in theory, but I do not recommend it: latency was not measured and it requires an API token. I did not find a dynamic D1 binding (unverified).
- **Recommended use:** a single control-plane database in the "100% Cloudflare" profile.

**SQLite in Durable Objects**

- Limits:
  - Unlimited objects.
  - 10 GB per object.
  - Per account: 5 GB on Free, unlimited on Paid.
  - Row or BLOB up to 2 MB; SQL up to 100 KB; up to 100 columns.
  - Soft limit of 1,000 req/s per object ([limits](https://developers.cloudflare.com/durable-objects/platform/limits/)).
- Free price: 100k requests/day, 5 M rows read/day, 100k rows written/day ([pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).
- Paid price: 1 M requests/month + US$0.15/M; 25 billion reads/month + US$0.001/M; 50 M writes/month + US$1.00/M ([pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).
- SQLite storage billing started in Jan/2026 ([changelog](https://developers.cloudflare.com/changelog/post/2025-12-12-durable-objects-sqlite-storage-billing/)).
- Features:
  - FTS5, JSON and math functions ([SQLite API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)).
  - **30-day** point-in-time recovery ([DO changelog](https://developers.cloudflare.com/changelog/product/durable-objects/)). This matters for LGPD, see below.
- In the Agents SDK, each agent instance has its own SQLite via `this.sql`, and sub-agents have their own database ([Agents API](https://developers.cloudflare.com/agents/runtime/agents-api/), [sub-agents](https://developers.cloudflare.com/agents/runtime/execution/sub-agents/)).
- **Limitation:** no SQL across objects. Cross-tenant reports require a sink: Postgres, Basin or Analytics Engine.

**Postgres via Hyperdrive**

- Hyperdrive pricing works like this: Free with 100k queries/day and up to 10 configurations; Paid unlimited, with up to 25 configurations ([pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/), [limits](https://developers.cloudflare.com/hyperdrive/platform/limits/)).
- **Three facts that affect multi-tenancy:**
  1. The pool operates in **transaction mode**: a `SET` only holds within the transaction, and the connection gets a `RESET` when it goes back to the pool ([how it works](https://developers.cloudflare.com/hyperdrive/concepts/how-hyperdrive-works/)).
  2. Read caching is **on by default** and is **not invalidated by writes** ([query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/)).
  3. The cache key seems to be query text + parameters, but the documentation does not detail this (unverified).
- **Consequence:** if RLS depends on a session variable and the query text is the same across tenants, there is a theoretical risk of serving cached rows to the wrong tenant (unverified).
- **Adopted rule:** explicit `tenant_id = $1` in every query. One Hyperdrive binding with `--caching-disabled` for tenant data, which is exactly what the documentation recommends for "permissions, sessions" ([query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/)). The binding with cache is only for global data.
- **RLS as defense in depth:** `BEGIN; SELECT set_config('app.tenant_id', $1, true); …; COMMIT;`. The semantics of `set_config(..., true)` and of `FORCE ROW LEVEL SECURITY` are general Postgres knowledge, not verified in this session ([Postgres docs](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)). The Hyperdrive documentation advises against long transactions because they hold the connection ([how it works](https://developers.cloudflare.com/hyperdrive/concepts/how-hyperdrive-works/)).
- **Placement:** with several queries in sequence per request, a Worker far from the database pays 20 to 30 ms per query; placed close, 1 to 3 ms ([how it works](https://developers.cloudflare.com/hyperdrive/concepts/how-hyperdrive-works/)).
- **Supabase with RLS via Hyperdrive:** `auth.uid()` depends on the JWT claims that PostgREST injects. On a direct connection through Hyperdrive, those claims would have to be filled in manually (unverified).
- **Free tier for a portfolio demo:**
  - Supabase pauses after 1 week without use ([pricing](https://supabase.com/pricing)), which is bad for a repo that recruiters open sporadically.
  - Neon does scale-to-zero, so the first query pays a cold start ([pricing](https://neon.com/pricing)).
  - PlanetScale has no free tier ([pricing](https://planetscale.com/pricing)).

### Vectors: Vectorize vs. pgvector

| Criterion | Vectorize | pgvector (Neon, Supabase, PlanetScale) |
|---|---|---|
| Limits | Indexes per account: 50,000 on Paid, 100 on Free. Up to 1,536 dimensions. Namespaces per index: 50,000 on Paid, 1,000 on Free. Up to 10 metadata indexes. topK of 50 to 100 ([limits](https://developers.cloudflare.com/vectorize/platform/limits/)). Vectors per index: the limits page says **20 M**, but the Jan/2026 changelog said 10 M ([changelog](https://developers.cloudflare.com/changelog/post/2026-01-23-increased-index-capacity/)). Discrepancy recorded | Limited by the database. PlanetScale has pgvector 0.8.5 and pgvectorscale 0.9.0 ([extensions](https://planetscale.com/docs/postgres/extensions)). Neon lists pgvector ([pricing](https://neon.com/pricing)) |
| Price | Free: 30 M queried dimensions/month and 5 M stored. Paid: 50 M queried + US$0.01/M; 10 M stored + US$0.05 per 100 M ([pricing](https://developers.cloudflare.com/vectorize/platform/pricing/)) | Included in Postgres storage and compute |
| Isolation | Namespace per tenant or metadata filter. Metadata indexes must exist **before** insertion ([intro](https://developers.cloudflare.com/vectorize/get-started/intro/)) | `tenant_id` + RLS, in the same transaction as the memory row |
| LGPD | Deleting requires a second operation, outside the transaction | A transactional `DELETE` removes the memory and the embedding together |

Managed alternative: **AI Search**, which indexes an R2 bucket and has a **per-tenant search** guide, with one instance per tenant or one instance with a metadata filter ([per-tenant search](https://developers.cloudflare.com/ai-search/how-to/per-tenant-search/), [R2 source](https://developers.cloudflare.com/ai-search/configuration/data-source/r2/)).

**Recommendation for vectors:**

- Default: **pgvector in Postgres** for memories and learnings. It keeps transactional consistency, isolation through the same `tenant_id`, and LGPD deletion in one step.
- Vectorize stays as an optional adapter, for the 100% Cloudflare profile or for the index of skills and documents, which have no PII.

### Analytics and events (only where it makes sense)

- **Workers Analytics Engine** is for operational metrics: tokens, latency and cost per tenant or agent.
  - Announced price: Free with 100k points/day and 10k queries/day; Paid with 10 M points/month + US$0.25/M and 1 M queries/month + US$1.00/M.
  - **It is not billed today** ([pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/)).
  - Data is **adaptively sampled** ([datasets](https://developers.cloudflare.com/analytics/sql-api/datasets/)). Good for dashboards, not for billing or exact reporting.
- **Basin** is the new name of the "Cloudflare Data Platform", since 2026-10-01: Basin Pipelines (formerly Pipelines), Basin Catalog (formerly R2 Data Catalog) and Basin SQL (formerly R2 SQL) ([Basin](https://developers.cloudflare.com/basin/)). Ingestion through a Worker binding, Iceberg tables on R2 and distributed SQL. R2 SQL went into open beta in Sep/2025 ([changelog](https://developers.cloudflare.com/changelog/post/2025-09-25-announcing-r2-sql-open-beta/)). It makes sense once there are cross-tenant reports at volume.
- **ClickHouse or Tinybird:** not researched in detail. I do not recommend them at this stage: they would be one more vendor with no proven need.

### Recommendation (A)

**Recommended profile: "Cloudflare-first + Postgres".**

| Data | Where | Why |
|---|---|---|
| Hot conversation state: recent messages, turn queue, locks, schedules, checkpoints | **DO SQLite** (Agent per `tenant:agent[:conversation]`) | Single writer, local latency, hibernation, Agents SDK |
| Catalog: tenants, users, agents, channels, plans, quotas, references to secrets | **Postgres (Neon) via Hyperdrive, no cache** | Relational system of record; admin and cross-tenant reports |
| Hot routing (channel → tenant/agent) | **KV** as a cache, sourced from Postgres | Cheap global reads. KV Free: 100k reads/day ([pricing](https://developers.cloudflare.com/workers/platform/pricing/)) |
| User memories (PII) + embeddings | **Postgres + pgvector**, with `tenant_id` and RLS | Transactional deletion (LGPD) |
| Full history and conversation archive | Partitioned Postgres **or** JSONL on R2 + Basin | Retention and reports |
| Context `.md` files | **Context Store**: DO + GitHub (see B). Index and manifest mirrored in Postgres | Versioning and human editing |
| Attachments, media, transcripts | **R2**, with a per-tenant prefix and per-user encryption when there is PII | Cheap, no egress |
| Operational metrics | **Analytics Engine** | Cheap and sampled |
| Exact audit | Append-only table in Postgres and, at volume, Basin | Exactness |
| Decoupling | **Queues**: Free with 10k ops/day and 24 h retention; Paid with 1 M ops/month + US$0.40/M ([changelog](https://developers.cloudflare.com/changelog/post/2026-02-04-queues-free-plan/), [pricing](https://developers.cloudflare.com/workers/platform/pricing/)) | Event-driven |

**Why Neon as the default:**

- Usable free tier for a demo: 100 projects, scale-to-zero and no weekly pause.
- **Database branch per PR** in CI, which is a portfolio differentiator.
- pgvector included ([pricing](https://neon.com/pricing)).

**Upgrade path:** PlanetScale Postgres from US$5, billed by Cloudflare itself ([changelog](https://developers.cloudflare.com/changelog/post/2026-06-18-planetscale-databases-cloudflare-billing/)). Since it is Postgres via Hyperdrive, switching vendors means switching the connection string.

**Alternative "100% Cloudflare" profile**, for zero external dependency:

- A single D1 as control plane, DO SQLite per tenant, Vectorize with a namespace per tenant, R2 and Analytics Engine.
- Cost: cross-tenant reports require Basin, there is the 10 GB cap per D1 database, and LGPD deletion becomes two-phase (row + vector).

---

## (B) Options for storing the context (`.md`)

### Options table

| Option | Versioning | External human editing | Obsidian | Runs in Workers without a container? | Multi-tenant | Cost | Maturity | LGPD |
|---|---|---|---|---|---|---|---|---|
| **GitHub, repo per tenant (GitHub App)** | Full Git | Web UI, PR, any git client | obsidian-git, on desktop | Yes, HTTP only (REST and GraphQL) | Private repo per tenant; token per installation | Free org: unlimited private repos, with a limited feature set ([plans](https://docs.github.com/en/get-started/learning-about-github/githubs-plans)) | High | Immutable history. Rewriting is incomplete ([docs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)) |
| GitHub, repo per agent | Same | Same | One vault per agent (bad for reuse) | Yes | Explodes the number of repos and tokens | Same | High | Same |
| **Obsidian Sync + Headless** | 1-month history (Standard) or 12-month (Plus) ([plans](https://obsidian.md/help/sync/plans)) | Obsidian app | Native | **No.** Node 22 CLI ([npm](https://www.npmjs.com/package/obsidian-headless)) | Vaults per account; no public API ([help](https://obsidian.md/help/sync/headless)) | The pricing page shows US$4/user/month billed annually and US$5 monthly, without distinguishing Standard from Plus ([pricing](https://obsidian.md/pricing)). Discrepancy recorded | Open beta (headless) | E2E ([help](https://obsidian.md/help/sync/headless)) |
| **obsidian-git → GitHub** | Git | Obsidian + GitHub | Yes, but on mobile "very unstable" ([repo](https://github.com/Vinzent03/obsidian-git)) | Not applicable (runs on the client) | One vault per tenant repo | Free (MIT) | High on desktop | Same as GitHub |
| Self-hosted LiveSync (CouchDB, S3/R2, P2P) | Its own | Obsidian | Yes ([repo](https://github.com/vrtmrz/obsidian-livesync)) | Would require CouchDB or reading the plugin's format | Weak | R2 is cheap | Active (community) | Writes encrypted chunks, not plain `.md` ([deepwiki](https://deepwiki.com/vrtmrz/obsidian-livesync/1-self-hosted-livesync-overview), third-party source). Incompatible with Obsidian Sync ([repo](https://github.com/vrtmrz/obsidian-livesync)) |
| Obsidian Local REST API | None | Local Obsidian | Yes | **No.** Listens on `127.0.0.1:27124` inside the app ([repo](https://github.com/coddingtonbear/obsidian-local-rest-api)) | No | Free | Active | Not applicable |
| **R2 + own versioning** | **R2 has no object versioning**: `PutBucketVersioning` and `ListObjectVersions` are not implemented ([S3 compat](https://developers.cloudflare.com/r2/api/s3/api/)). `R2Object.version` is just the id of each upload ([API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)) | Only through your own tool | No | Yes | Per-tenant prefix | Cheap | You build everything | Deleting is easy |
| isomorphic-git in Workers (+R2/DO) | Git | Git clients, against a server you host | Indirect | Yes, with MemoryFS ([example](https://developers.cloudflare.com/artifacts/examples/isomorphic-git/)), but it has to fit in 128 MB per isolate ([limits](https://developers.cloudflare.com/workers/platform/limits/)) | You build it | Cheap | Third-party projects: git-fs-s3, gitvex ([git-fs-s3](https://github.com/nandan-varma/git-fs-s3), [gitvex](https://github.com/mdhruvil/gitvex)) | You control it |
| **Cloudflare Artifacts** | Git (server in Zig/Wasm on top of DOs) ([blog](https://blog.cloudflare.com/artifacts-git-for-agents-beta/)) | Any git client with a per-repo token ([changelog](https://developers.cloudflare.com/changelog/post/2026-04-16-artifacts-now-in-beta/)). Dashboard shows files ([changelog](https://developers.cloudflare.com/changelog/post/2026-06-17-dashboard-management/)) | obsidian-git pointing at the Artifacts remote with the token as password (unverified) | Yes. Native read via binding; write via git protocol ([binding](https://developers.cloudflare.com/artifacts/api/workers-binding/)) | "Tens of millions of repos"; repo per autonomous unit ([best practices](https://developers.cloudflare.com/artifacts/concepts/best-practices/index.md)) | Workers Paid only. 10k ops/month + US$0.15 per thousand; 1 GB-month + US$0.50/GB-month, billing from 2026-10-14 ([pricing](https://developers.cloudflare.com/artifacts/platform/pricing/)) | **Open beta** since 2026-10-01 ([changelog](https://developers.cloudflare.com/changelog/post/2026-10-01-artifacts-open-beta/)) | Per-user repo deletable with `delete(name)` ([binding](https://developers.cloudflare.com/artifacts/api/workers-binding/)). Snapshot retention not verified |
| Virtual files in the database (Postgres/DO) with a revisions table | Revisions in rows | Only through the Context Store (UI, API, export) | Export or import | Yes | `tenant_id`/RLS | Included | You build it | **Best**: revisions that can truly be deleted |

### GitHub as the source of truth: facts that size the design

**Authentication**

- The GitHub App installation token **expires in 1 hour**. It can be restricted to up to 500 repos and to specific permissions ([docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)).

**Rate limits** ([rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api))

- Primary: 5,000 req/h per installation, scaling up to 12,500; 15,000 on Enterprise Cloud.
- Secondary: 100 concurrent requests; 900 points/min on REST; 90 s of CPU per 60 s; and **about 80 content-generating requests per minute and 500 per hour**.
- The content limit is the one that rules. If all tenant repos sit under **a single installation** (the project's org), they probably **share that budget**. This is an inference; the documentation does not state the scope explicitly.
- That is why **batched commits with debounce are mandatory**. An alternative is for each tenant to install the App in their own org, which separates the budgets ("bring your repo" model).

**Commit primitive**

- **Contents API:** one file per commit. Files up to 1 MB are fully supported; from 1 to 100 MB, only with the raw media type; above 100 MB, unsupported. Directory listing goes up to 1,000 files. Parallel PUT and DELETE conflict, so they have to be serial ([contents](https://docs.github.com/en/rest/repos/contents)). **Not suitable** for agent writes.
- **Git Data API:** blobs + tree with `base_tree` + commit + ref update. That is N+3 calls. Recursive tree reads truncate at 100k entries or 7 MB ([trees](https://docs.github.com/en/rest/git/trees), [commits](https://docs.github.com/en/rest/git/commits)).
- **`createCommitOnBranch` (GraphQL):** the best option.
  - Several files (additions and deletions) **in one call**.
  - Requires **`expectedHeadOid`**, which gives native optimistic concurrency.
  - Commits come out **signed and verified** automatically, and a GitHub App can use the mutation ([changelog](https://github.blog/changelog/2021-09-13-a-simpler-api-for-authoring-commits/), [GraphQL](https://docs.github.com/en/graphql/reference/commits)).

**Push webhooks** ([payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads#push), [redelivery](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks))

- At most 2,048 commits per payload. There is no tag event when more than 3 are pushed at once. Payload capped at 25 MB.
- **GitHub does not automatically redeliver** failed deliveries; there is a 3-day window for manual redelivery or via the API. So **periodic reconciliation** is needed.

**Repo per tenant or per agent**

- Per tenant: reuse across agents of the same tenant (`shared/skills`), one Obsidian vault per tenant, and fewer tokens.
- Per agent: only if agents are sold or exported in isolation.

**Cost:** a Free org has unlimited private repos, with a limited feature set ([plans](https://docs.github.com/en/get-started/learning-about-github/githubs-plans)). GitHub Apps have no cost of their own (unverified).

### Obsidian: what exists in 2026

- **Obsidian Headless Sync** (`obsidian-headless` on npm, open beta):
  - It is a **CLI-only** client (`ob login`, `ob sync-setup`, `ob sync --continuous`), not an API or SDK. It requires a Sync subscription and warns against running desktop Sync on the same device ([help](https://obsidian.md/help/sync/headless), [changelog](https://obsidian.md/changelog/2026-02-27-sync/)).
  - Requires Node 22+ ([npm](https://www.npmjs.com/package/obsidian-headless)).
  - **It does not run in Workers.** It would need a container or VM, which the project excludes.
- **Obsidian CLI** (1.12, Feb/2026): controls the running **desktop app** ([help](https://obsidian.md/help/cli)). Not usable on a server.
- **obsidian-git:** automatic commit-and-sync on an interval and pull on open. On mobile, the README itself says it is "very unstable", because it uses isomorphic-git ([repo](https://github.com/Vinzent03/obsidian-git)). **This is the recommended path:** GitHub becomes the hub, and humans edit in desktop Obsidian, on the GitHub web UI or in any editor they like.
- **Self-hosted LiveSync** and **Local REST API:** useful for personal use. Not usable as a multi-tenant backend without a container or a local machine (see table).

### R2, isomorphic-git and Artifacts

- **R2 does not version objects** ([S3 compat](https://developers.cloudflare.com/r2/api/s3/api/)). Anyone who wants to use R2 as a backend has to build:
  - content-addressed blobs (`blobs/{sha256}`);
  - one manifest per version (`manifests/{n}.json`);
  - a version log in a DO.

  It works, but it is "reinventing git" without the ecosystem.
- **isomorphic-git in Workers:** viable with MemoryFS ([official example](https://developers.cloudflare.com/artifacts/examples/isomorphic-git/)), but the whole repo must fit in the **128 MB per isolate** budget ([limits](https://developers.cloudflare.com/workers/platform/limits/)). Good for pushing a few files to a remote; not for hosting a git server.
- **Cloudflare Artifacts: confirmed, not a rumor.**
  - **Status:** private beta on 2026-04-16 ([changelog](https://developers.cloudflare.com/changelog/post/2026-04-16-artifacts-now-in-beta/)); **open beta on 2026-10-01**; Workers Paid only; billing from 2026-10-14 ([changelog](https://developers.cloudflare.com/changelog/post/2026-10-01-artifacts-open-beta/), [pricing](https://developers.cloudflare.com/artifacts/platform/pricing/)).
  - **Limits** ([limits](https://developers.cloudflare.com/artifacts/platform/limits/)): 1 GB per repo; 32 MB per file; 1 TB per account (can be raised); 2,000 requests every 10 s per namespace (control plane) and per repo (git); unlimited repos and namespaces.
  - **APIs:** the binding and REST are **content read-only** (`readFile`, `log`, `readTree`, `readBlob`), plus creating repos, forking, issuing tokens and importing. **Writing requires the git protocol** (git client or isomorphic-git) ([binding](https://developers.cloudflare.com/artifacts/api/workers-binding/), [REST](https://developers.cloudflare.com/artifacts/api/rest-api/index.md)).
  - **Import:** only from **public HTTPS** remotes and only once ([import](https://developers.cloudflare.com/artifacts/guides/import-repositories/index.md)). There is no documented mirroring to GitHub ([doc index](https://developers.cloudflare.com/artifacts/llms.txt)).
  - **Events:** `pushed`, `cloned`, `repo.created` and others, delivered via Queues ([events](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/)).
  - **Durability:** synchronous replication across data centers and asynchronous to object storage ([how it works](https://developers.cloudflare.com/artifacts/concepts/how-artifacts-works/index.md)).
  - **Data:** US or EU region ([open beta](https://developers.cloudflare.com/changelog/post/2026-10-01-artifacts-open-beta/)).
  - **Official best practice:** "one repo for each unit of autonomous work", and git notes for execution metadata ([best practices](https://developers.cloudflare.com/artifacts/concepts/best-practices/index.md)).
  - Cloudflare's own reference architecture separates "Skills and context library: read-only object store (R2)" from "User files: versioned file service" ([reference architecture](https://developers.cloudflare.com/reference-architecture/diagrams/ai/enterprise-ai-agent-workspace/)).

### Recommendation (B)

1. **Boundary:** the agent only knows the **Context Store** (RPC via service binding and, optionally, MCP tools). It never talks to GitHub, Artifacts or R2.
2. **Canonical (phase 1): GitHub, with one private repo per tenant.**
   - It is the only backend with a mature human path today (web, PR, Obsidian via obsidian-git).
   - It is viable on Free at demo scale, but real use calls for Workers Paid (see Risks, item 14).
   - It is familiar to whoever evaluates the portfolio.
3. **Working copy:** **one DO per tenant**. `.md` files fit in 2 MB rows ([limits](https://developers.cloudflare.com/durable-objects/platform/limits/)); larger files go to R2 by hash. Search with FTS5.
4. **Phase 2 (Workers Paid): `ArtifactsBackend`** behind the same interface, for:
   - agent sessions, forks and experiments;
   - eventually, one repo per end user as a deletable unit.

   It can become canonical with a one-way mirror to GitHub, built by us. **Justification for the complexity:** the interface has about 6 methods; an in-memory backend makes tests feasible; and switching backends becomes configuration, not a rewrite.
5. **PII stays out of git** (see LGPD). The `users/` path is virtual and comes from Postgres.

---

## Context Store worker design

### Responsibilities and boundary

```
 channels → Agent (DO/Agents SDK) ──RPC──▶ Context Store Worker (WorkerEntrypoint)
                                              │
                         ┌────────────────────┼─────────────────────────┐
                         ▼                    ▼                         ▼
               TenantContextDO (1/tenant)   Postgres (Hyperdrive)     R2 (blobs >2MB,
               - files/working copy         - virtual users/* (PII)   compiled bundles)
               - manifest, base SHAs        - mirrored index/manifest
               - pending changes            - pgvector (chunks)
               - audit (local)              - audit_events
               - FTS5
                         │ alarm (debounce)
                         ▼
               Queue "ctx-commit" ──▶ consumer ──▶ Backend (GitHubBackend | ArtifactsBackend)
                                                        │
 GitHub push webhook ──▶ /webhooks/github ──▶ Queue "ctx-inbound" ──▶ reconcile/merge in the DO
 Cron (reconciliation) ─────────────────────────────────┘
 sha change ──▶ Queue "ctx-reindex" ──▶ embeddings (Workers AI) ──▶ pgvector/Vectorize
```

### Backend interface (swappable)

```ts
interface ContextBackend {
  getHead(repo: RepoRef): Promise<{ oid: string }>;
  readTree(repo: RepoRef, ref: string): Promise<TreeEntry[]>;          // bootstrap/reconcile
  readFile(repo: RepoRef, ref: string, path: string): Promise<string | null>;
  diff(repo: RepoRef, from: string, to: string): Promise<FileChange[]>; // external edits
  commit(repo: RepoRef, c: { expectedHead: string; changes: FileChange[];
         message: string; author: Actor }): Promise<{ oid: string } | { conflict: true; head: string }>;
  parseInbound(req: Request): Promise<InboundEvent | null>;             // GitHub webhook | Artifacts event
}
```

- **`GitHubBackend`:** `commit` uses `createCommitOnBranch` ([GraphQL](https://docs.github.com/en/graphql/reference/commits)); `readTree` uses the Trees API ([trees](https://docs.github.com/en/rest/git/trees)); `parseInbound` validates the push.
- **`ArtifactsBackend`:** reads use the binding (`readFile`, `log`) and writes use isomorphic-git with MemoryFS ([example](https://developers.cloudflare.com/artifacts/examples/isomorphic-git/)). Inbound comes from the `pushed` event via Queue ([events](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/)).
- **`MemoryBackend`:** for tests.

### API (RPC; HTTP mirrors it for humans and tools)

| Method | Semantics |
|---|---|
| `read(tenant, path, {ref?})` | Reads from the DO (read-your-writes). Returns `{content, version, sha256, source}` |
| `write(tenant, path, content, {ifMatch, actor, reason})` | CAS by `version`; validates the per-path ACL; marks as *dirty*; schedules a flush alarm |
| `delete(tenant, path, {ifMatch, actor})` | Same, with a tombstone |
| `list(tenant, {prefix, recursive})` | Reads from the manifest in the DO |
| `search(tenant, {q, mode: fts\|semantic\|hybrid, scope})` | FTS5 in the DO ([SQLite API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)) + pgvector |
| `history(tenant, path)` | Audit log + backend commits |
| `compile(tenant, agentId, userId)` | Assembles the prompt context (see below) and returns `{bundle, hash}` |
| `propose(tenant, changes, {title})` | For sensitive paths: opens a branch + PR instead of committing to `main` |

**Per-path ACL**, with the agent identified by its originating binding:

- The agent writes freely in `agents/{self}/memory/**`.
- In `SOUL.md`, `AGENTS.md` and `skills/**`, it **proposes**, and the change becomes a PR for human review. This prevents an agent from rewriting its own persona or its own rules.
- `users/**` is only through the memory API: virtual, in Postgres.

### Agent write flow

1. `write()` reaches the `TenantContextDO`, which is **single-writer per tenant**: it stores the content, `sha256`, `version+1`, `dirty=1` and an audit row.
2. The DO schedules a debounce alarm, for example 30 to 120 s without new writes or at most N minutes.
3. The alarm gathers the *dirty* files into a **changeset** and publishes it to `ctx-commit`.
4. The consumer calls `backend.commit({expectedHead: known_head, changes})`.
   - **Success:** the DO stores the new `head`, updates each file's `base_blob` and clears `dirty`.
   - **`conflict`** (the head moved because of a human edit): runs reconciliation (below) and tries again.
   - **403 or 429 from a secondary limit:** `message.retry({delaySeconds})` with backoff, and the consumer's concurrency is capped to respect ~80/min and 500/h ([rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)).
5. If there is a risk of many steps (a large merge), the flush can become a durable **Workflow** instead of a simple message ([Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/)).

### External human edit flow

1. The `push` webhook arrives. Validate the HMAC signature, ignore anything that is not `refs/heads/main`, and enqueue to `ctx-inbound`. The endpoint responds quickly.
2. **Echo detection:** if `after` is a commit that the Context Store itself created (oid recorded in the DO), just advance the head.
3. Otherwise, `backend.diff(known_head, after)`. The payload carries up to 2,048 commits ([payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads#push)); beyond that, use compare/trees.
4. For each changed file:
   - **No pending local change:** accept "theirs", update the DO and invalidate the compiled bundle.
   - **With a local change (*dirty*):** do a **3-way merge** with `base` = the `base_blob` kept in the DO, `ours` = the DO and `theirs` = the remote. A line-based merge (diff3) resolves most Markdown cases.
   - **Real conflict:** apply the per-file-type policy (table below).
5. Record the audit with `actor` = the GitHub login (from the payload) and enqueue reindexing of files with a new `sha`.
6. **Reconciliation by cron:** compares `getHead()` with the known head, because GitHub **does not redeliver** webhooks automatically ([redelivery](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks)).

| File type | Conflict policy |
|---|---|
| `SOUL.md`, `AGENTS.md`, `skills/**`, `agent.yaml` | **Human wins.** The agent's version becomes a PR/proposal |
| `memory/MEMORY.md` (curated) | 3-way merge. On conflict, human wins and the agent's lines go to `memory/inbox/*.md` |
| `memory/learnings/*.md` (one file per learning, append-only) | Conflict is rare by construction, because each learning is a new file |
| Anything else | Generate `path.conflict-<ts>.md` and notify |

### Embedding reindexing

- **Trigger:** the `sha256` of an indexable file changed. Left out are `users/**`, which has its own pipeline in Postgres, and `scripts/`.
- **Processing:**
  - Chunking follows the Markdown headings.
  - Each chunk's id is `{tenant}:{path}:{n}`.
  - The path's old chunks are deleted before the upsert.
  - Embeddings come from Workers AI and go to pgvector, or to Vectorize with namespace = tenant ([limits](https://developers.cloudflare.com/vectorize/platform/limits/)).
- **Idempotency:** key `(path, sha256)`.

### Context assembly (`compile`)

- **Order**, Hermes style, in which the persona comes first ([Hermes](https://hermes-agent.nousresearch.com/docs/user-guide/which-file-does-what)):
  1. `SOUL.md`
  2. The tenant's `AGENTS.md`
  3. The agent's `AGENTS.md` (the closest one prevails, as in the AGENTS.md standard ([agents.md](https://agents.md/)))
  4. Skills catalog: only `name` and `description`, with progressive disclosure ([spec](https://agentskills.io/specification))
  5. The agent's `MEMORY.md`
  6. The user's virtual `USER.md`
- **Budget:**
  - Use the Hermes limits as a reference: 2,200 characters for MEMORY and 1,375 for USER, injected as a **frozen snapshot** at session start to preserve the prefix cache ([memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)).
  - The bundle's `hash` changes only when an input `sha` changes, which is good for prompt caching. The bundle can live in R2 or KV **with key = hash**, immutable, so there is no invalidation problem.
- **Skills in the Agents SDK:** the SDK accepts packaged skill sources and `skills.r2()` ([agent skills](https://developers.cloudflare.com/agents/runtime/execution/agent-skills/)). The Context Store can **publish** each tenant's compiled skills to an R2 prefix consumed by `skills.r2()`. A custom source pointing directly at the Context Store was not verified.

### Audit and security

- **Audit:** append-only `audit` in the DO, with `ts, actor{type: agent|human|system, id}, path, op, old_sha, new_sha, commit_oid, reason, request_id`, replicated to `audit_events` in Postgres.
- **Secrets:**
  - The App's private key and the webhook secret live in Worker secrets.
  - The installation token (1 h) is cached in the DO, restricted to the tenant's repo ([docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)).
  - Artifacts tokens are scoped `read`/`write` per repo and have a TTL ([best practices](https://developers.cloudflare.com/artifacts/concepts/best-practices/index.md)).
- **Path hygiene:** normalize (no `..` or absolute paths), enforce a per-file size limit and allow only `.md`, `.yaml` and `scripts/*`.
- **Recovery:** the repo is the DO's backup, and the DO has 30-day PITR ([DO changelog](https://developers.cloudflare.com/changelog/product/durable-objects/)). Tenant bootstrap: `readTree` → DO.

---

## LGPD/GDPR

**Legal basis** (LGPD text read in secondary sources, because the Planalto site failed twice in this session):

- **LGPD, art. 18, VI**, gives the data subject the right to deletion of data processed with consent, except in the cases of **art. 16**: legal or regulatory obligation, research, and transfer to a third party. The fourth case, exclusive use by the controller with anonymized data, is not in the sources consulted (unverified) ([jurishand](https://jurishand.com/lei-13709-de-14-agosto-2018/artigo-18/inciso-6), [modeloinicial](https://modeloinicial.com.br/lei/LGPD/lei-geral-protecao-dados-pessoais/art-18); original at [planalto](https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm), not accessed).
- **GDPR, art. 17**, requires erasure "without undue delay", with exceptions in 17(3) ([gdpr-info](https://gdpr-info.eu/art-17-gdpr/)).
- For backups, the **ICO** accepts leaving data "beyond use" until rotation ([ICO](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/individual-rights/right-to-erasure/)).

**The conflict:**

- Git history is immutable. Rewriting it on GitHub is incomplete: forks keep the commits, there are side effects, and removing cached views and PR refs requires **GitHub Support** ([docs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)).
- The DO's 30-day PITR ([DO changelog](https://developers.cloudflare.com/changelog/product/durable-objects/)) and D1's Time Travel ([limits](https://developers.cloudflare.com/d1/platform/limits/)) also retain deleted data for a window.

| Option | How it works | Pros | Cons |
|---|---|---|---|
| **1. PII outside git** (recommended) | `users/{id}/USER.md` and user memories are **rows in Postgres** (with revisions), exposed as **virtual** `.md` files by the Context Store | Real deletion with a transactional `DELETE`, including embeddings in pgvector | Humans do not edit profiles in Obsidian. Editing via UI/API, or a temporary export |
| **2. Per-user encryption + key discard** (crypto-shredding) | One DEK per user encrypts blobs (R2) or fields; deleting the key makes the data unreadable | Works with immutable logs and histories | An encrypted `.md` is no longer readable or "diffable" in Obsidian and GitHub. Acceptance by regulators shows up only in a vendor blog ([granit-fx](https://granit-fx.dev/blog/crypto-shredding-gdpr-erasure-without-deleting-rows/), unverified). Key management |
| **3. History rewrite** | `git filter-repo` + force push + request to Support | Removes it from the repo | Incomplete (forks, caches), breaks hashes, manual operation ([docs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)). **Incidents only** |
| **4. Repo per end user as a deletable unit** | Artifacts `delete(name)` ([binding](https://developers.cloudflare.com/artifacts/api/workers-binding/)), or a private repo on GitHub, whose deletion removes the private forks ([docs](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/what-happens-to-forks-when-a-repository-is-deleted-or-changes-visibility)) | Keeps the "versioned file" model for user memories | Snapshot and backup retention not verified in either case. On GitHub, it scales badly (500-repo limit per token, repo creation counts as content) |
| **5. Pseudonymization + scrubber** | `user_id` = HMAC; the agent's learnings go through a PII filter (regex + classifier) before going to git | Reduces leakage into history | Probabilistic. Does not replace option 1 |

**Recommendation:**

- **1 + 5 as the default.**
- **2** for blobs with PII in R2 (attachments, transcripts).
- **4** as a phase 2 option with Artifacts, after verifying retention.
- **3** only for incidents.

Document in the repo:

- the retention policy;
- the PITR and Time Travel window as "beyond use";
- the choice of region: Artifacts in US or EU ([open beta](https://developers.cloudflare.com/changelog/post/2026-10-01-artifacts-open-beta/)), D1 jurisdiction ([data location](https://developers.cloudflare.com/d1/configuration/data-location/));
- the LGPD international transfer analysis (unverified in this scope).

---

## Folder layout

**Repo `ctx-{tenant}`**, private, where the root is the tenant. It is compatible with Agent Skills (`SKILL.md`, with a lowercase `name` of up to 64 characters that equals the directory name ([spec](https://agentskills.io/specification))), with nested AGENTS.md ([agents.md](https://agents.md/)) and with the names used by Hermes ([Hermes](https://hermes-agent.nousresearch.com/docs/user-guide/which-file-does-what)).

```
ctx-acme/                              # 1 repo per tenant (GitHub or Artifacts)
├── README.md                          # for humans: how to edit, policies
├── AGENTS.md                          # rules common to ALL the tenant's agents
├── tenant.yaml                        # non-secret metadata (language, time zone, default tone)
├── .gitignore                         # .obsidian/workspace*, .trash/
├── shared/
│   ├── skills/
│   │   └── support-triage/
│   │       ├── SKILL.md               # frontmatter: name, description (+ metadata.version)
│   │       ├── references/refund-policy.md
│   │       ├── scripts/               # optional; opt-in execution
│   │       └── assets/
│   └── knowledge/                     # tenant reference documents (no PII)
│       └── products.md
└── agents/
    ├── attendant/
    │   ├── AGENTS.md                  # operational instructions (overrides the tenant's)
    │   ├── SOUL.md                    # persona: identity, voice, values (human edits)
    │   ├── agent.yaml                 # model, channels, tools, allowed sub-agents
    │   ├── skills/
    │   │   └── scheduling/SKILL.md
    │   ├── memory/
    │   │   ├── MEMORY.md              # curated learnings (≈2,200 characters, no PII)
    │   │   ├── learnings/2026-10-03-peak-hours.md   # 1 file per learning
    │   │   └── inbox/                 # merge leftovers awaiting curation
    │   └── playbooks/escalation.md
    └── orchestrator/
        ├── AGENTS.md
        ├── SOUL.md
        └── agent.yaml                 # list of agents it can invoke
```

**Virtual namespace**, served by the Context Store and **outside git** (Postgres with RLS):

```
users/{user_hmac}/USER.md              # profile (≈1,375 characters), rendered from the rows
users/{user_hmac}/memories/{id}.md     # end-user memories (PII), with deletable revisions
```

**Resolution and overriding:**

- `agents/{a}/AGENTS.md` prevails over `AGENTS.md`, because the closest one wins.
- `agents/{a}/skills/x` prevails over `shared/skills/x`, if they have the same `name`.
- **Obsidian:** the vault is the clone of the repo. `users/` does not appear.

---

## Risks

1. **Hyperdrive with cache and session-based RLS:** may leak data between tenants if `tenant_id` is not an explicit parameter. The cache key is not documented (unverified). Mitigation: binding without cache for tenant data ([query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/)).
2. **GitHub secondary limits** (80/min, 500/h for content), probably shared per installation (inference) ([rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)). Mitigation: debounce, batch, backoff, App installed per tenant.
3. **Webhook loss:** there is no automatic redelivery ([redelivery](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks)). Mitigation: reconciliation by cron.
4. **Artifacts in beta**, with billing from 2026-10-14, Workers Paid only, writes only via git and no mirror to GitHub ([changelog](https://developers.cloudflare.com/changelog/post/2026-10-01-artifacts-open-beta/), [binding](https://developers.cloudflare.com/artifacts/api/workers-binding/)). Mitigation: stay behind the `ContextBackend` interface.
5. **128 MB memory per isolate** when using isomorphic-git ([limits](https://developers.cloudflare.com/workers/platform/limits/)). Mitigation: incremental push of a few files and never clone the whole repo in the Worker.
6. **Neon cold start** after 5 min without use ([pricing](https://neon.com/pricing)); time not measured. **Supabase pause** after 1 week ([pricing](https://supabase.com/pricing)).
7. **D1 as a per-tenant database:** only a static binding is documented ([config](https://developers.cloudflare.com/workers/wrangler/configuration/)), and writes are sequential per database ([limits](https://developers.cloudflare.com/d1/platform/limits/)).
8. **Cross-tenant reports with DO SQLite** require a sink. Analytics Engine is sampled, so it is not suitable for billing ([datasets](https://developers.cloudflare.com/analytics/sql-api/datasets/)).
9. **Vectorize:** metadata indexes must be created before insertion ([intro](https://developers.cloudflare.com/vectorize/get-started/intro/)), and there is a discrepancy in the vector limit (20 M or 10 M).
10. **Obsidian on mobile** via obsidian-git is unstable ([repo](https://github.com/Vinzent03/obsidian-git)). Headless Sync requires Node, so it does not run in Workers ([npm](https://www.npmjs.com/package/obsidian-headless)).
11. **LGPD:** PITR (30 days) and Time Travel retain deleted data for a window; git history is immutable ([DO changelog](https://developers.cloudflare.com/changelog/product/durable-objects/), [GitHub](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)).
12. **Agent editing its own persona or rules:** mitigated by the per-path ACL and mandatory PR.
13. **Name and product changes:** Basin, Artifacts and AI Search changed name or status in 2025–2026. Pin versions and dates in the repo documentation.
14. **Workers Free limits for the Context Store:**
    - **CPU:** 10 ms per invocation ([limits](https://developers.cloudflare.com/workers/platform/limits/)). diff3 merge and chunking for embeddings may not fit; not measured.
    - **External subrequests:** 50 per invocation ([changelog](https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/)). A bootstrap or reconciliation that fetches file by file breaks at around 45 files.
    - **Queues:** 10k ops/day, about 3.3k messages at 3 ops each, with 24 h retention ([changelog](https://developers.cloudflare.com/changelog/post/2026-02-04-queues-free-plan/)). This budget is shared across commit, inbound and reindex.

    Mitigations: read several blobs in a single GraphQL query; split reconciliation and reindexing into one message per small batch of files; use Workers Paid in production (up to 5 min of CPU and 10k subrequests per invocation ([limits](https://developers.cloudflare.com/workers/platform/limits/))).

---

## Sources

**Cloudflare: database, queues and limits**

- D1: [limits](https://developers.cloudflare.com/d1/platform/limits/) · [pricing](https://developers.cloudflare.com/d1/platform/pricing/) · [read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/) · [data location](https://developers.cloudflare.com/d1/configuration/data-location/) · [debug](https://developers.cloudflare.com/d1/observability/debug-d1/)
- Wrangler, D1 bindings: https://developers.cloudflare.com/workers/wrangler/configuration/
- Durable Objects: [limits](https://developers.cloudflare.com/durable-objects/platform/limits/) · [pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) · [SQLite API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) · [DO changelog](https://developers.cloudflare.com/changelog/product/durable-objects/) · [SQLite billing](https://developers.cloudflare.com/changelog/post/2025-12-12-durable-objects-sqlite-storage-billing/) · [GA 10 GB](https://developers.cloudflare.com/changelog/product-group/storage/5/)
- Agents SDK: [API](https://developers.cloudflare.com/agents/runtime/agents-api/) · [sub-agents](https://developers.cloudflare.com/agents/runtime/execution/sub-agents/) · [agent skills](https://developers.cloudflare.com/agents/runtime/execution/agent-skills/) · [sessions](https://developers.cloudflare.com/agents/runtime/lifecycle/sessions/)
- Hyperdrive: [how it works](https://developers.cloudflare.com/hyperdrive/concepts/how-hyperdrive-works/) · [query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/) · [pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/) · [limits](https://developers.cloudflare.com/hyperdrive/platform/limits/) · [FAQ](https://developers.cloudflare.com/hyperdrive/reference/faq/) · [PlanetScale](https://developers.cloudflare.com/hyperdrive/planetscale/) · [PlanetScale changelog](https://developers.cloudflare.com/changelog/post/2026-06-18-planetscale-databases-cloudflare-billing/)
- Workers: [pricing](https://developers.cloudflare.com/workers/platform/pricing/) (includes KV, Queues, Hyperdrive) · [limits](https://developers.cloudflare.com/workers/platform/limits/)
- Queues on Free: https://developers.cloudflare.com/changelog/post/2026-02-04-queues-free-plan/
- Workflows: https://developers.cloudflare.com/workflows/reference/pricing/

**Cloudflare: vectors, analytics and storage**

- Vectorize: [limits](https://developers.cloudflare.com/vectorize/platform/limits/) · [pricing](https://developers.cloudflare.com/vectorize/platform/pricing/) · [intro](https://developers.cloudflare.com/vectorize/get-started/intro/) · [10 M changelog](https://developers.cloudflare.com/changelog/post/2026-01-23-increased-index-capacity/)
- AI Search: [per-tenant](https://developers.cloudflare.com/ai-search/how-to/per-tenant-search/) · [R2 source](https://developers.cloudflare.com/ai-search/configuration/data-source/r2/)
- Analytics Engine: [pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/) · [SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/) · [datasets and sampling](https://developers.cloudflare.com/analytics/sql-api/datasets/)
- Basin: [Basin](https://developers.cloudflare.com/basin/) · [R2 SQL beta](https://developers.cloudflare.com/changelog/post/2025-09-25-announcing-r2-sql-open-beta/)
- R2: [S3 compat, no versioning](https://developers.cloudflare.com/r2/api/s3/api/) · [Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- Artifacts:
  - overview and operation: [overview](https://developers.cloudflare.com/artifacts/) · [pricing](https://developers.cloudflare.com/artifacts/platform/pricing/) · [limits](https://developers.cloudflare.com/artifacts/platform/limits/) · [how it works](https://developers.cloudflare.com/artifacts/concepts/how-artifacts-works/index.md) · [best practices](https://developers.cloudflare.com/artifacts/concepts/best-practices/index.md) · [index](https://developers.cloudflare.com/artifacts/llms.txt)
  - APIs and integrations: [binding](https://developers.cloudflare.com/artifacts/api/workers-binding/) · [REST](https://developers.cloudflare.com/artifacts/api/rest-api/index.md) · [events](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/) · [import](https://developers.cloudflare.com/artifacts/guides/import-repositories/index.md) · [isomorphic-git](https://developers.cloudflare.com/artifacts/examples/isomorphic-git/) · [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/artifacts-integration/)
  - product history: [beta 2026-04-16](https://developers.cloudflare.com/changelog/post/2026-04-16-artifacts-now-in-beta/) · [dashboard](https://developers.cloudflare.com/changelog/post/2026-06-17-dashboard-management/) · [open beta 2026-10-01](https://developers.cloudflare.com/changelog/post/2026-10-01-artifacts-open-beta/) · [blog](https://blog.cloudflare.com/artifacts-git-for-agents-beta/)
- Reference architecture: https://developers.cloudflare.com/reference-architecture/diagrams/ai/enterprise-ai-agent-workspace/

**Postgres, SQLite and other databases**

- Neon: https://neon.com/pricing
- Supabase: [pricing](https://supabase.com/pricing) · [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)
- PlanetScale: [pricing](https://planetscale.com/pricing) · [extensions](https://planetscale.com/docs/postgres/extensions)
- Turso: [pricing](https://turso.tech/pricing) · [serverless driver](https://turso.tech/blog/introducing-turso-serverless-javascript-driver) · [SDK reference](https://docs.turso.tech/sdk/ts/reference)
- Turso, third-party sources: [CTO's post on X](https://x.com/penberg/status/2032373944007688226) · [layerbase](https://layerbase.com/blog/libsql-vs-turso)
- Postgres RLS (unverified in this session): https://www.postgresql.org/docs/current/ddl-rowsecurity.html

**GitHub**

- Authentication and limits: [rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) · [installation token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
- Write APIs: [contents](https://docs.github.com/en/rest/repos/contents) · [trees](https://docs.github.com/en/rest/git/trees) · [commits](https://docs.github.com/en/rest/git/commits) · [GraphQL commits](https://docs.github.com/en/graphql/reference/commits) · [createCommitOnBranch](https://github.blog/changelog/2021-09-13-a-simpler-api-for-authoring-commits/)
- Webhooks: [push](https://docs.github.com/en/webhooks/webhook-events-and-payloads#push) · [redelivery](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks)
- Plans, history and forks: [plans](https://docs.github.com/en/get-started/learning-about-github/githubs-plans) · [removing sensitive data](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository) · [forks when a repo is deleted](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/what-happens-to-forks-when-a-repository-is-deleted-or-changes-visibility)

**Obsidian**

- Official: [headless sync](https://obsidian.md/help/sync/headless) · [changelog](https://obsidian.md/changelog/2026-02-27-sync/) · [npm](https://www.npmjs.com/package/obsidian-headless) · [CLI](https://obsidian.md/help/cli) · [plans](https://obsidian.md/help/sync/plans) · [pricing](https://obsidian.md/pricing)
- Plugins: [obsidian-git](https://github.com/Vinzent03/obsidian-git) · [LiveSync](https://github.com/vrtmrz/obsidian-livesync) · [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api)
- Third-party source: [LiveSync deepwiki](https://deepwiki.com/vrtmrz/obsidian-livesync/1-self-hosted-livesync-overview)

**Git in Workers (third-party sources)**

- [git-fs-s3](https://github.com/nandan-varma/git-fs-s3) · [gitvex](https://github.com/mdhruvil/gitvex) · [isomorphic-git guide for Workers](https://isomorphic-git.org/docs/en/next/guide-cloudflare-workers) (not read in full)

**Agent standards**

- Agent Skills: https://agentskills.io/specification
- AGENTS.md: https://agents.md/
- Hermes Agent: [memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory) · [files](https://hermes-agent.nousresearch.com/docs/user-guide/which-file-does-what)

**LGPD/GDPR**

- LGPD, secondary sources: [jurishand art. 18 VI](https://jurishand.com/lei-13709-de-14-agosto-2018/artigo-18/inciso-6) · [modeloinicial art. 18](https://modeloinicial.com.br/lei/LGPD/lei-geral-protecao-dados-pessoais/art-18)
- LGPD, original: [planalto](https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm) (not accessed)
- GDPR and ICO: [GDPR art. 17](https://gdpr-info.eu/art-17-gdpr/) · [ICO right to erasure](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/individual-rights/right-to-erasure/)
- Crypto-shredding, vendor blog (unverified): https://granit-fx.dev/blog/crypto-shredding-gdpr-erasure-without-deleting-rows/
