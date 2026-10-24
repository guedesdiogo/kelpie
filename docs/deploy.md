# Deploying and rolling back

A merge into `main` runs the gates and deploys nothing. Production ships only from a published release `vX.Y.Z`, when the owner asks for it: the Deploy workflow authorizes the release, stops it if a `critico` issue lacks the mentor's acceptance, deploys all six Workers, watches production, and rolls the release back if it is unhealthy. The deploy skips when nothing that ships changed since the builds production serves. The owner can also roll production back to an earlier release or build on request. [ADR-0029](adr/0029-continuous-deployment-and-rollback.md), [ADR-0031](adr/0031-deploy-only-what-ships.md) and [ADR-0066](adr/0066-production-by-release.md) record the decisions; this page is the runbook.

```
PR ──► gates ──► CI passed ──► merge ──► gates on main            (nothing deploys)

owner asks ──► release cut --draft ──► owner's order ──► --publish ──► authorize ──► critical gate ──► deploy ──► probes + 10 min watch ──► kept
                                                                                       │                            │
                                                                                       └─ critico unaccepted:       └─ unhealthy ──► automatic rollback + issue
                                                                                          stops, unless forced
```

## One-time setup

1. **Create a Cloudflare API token** for the account Kelpie runs in.
   - Use the "Edit Cloudflare Workers" template, scoped to that account and to the zone of Kelpie's hostnames.
   - Add **Account → Account Analytics → Read**: the watch reads error counts from the GraphQL Analytics API.
   - With a VPS runner ([runner.md](runner.md)), add the account's **Connectivity Directory Bind** permission too: without it, binding the runner's VPC Service fails with `code: 10196`, and every deploy rolls back at `channel-egress`.
2. **Store it in the `production` environment.** The `production` environment and its `CLOUDFLARE_ACCOUNT_ID` secret already exist; only `main` and tags `v*` can use it.
   ```bash
   gh secret set CLOUDFLARE_API_TOKEN --env production --repo guedesdiogo/kelpie
   ```
   Keep deploy credentials in the environment, never as repository secrets, which every job of every workflow can read.
3. **Store the deep probe's token in the same environment.** The owner, or Claude when asked, runs this once; it prints nothing:
   ```bash
   openssl rand -hex 32 | gh secret set DEPLOY_PROBE_TOKEN --env production --repo guedesdiogo/kelpie
   ```
   - The next deploy uploads it to ingress as a Worker secret, once, and the deep probe signs its requests with it ("What a deploy does"). It lives only in GitHub and in the Worker; nobody needs a copy.
   - Without it, deploys still work: they upload nothing, skip the deep probe, and warn.
   - A token shorter than 32 characters, or with spaces, is treated the same way, with a warning; ingress would refuse it anyway.
4. **The ruleset `main: CI must pass`** requires, with no bypass:
   - `CI passed`, on a branch up to date with `main`;
   - CodeQL's results, which block new high-severity alerts.
5. **Set up releases** ([ADR-0066](adr/0066-production-by-release.md)):
   - the `production` environment accepts tags `v*` besides `main` (Settings → Environments → production → Deployment branches and tags);
   - the variable `PRUMO_DONOS` lists who may deploy production, logins separated by commas or spaces:
     ```bash
     gh variable set PRUMO_DONOS --repo guedesdiogo/kelpie --body guedesdiogo
     ```
   - the label `critico` marks the issues that need the mentor's acceptance. The variable `PRUMO_MENTOR` names the mentor; without it, `guedesdiogo`;
   - the tag ruleset «Release tags v*» stops anyone from creating, moving or deleting `refs/tags/v*`, except the Admin role: whoever pushes such a tag runs that tag's `deploy.yml` in the `production` environment. The owner's token, which the agent uses, has that role.

## The gates

`CI passed` aggregates these jobs, and it is the one check the ruleset requires. A pull request runs only the gates its changes can affect, and the others show as skipped ([ADR-0038](adr/0038-pull-requests-run-affected-gates.md)).

