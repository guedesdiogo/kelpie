# ADR-0029: Merges deploy themselves through gates, and migrations stay add-only so production can roll back

- Status: Accepted when the pull request for #233 merges
- Date: 2026-10-10
- Issue: [#233](https://github.com/guedesdiogo/kelpie/issues/233)
- Requested by the owner on 2026-10-10: «Quero que configure o repo do kelpie para fazer deploy automatico quando tiver merge e apenas permitir merge quando todos os testes passarem […] o deploy automático deve sempre rodar o migration tbm. Aplique inclusive formas de fazer rollback automático […] e tbm crie formas de voltar uma versao caso eu solicite»

## Context

- **Deploys were manual.** Someone ran `wrangler deploy` for each of the six Workers, in order, with the instance's `--var` flags and a `<build>-<sha>` tag (`docs/admin-api.md`). Merges deployed nothing (#219).
- **The only required check was `Lint, typecheck and test`.**
- **Kelpie has no central database.** Its data lives in Durable Object SQLite:
  - **Class migrations.** Each Worker's `migrations` list creates or removes classes, and `wrangler deploy` applies it.
  - **SQL migrations.** Drizzle's migrations ship in the bundle. Each object applies them in one transaction the first time it wakes on the new code, and stays closed if they fail.
- **Drizzle's migrator** applies only the migrations dated after the last one applied (drizzle-orm 0.45.3, `durable-sqlite/migrator.js`). Two consequences:
  - Rolled-back code skips newer migrations instead of failing.
  - A migration merged with an older date than one already applied would be skipped silently.
- **Cloudflare's limits on rollbacks:**
  - They reach a Worker's 100 most recent versions.
  - They can't cross a class migration.
  - They leave stored data as it is.
  - They need `force` when the target version has other secrets than the live one ([rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/); wrangler 4.147 error 10220).
- **The reference projects** (#233):
  - hermes-agent has one aggregate required gate, deploys that are never cancelled, and add-only migrations.
  - ai-memory refuses a database newer than the code, which would block every rollback past a migration.
  - None of them verifies a deploy or rolls back automatically.

## Decision

1. **One required check.**
   - `CI passed` aggregates every gate, so a new gate needs no ruleset change. The gates:
     - `Lint, typecheck and test`;
     - `Build Workers`: each Worker bundled with `wrangler deploy --dry-run`;
     - `Migrations`: Drizzle drift, journal order, append-only migrations and rollback safety;
     - `Workflow lint`: actionlint with shellcheck;
     - `Dependency review`, on pull requests.
   - The ruleset also blocks new high-severity CodeQL alerts.
   - Runs on pull requests replace each other. Runs on `main` are never cancelled.
2. **Every push to `main` that passes the gates deploys all six Workers.**
   - It goes through the `production` environment, which only `main` can use. Deploys run one at a time and never stop halfway.
   - Each Worker gets the commit's tag, in the order of `docs/admin-api.md`.
   - **Only the Deploy and Rollback workflows deploy production.** Two exceptions run by hand: a new instance's first deploy, and a change to an instance var.
3. **Instance vars are carried from the live version.**
   - These are the vars the owner sets with `--var`: the Access values, the public origins, the vault's GitHub App values and the AI Gateway URLs.
   - Each deploy reads them from the version it replaces and passes them again, so their values stay out of the repository and out of GitHub.
   - A value equal to the repository's default at the live commit isn't carried, so a later change to that default applies.
4. **Migrations run as they do today, and stay add-only.**
   - `wrangler deploy` applies class migrations. Each object applies its SQL migrations when it wakes.
   - **Add-only.** A migration may add tables, nullable columns or columns with defaults, indexes and rows. Removing or rewriting data takes two releases:
     - first, code that stops using the data;
     - later, the migration that removes it, marked `-- rollback-barrier: <reason>`.
   - **The `Migrations` gate refuses:**
     - a drop, a rename, a table rebuild, an `UPDATE` or a `DELETE` without that marker;
     - an edited or removed migration;
     - a journal out of date order.

     A class deletion, rename or transfer needs `// rollback-barrier: <reason>` in `wrangler.jsonc`. A new class only warns.
5. **The deploy verifies production, and rolls back by itself when it is unhealthy.**
   - **Probes,** retried until the new version reaches every location:
     - `/health`;
     - `/version` serves the new build;
     - a Telegram webhook with a wrong secret answers 401, through channel-egress and its `SecretStore`, which wakes and migrates;
     - a GitHub webhook with a wrong signature answers 401, through context-store.
   - **The watch.** For 10 minutes the probes repeat every minute. GraphQL analytics count the new versions' exceptions, exceeded limits and internal errors, Durable Objects included.
   - **Unhealthy:** a probe failing three times in a row, or three failed invocations in the Workers or in their Durable Objects. The two are counted apart, because an object's exception also fails the Worker that called it.
   - **Before deploying,** the deploy reads the analytics once. A token that can't read them stops it there: a watch without them would judge by the probes alone. Then every Worker deployed goes back to the version it replaced, and the old build is probed.
   - **No automatic rollback in two cases:**
     - **The release crosses a rollback barrier:** a class migration, a marked SQL migration, or a live version without a tag. It is fixed forward, or rolled back by request.
     - **The zone's security answered the probes** (`cf-mitigated`). Nothing is known about the Worker, so the deploy fails without a rollback.
   - Either way, a failed deploy opens an issue.
6. **The owner rolls back on request** with the Rollback workflow, to `previous`, a build, a tag or a commit. `previous` is the build served before the live one, read from the deployment history, so a build rolled back as unhealthy is never chosen.
   - Every Worker moves to the same tag, or none does: a refusal undoes the Workers already moved.
   - **Barriers.**
     - A class migration is refused, as Cloudflare refuses it.
     - A destructive SQL migration needs `force`, and so does a Worker whose secrets changed since the target.
   - The rollback is probed, and recorded on an issue.
7. **The tooling is a workspace of its own,** `tools/release`, in TypeScript with Vitest tests. This amends [ADR-0010](0010-monorepo-tooling.md)'s layout: workspaces now live in `apps/*`, `packages/*` and `tools/*`.

## Consequences

- **GitHub holds a Cloudflare API token** in the `production` environment, usable from `main` only. Like any deploy credential, it can deploy any Worker in the account: that account is Kelpie's trust boundary (`docs/secrets.md`). The actions are pinned to commits.
- **A deploy takes about 15 minutes,** 10 of them watching. Merges in the meantime wait; if several wait, only the newest deploys, and it contains the others.
- **After a rollback, `main` still holds the bad change.** The next merge deploys it again unless it is reverted or fixed first. The rollback's issue tracks that.
- **Residual: coverage of the probes.** They reach ingress, channel-egress and its `SecretStore`, and context-store. conversation-runtime, llm-gateway and admin-api are judged by their analytics, which a single owner's traffic rarely feeds in 10 minutes. `Directory`, `Registry`, `AgentHost` and each conversation still migrate on their first request. Waking them at deploy needs a protected route, which is a follow-up ([#234](https://github.com/guedesdiogo/kelpie/issues/234)).
- **Residual: a waiting rollback can be replaced.** GitHub keeps one waiting run per concurrency group. A rollback that waits behind a deploy is replaced if another deploy starts waiting too.
- **Residual: rollbacks reach only recent versions.** A Worker keeps 100 versions to roll back to, and older builds can't be reached.

## Alternatives considered

- **Gradual deployments.** A single owner's traffic can't judge a canary, and class migrations can't deploy gradually.
- **Rolling back by redeploying an old commit.** It rebuilds instead of restoring the exact artifact, and it still can't cross a class migration. Restoring versions is faster and exact.
- **Refusing a newer schema, as ai-memory does.** It blocks every rollback past a migration; add-only migrations keep rollbacks possible.
- **Instance values as GitHub secrets.** They would live in two places and drift. Carrying them from the live version keeps Cloudflare the only copy.
- **`wrangler rollback` in CI.** It prompts when secrets changed. The deployments API it calls gives the tooling that decision.
