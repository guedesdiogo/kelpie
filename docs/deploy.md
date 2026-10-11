# Deploying and rolling back

A merge into `main` deploys itself: CI runs the gates, deploys all six Workers, watches production, and rolls the release back if it is unhealthy. The owner can also roll production back to an earlier build on request. [ADR-0029](adr/0029-continuous-deployment-and-rollback.md) records the decision; this page is the runbook.

```
PR ──► gates ──► CI passed ──► merge ──► gates on main ──► deploy ──► probes + 10 min watch ──► kept
                                                                          │
                                                                          └─ unhealthy ──► automatic rollback + issue
```

## One-time setup

1. **Create a Cloudflare API token** for the account Kelpie runs in.
   - Use the "Edit Cloudflare Workers" template, scoped to that account and to the zone of Kelpie's hostnames.
   - Add **Account → Account Analytics → Read**: the watch reads error counts from the GraphQL Analytics API.
2. **Store it in the `production` environment.** The `production` environment and its `CLOUDFLARE_ACCOUNT_ID` secret already exist; only `main` can use it.
   ```bash
   gh secret set CLOUDFLARE_API_TOKEN --env production --repo guedesdiogo/kelpie
   ```
3. **The ruleset `main: CI must pass`** requires `CI passed` and code scanning results.

## The gates

Every pull request runs these jobs. `CI passed` aggregates them, and it is the one check the ruleset requires.

| Job | What it proves |
|---|---|
| `Lint, typecheck and test` | `check:workspaces`, Biome, `tsc` and every workspace's tests |
| `Build Workers` | Each Worker bundles with its real `wrangler.jsonc` (`wrangler deploy --dry-run`). No account is needed. |
| `Migrations` | Drizzle's migrations match each schema; journals are in date order; applied migrations are unchanged; rollback barriers are acknowledged |
| `Workflow lint` | actionlint, with shellcheck on every `run:` block |
| `Dependency review` | A new dependency has no known high-severity vulnerability |

CodeQL's default setup also runs on pull requests. The ruleset blocks new alerts of high severity.

### When `Migrations` fails

- **"A schema changed without its migration":** run `bun run db:generate` in that Worker and commit the files it writes.
- **"is dated before":** two pull requests generated migrations in parallel. Delete yours and generate it again on top of `main`. Drizzle applies only migrations dated after the last one applied, so an older date would never run on objects that already applied the newer one.
- **"an applied migration was edited":** production may already have applied it. Add a new migration instead.
- **"so code from before it can't run on the migrated data":** the migration drops, renames or rewrites something.
  - Prefer an add-only change. Release the code that stops using the data first; remove the data in a later release.
  - When the removal is the point, add a line `-- rollback-barrier: <why>` to the migration. In `wrangler.jsonc`, for a class deletion or rename, add `// rollback-barrier: <why>`.
  - Either marker records that the release can't be rolled back automatically.
- **A new Durable Object class** only warns: Cloudflare refuses any rollback across the deploy that creates it.

## Deploys

### On merge

After the gates pass on `main`, the `Deploy` job runs `tools/release`. It:

1. **Reads each Worker's live version:** its build tag, its traffic, and its instance vars. Those are the values the owner set with `--var`: the Access values, the public origins, the vault's GitHub App values and the AI Gateway URLs.
2. **Finds the rollback barriers** between the live commit and the new one.
3. **Deploys the Workers in order** (`llm-gateway`, `channel-egress`, `context-store`, `conversation-runtime`, `ingress`, `admin-api`):
   - each is tagged `<build>-<sha>` and carries its instance vars;
   - `wrangler deploy` applies the Durable Object class migrations;
   - each object applies its SQL migrations the first time it wakes on the new code.
4. **Probes production** until the new build answers, for up to three minutes:
   - `/health` answers;
   - `/version` serves the new build;
   - a Telegram webhook with a wrong secret answers 401. It goes through channel-egress, whose `SecretStore` wakes and migrates;
   - a GitHub webhook with a wrong signature answers 401, through context-store.