| Job | What it proves | Runs on a pull request that changes |
|---|---|---|
| `Lint, typecheck and test` | `check:workspaces`, Biome, `tsc`, and every workspace's tests with coverage, at least 80% in each (`docs/testing.md`) | anything but the docs and the files under `.github/` that only GitHub reads |
| `Build Workers` | Each Worker bundles with its real `wrangler.jsonc` (`wrangler deploy --dry-run`). No account is needed. | something that ships ("What a deploy does"), or `ci.yml` |
| `Migrations` | Drizzle's migrations match each schema; journals are in date order; applied migrations are unchanged; rollback barriers are acknowledged | something that ships, or `ci.yml` |
| `Workflow lint` | actionlint, with shellcheck on every `run:` block | anything under `.github/` |
| `Dependency review` | A new dependency has no known high-severity vulnerability | a `package.json`, `bun.lock`, or anything under `.github/` |

- **`Detect changes` decides,** before the gates, with `release gates` in `tools/release`. Its summary lists each gate, whether it runs, and the paths behind it. The docs are the Markdown files under `docs/` and at the root, and `LICENSE`; a docs-only pull request runs no gate. A path no rule names runs lint and tests, and a path git quotes for its unusual characters runs every gate.
- **Every gate runs** on a push to `main`, and on a pull request that changes `tools/release/` or `ci.yml`: the rule never judges a change to itself.
- **`CI passed` accepts only the skips `Detect changes` decided.** It fails when `Detect changes` fails, and when a gate that had to run didn't succeed.
- **`release gates --base origin/main`**, from `tools/release`, shows the decision for a local branch.

CodeQL's default setup also runs on pull requests. The ruleset blocks new alerts of high severity.

### Where the jobs run

Since 2026-10-24, the jobs run on the owner's self-hosted runners (`kelpie-1` to `kelpie-4`), on the `gh-runners-vps` VPS in AWS, by the owner's decision when the account ran out of GitHub Actions minutes (#519). Each runner is a container with its own Docker daemon and 4 CPUs. The VPS and how to operate it are in [guedesdiogo/gh-runners](https://github.com/guedesdiogo/gh-runners).

- **A pull request from a fork runs `ci.yml` on GitHub's `ubuntu-latest`.** A self-hosted runner would run anyone's code on the VPS, where the deploys' secrets pass.
- **An outside contributor's pull request runs no workflow until a maintainer approves it** (Settings → Actions → General → Fork pull request workflows, for all outside contributors). The fork's branch carries its own workflows, so it can point a job at `self-hosted`. Read its changes under `.github/` before approving it.
- **Deploy and Rollback run only on the self-hosted runners.** They start from a published release or a dispatch by someone in `PRUMO_DONOS`.
- **CodeQL's default setup stays on GitHub's runners.**

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

### Releases

Production ships when the owner asks for it, through a published release ([ADR-0066](adr/0066-production-by-release.md)).

1. **The agent prepares it,** from the repository's root:
   ```bash
   bun run --cwd tools/release release cut minor           # a preview: the tag and the notes
   bun run --cwd tools/release release cut minor --draft   # saves them as a draft release
   ```
   - The version is `patch`, `minor` or `major` over the previous release, or one named outright, such as `v0.3.0`. The first release needs it named.
   - The release is `main`'s tip, or `--target <commit>`, a commit on `main`'s first-parent history. `--draft` and `--publish` need `CI passed` green on it.
   - The notes list the pull requests since the previous release and the issues they close, from GitHub's records, and how each `critico` issue the gate will read stands. A draft deploys nothing.
2. **The owner reads the notes and gives the order.** Only then does the agent publish the draft:
   ```bash
   bun run --cwd tools/release release cut minor --publish
   ```
   It refuses while a `critico` issue lacks the mentor's acceptance, and when `main` moved past the draft's commit: `--target` then names that commit, or `--draft` moves the draft. The owner can also publish the draft from the Releases page.
3. **Publishing runs the Deploy workflow,** named `Production vX.Y.Z` in the Actions tab:
   - **`Authorize the release`:** whoever published it is in `PRUMO_DONOS`; the tag is `vX.Y.Z` with a published release that isn't a prerelease; its commit is on `main`'s first-parent history, with `CI passed` green.
   - **`Critical issues accepted`:** the critical gate, below.
   - **`Deploy to production`:** checks out the release's commit and deploys it ("What a deploy does").

A prerelease deploys nothing. A release made with a workflow's `GITHUB_TOKEN` would start no workflow either, so releases come from the owner's `gh` login, which the agent uses.

#### The critical gate

- **What it reads:** `main`'s first-parent commits from a base to the release's commit, the pull requests merged into `main` that brought them, and the issues each one closes, from GitHub's API. Never the release's notes, which anyone who can edit the release could change.
- **The base** is the release of the latest successful Deploy run that ran a workflow file the gate can trust: by hand from `main`, or on a release at the commit its tag names. Without one, or when that run's tag isn't in the checkout, the gate reads the whole history.
  - A release the gate stopped leaves no successful run, so the next release's gate reads its commits again, even before anything shipped.
  - Deploying an older release again reads nothing: the release last shipped contains it.
- **The label** is read whatever its case. Without a `critico` label in the repository, the gate fails rather than pass everything.
- **A `critico` issue is accepted** when the mentor opened a pull request in that range that closes it, or commented on it with «**Aceite** · <environment> · <link>».
- **Any other `critico` issue stops the release,** and the run's summary lists it. So does any error reading GitHub. Once the mentor accepts each one, re-run the run's failed jobs.
- **`release gate vX.Y.Z`,** from `tools/release`, shows the decision for a tag you have locally, and changes nothing.

#### Forcing a release

Someone in `PRUMO_DONOS` can deploy a release whose `critico` issues lack the mentor's acceptance:

```bash
gh workflow run deploy.yml --repo guedesdiogo/kelpie -f tag=v0.3.0 -f force=true -f reason="login fails for every user"
```

The Actions tab shows the same form (Deploy → Run workflow). The reason is required, and public, like the run. The gate then:
- comments on each such issue: «**Aceite forçado** · produção · v0.3.0 · <run>», with the lines `Dono:`, `Motivo:` and `Revisão retroativa:`;
- opens «Revisão retroativa · v0.3.0 · aceite forçado», assigned to the mentor and labeled `critico`. The mentor reviews each issue in production and comments «**Aceite** · produção · <link>» on it, or opens the fix.

A forced comment isn't an acceptance. If the forced deploy fails, the next release stops on the same issues.

### What a deploy does

Once the release is authorized and past the critical gate, the `Deploy to production` job runs `tools/release` at the release's commit. It:

1. **Reads each Worker's live version:** its build tag, its traffic, and its instance vars. Those are the values the owner set with `--var`: the Access values, the public origins, the vault's GitHub App values and the AI Gateway URLs. A live value equal to the repository's default isn't carried, so a later change to the default applies.
2. **Skips when nothing that ships changed since the live builds.** It compares each live commit with the one being deployed. Something ships when a changed path is:
   - under `apps/`, `packages/`, `tools/release/` or `.github/actions/`;
   - `package.json`, `bun.lock`, `bunfig.toml`, `tsconfig.base.json` or `.github/workflows/deploy.yml`.

   A release that changes only other paths, such as `docs/`, `ci.yml` or `scripts/`, deploys nothing, and the run's summary says why. So does a release whose commit production already contains. A live version without a tag, or a live commit the checkout lacks, always deploys.

   The comparison is with production, not with the previous release. A deploy that was missed, because its run failed or was replaced while it waited, goes out with the next release, whatever that release changes. `deploy.yml` by hand deploys regardless ([By hand](#by-hand)). `release deploy --plan` shows the decision.
3. **Reads the analytics once.** A token without Account Analytics Read stops the deploy here, before anything changes: the watch would otherwise judge by the probes alone.
4. **Finds the rollback barriers** between the live commit and the new one.
5. **Deploys the Workers in order** (`channel-egress`, `llm-gateway`, `context-store`, `conversation-runtime`, `ingress`, `admin-api`). Each one's bindings point only at Workers before it: `llm-gateway` binds `channel-egress`'s `RunnerChat` (#421) and `ProviderKeys` (ADR-0068), `conversation-runtime` its `RunnerSessions` (#434), and `admin-api` binds `llm-gateway`'s `ProviderCheck` (ADR-0068):
   - each is tagged `<build>-<sha>` and carries its instance vars;
   - ingress also gets `DEPLOY_PROBE_TOKEN` when the environment has it and the live ingress doesn't, or on a rotation ("The deep probe's token"). It goes through `wrangler deploy --secrets-file`: the file sits in a private temporary folder and is deleted right after, no other process gets the token, and it is masked in the logs. Uploading once matters: each upload is a secret change, which a rollback can cross only with `force`;
   - channel-egress also gets the runner's VPC Service as its `RUNNER` binding when the environment has the variable `RUNNER_VPC_SERVICE_ID` ([runner.md](runner.md)). `wrangler deploy` takes no binding as a flag, so the release tool deploys channel-egress's config with the binding merged in, from a file it deletes right after;
   - `wrangler deploy` applies the Durable Object class migrations;
   - each object applies its SQL migrations the first time it wakes on the new code.
6. **Probes production** until the new build answers, for up to three minutes:
   - `/health` answers;
   - `/version` serves the new build;
   - a Telegram webhook with a wrong secret answers 401. It goes through channel-egress, whose `SecretStore` wakes and migrates;
   - a GitHub webhook with a wrong signature answers 401, through context-store;
   - **the deep probe**, signed with the token and sent only to an https origin: `POST /deploy/probe` answers 200 with `{ directory, registry, agentHosts, gateway }`, each `ok`. It wakes:
     - ingress's `Directory`;
     - through conversation-runtime's `DeployProbe` entrypoint, the `Registry` and the `AgentHost` of every agent it lists, ten at a time;
     - llm-gateway, which loads its route table and provider settings without calling a model, and wakes its `ModelDefaults` object (#286).

     Each object answers once its migrations ran, so a migration that fails shows now, not on the first real request. A part that answers `failed` fails the probe, and the report names the part. A 404 means ingress lacks the token or holds another one, or the build has no route; the report says so.
7. **Watches for 10 minutes.**
   - The probes repeat every minute.
   - The GraphQL Analytics API counts the new versions' exceptions, exceeded limits and internal errors, Durable Objects included.

The run's summary has the table of versions, the probes and the barriers. The probes change nothing: the webhooks name no agent, so no conversation or notice runs, and the deep probe only wakes objects. An `AgentHost` that wakes does its own start work: its migrations, and a request for its bot's photo when the agent's default mascot changed (ADR-0054). The probe's answer has no ids and no data.

### Automatic rollback

- **When the release is unhealthy,** the deploy puts every Worker it deployed back on the version it replaced, then probes the old build. Unhealthy means:
  - a probe failed three times in a row, the deep probe included;
  - the new versions failed three invocations;
  - a Worker didn't deploy.
- **The old build is probed without the deep probe:** it may have no route for it.
- **Ingress goes back with `force` only when this deploy uploaded the token.** Cloudflare refuses to roll back past a secret change without it, and the version restored is the one this deploy replaced, so the only secret change undone is the deploy's own. The report warns that ingress now holds its previous token, or none:
  - none: the next deploy uploads it again;
  - a previous one, after a rotation: once the fix is released, deploy that release by hand with `rotate-probe-token`. Until then the deep probe answers 404 and fails every deploy.
- **It doesn't roll back:**
  - when the release crosses a rollback barrier: a class migration, a marked SQL migration, or a live version without a tag. Fix forward, or roll back by request;
  - when the zone's security answered the probes (`cf-mitigated`), so nothing is known about the Worker.
- **A failed deploy opens an issue** with the report, whether it rolled back or not.
- **`main` still has the change.** The next release deploys it again, even one that changes only docs. Revert or fix it first.

### By hand

- **To deploy a release again,** for example after an automatic rollback whose cause wasn't in the code:
  ```bash
  gh workflow run deploy.yml --repo guedesdiogo/kelpie -f tag=v0.3.0
  ```
  It runs from `main`, and only someone in `PRUMO_DONOS` gets past `authorize`; the critical gate runs as for a release. Each later job checks `PRUMO_DONOS` again, so re-running failed jobs needs it too. By hand it deploys even when nothing that ships changed. Add `-f always=false` to skip in that case, as a release does.
- **It never goes back.** By hand, it refuses a release older than a build production serves: that would skip the Rollback workflow's checks of barriers and secrets. The release production serves deploys again, and so does a newer one.
- **One deploy or rollback runs at a time.** Others wait in the `production` group, and GitHub keeps only the newest waiting run.
- **Don't deploy from a laptop.** A local `wrangler deploy` races the pipeline and skips its checks. Two exceptions:
  - **A new instance's first deploy** follows `docs/admin-api.md`, "Setting it up". The pipeline needs a live version to read the instance vars from.
  - **Changing an instance var.** Deploy that one Worker by hand from a clean checkout of the release production serves (`git switch --detach v0.3.0`): `main` may hold changes that aren't released. Pass a `--var` for each of its instance vars, the new value and the ones it keeps: any you leave out is removed. `bun run --cwd tools/release release deploy --plan` lists which each Worker carries.
    ```bash
    bunx wrangler deploy -c apps/<worker>/wrangler.jsonc --tag "$(git rev-list --count --first-parent HEAD)-$(git rev-parse --short=7 HEAD)" --var NAME:value --var OTHER:value
    ```
    Later deploys carry the new value.

    This deploys the committed config, so `channel-egress` loses the runner's `RUNNER` binding until the next deploy through the pipeline ([runner.md](runner.md)). Run `deploy.yml` by hand for that release right after, or the runner reads as `not_configured` meanwhile.

## Rolling back by request

- **From GitHub:**
  ```bash
  gh workflow run rollback.yml --repo guedesdiogo/kelpie -f target=v0.2.0 -f reason="replies come out empty"
  ```
  The Actions tab shows the same form (Rollback → Run workflow).
- **It is the way back to an earlier release,** with its checks of barriers and secrets. Publishing that release again starts nothing, and the Deploy workflow refuses to go back ("By hand").
- **It needs someone in `PRUMO_DONOS`,** like the Deploy workflow.
- **`target`** takes one of:
  - a release, such as `v0.2.0`: the build of the commit its tag names. A release that shipped nothing, because nothing that ships changed, has no build of its own: the rollback says so, and you name the release or build that served it;
  - `previous`, the build production served before the live one, from ingress's deployment history. A build that was rolled back as unhealthy is never `previous`;
  - a build, such as `94`;
  - a tag, such as `94-cc8e179`;
  - a commit.
- **`plan-only`** shows the Workers that would move and the barriers they would cross, and changes nothing.
- **`reason` and `target` are public:** they show on the run's page and in the issue, like everything in this repository's Actions.
- **`force`** crosses a destructive SQL migration, and restores the secrets of a version whose secrets were changed since. Use it only after checking that the older code can run on today's data.
- **Across #421, the `claude-code` route,** first remove `claude-code` from every model setting that names it, the instance's (`configureModels`) and each agent's (`configureAgent`). Builds before #421 don't know the provider: they refuse an agent's settings that name it, and that agent's turns fail.

The rollback:
- **Moves every Worker to the same build, or none.** A Worker that refuses undoes the ones moved before it.
- **Refuses to cross a Durable Object class migration,** as Cloudflare does. Fix forward instead.
- **Probes the target build, and opens an issue.** A refused rollback changes nothing and opens no issue: the run's error says why. The deep probe isn't used: an older build may have no route for it.
- **Needs `force` for a build from before the token reached ingress, or before it was rotated:** ingress's secrets changed since. Forcing it restores that build's token, or none, and the report warns:
  - if that build had none, the next deploy uploads it;
  - if the token was rotated since, deploy with `rotate-probe-token`, or the deep probe fails.

Fix or revert the change on `main` before the next release, which would deploy it again.

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
- **Rolling back one Worker alone** can split a contract the Workers share. `conversation-runtime` sends a conversation's session only through `llm-gateway`'s `LlmChat` since #431, and `LlmGateway` refuses a session since #432. So `conversation-runtime` goes back to a build from before #431 only with `llm-gateway` back to one from before #432, or every owner turn fails as a bad request. `release rollback` moves every Worker together, and keeps them in step.

## The deep probe's token

- **What it guards.** `POST /deploy/probe` on ingress answers only to an `x-kelpie-deploy-probe` header of `<unix seconds>.<hex HMAC-SHA256 of those seconds, keyed with DEPLOY_PROBE_TOKEN>`.
  - Ingress accepts a time within two minutes of its clock, and compares the MAC in constant time.
  - The token itself never travels, so a header that reaches a log stops working two minutes later.
  - Without the secret, with a secret under 32 characters, or with any other header, the route answers 404, as any unknown path does, and wakes nothing.
- **What a leaked token gives.** Whoever holds it can wake the objects and learn whether each part answers. The answer has no ids and no data, and the probe changes nothing.
- **Its lifecycle.**
  - **Upload, once.** The first deploy after the environment gets the token uploads it to ingress. Later deploys see that ingress holds a `DEPLOY_PROBE_TOKEN` and upload nothing.
  - **Rotation, by dispatch.** Set a new value in the environment (One-time setup, step 3), then run the Deploy workflow for the release production serves with `rotate-probe-token`, which uploads it even though ingress holds one:
    ```bash
    gh workflow run deploy.yml --repo guedesdiogo/kelpie -f tag=v0.3.0 -f rotate-probe-token=true
    ```
    Releases never rotate. Until the rotation runs, ingress keeps the old value, and the deep probe fails every deploy with a 404 that says so.
  - **Immediate revoke.** For a leaked token, delete it on ingress at once; this deploys ingress's live code without the secret:
    ```bash
    bunx wrangler secret delete DEPLOY_PROBE_TOKEN --name kelpie-ingress
    ```
    Then set a new value in the environment. The next deploy uploads it, since ingress holds none.
  - **Rollbacks restore secrets.** A rollback past an upload, automatic or on request, puts ingress back on that version's token, or on none. The report warns, and says what to run.
- **Deleting it from the environment** makes deploys skip the deep probe, but ingress keeps the last value it got, and the route keeps answering it.

## Limits

- **The probes reach ingress, channel-egress and its `SecretStore`, and context-store; with the token, also the `Directory`, the `Registry`, every agent's `AgentHost`, and llm-gateway's configuration.**
  - admin-api is judged by its analytics, and by the startup check `wrangler deploy` makes. A single owner's traffic rarely feeds analytics in 10 minutes.
  - Each conversation's object still migrates on its first request after the deploy: there are many, created on demand.
  - The deep probe exercises conversation-runtime and llm-gateway without a model call, so a broken model call still shows only in the analytics.
- **Durable Object class migrations can't be rolled back.** Ship them on their own when you can.
- **Rolling back restores code and configuration, never data.** Data written by the newer build stays.