5. **Watches for 10 minutes.**
   - The probes repeat every minute.
   - The GraphQL Analytics API counts the new versions' exceptions, exceeded limits and internal errors, Durable Objects included.

The run's summary has the table of versions, the probes and the barriers. The probes refuse requests that change nothing: no agent is named, so no conversation or notice runs.

### Automatic rollback

- **When the release is unhealthy,** the deploy puts every Worker it deployed back on the version it replaced, then probes the old build. Unhealthy means:
  - a probe failed three times in a row;
  - the new versions failed three invocations;
  - a Worker didn't deploy.
- **It doesn't roll back:**
  - when the release crosses a rollback barrier: a class migration, a marked SQL migration, or a live version without a tag. Fix forward, or roll back by request;
  - when the zone's security answered the probes (`cf-mitigated`), so nothing is known about the Worker.
- **A failed deploy opens an issue** with the report, whether it rolled back or not.
- **`main` still has the change.** The next merge deploys it again. Revert or fix it first.

### By hand

- **To deploy `main` again,** for example after a rollback once the fix is in:
  ```bash
  gh workflow run deploy.yml --repo guedesdiogo/kelpie
  ```
- **One deploy or rollback runs at a time.** Others wait in the `production` group, and GitHub keeps only the newest waiting run.
- **Don't deploy from a laptop.** A local `wrangler deploy` races the pipeline and skips its checks. Two exceptions:
  - **A new instance's first deploy** follows `docs/admin-api.md`, "Setting it up". The pipeline needs a live version to read the instance vars from.
  - **Changing an instance var.** Deploy that one Worker by hand from a clean checkout of `main`, with the new value and the Worker's other vars:
    ```bash
    bunx wrangler deploy -c apps/<worker>/wrangler.jsonc --tag "$(git rev-list --count --first-parent HEAD)-$(git rev-parse --short=7 HEAD)" --var NAME:value
    ```
    Later deploys carry the new value.

## Rolling back by request

- **From GitHub:**
  ```bash
  gh workflow run rollback.yml --repo guedesdiogo/kelpie -f target=previous -f reason="replies come out empty"
  ```
  The Actions tab shows the same form (Rollback → Run workflow).
- **`target`** takes one of:
  - `previous`, the build before the live one;
  - a build, such as `94`;
  - a tag, such as `94-cc8e179`;
  - a commit.
- **`plan-only`** shows the Workers that would move and the barriers they would cross, and changes nothing.
- **`reason` and `target` are public:** they show on the run's page and in the issue, like everything in this repository's Actions.
- **`force`** crosses a destructive SQL migration, and restores the secrets of a version whose secrets were changed since. Use it only after checking that the older code can run on today's data.

The rollback:
- **Moves every Worker to the same build, or none.** A Worker that refuses undoes the ones moved before it.
- **Refuses to cross a Durable Object class migration,** as Cloudflare does. Fix forward instead.
- **Probes the target build, and opens an issue.**

Fix or revert the change on `main` before the next merge, which deploys `main` again.

### From a terminal

The same tool runs locally, with a wrangler login or `CLOUDFLARE_API_TOKEN`:

```bash
export CLOUDFLARE_ACCOUNT_ID=<Kelpie's account id>
bun run --cwd tools/release release status
bun run --cwd tools/release release rollback --target 94 --reason "replies come out empty" --plan
bun run --cwd tools/release release rollback --target 94 --reason "replies come out empty"
```

- `status` lists what each Worker serves, and the builds a rollback can reach: Cloudflare keeps the 100 most recent versions of each Worker.
- If even this fails, `wrangler rollback <version id> --name kelpie-<worker>` rolls back one Worker. `status` lists the version ids.

## Limits

- **The probes reach ingress, channel-egress and its `SecretStore`, and context-store.**
  - conversation-runtime, llm-gateway and admin-api are judged by their analytics. A single owner's traffic rarely feeds those in 10 minutes.
  - `Directory`, `Registry`, `AgentHost` and each conversation migrate on their first request after the deploy. Waking them during the deploy is #234.
- **Durable Object class migrations can't be rolled back.** Ship them on their own when you can.
- **Rolling back restores code and configuration, never data.** Data written by the newer build stays.
