# ADR-0066: Production ships only from a published release, on the owner's request

- Status: Accepted when the pull request for #487 merges
- Date: 2026-10-22
- Issue: [#487](https://github.com/guedesdiogo/kelpie/issues/487)
- Amends: [ADR-0029](0029-continuous-deployment-and-rollback.md), decision 2: a push to `main` deploys nothing, and production ships from a release; [ADR-0031](0031-deploy-only-what-ships.md), decisions 4 and 5: the Deploy job runs on a release, and `always` is off there
- Decided by the owner on 2026-10-22, for every repository he works on (prumo D21, rules AMB-05 and KAN-14, guedesdiogo/prumo#7): «Deploy pode sair para staging a cada merge na main; apenas produção deve ser solicitado. Quando é solicitada uma versão para produção, vamos passar a gerar uma release, e essa release é que vai para produção.» The plan on #487 was approved with no staging for now, and forcing through `PRUMO_DONOS` with a reason. On the critical gate: «a regra não vale se foi guedesdiogo quem esta criando o PR, vai considerar que foi eu mesmo que ja aproveite e pra isso não precisa da regra de aprovação promo_donos»

## Context

- **Every merge deploys production.** [ADR-0029](0029-continuous-deployment-and-rollback.md) deploys all six Workers on every push to `main` that passes the gates, then probes, watches for 10 minutes and rolls back by itself. [ADR-0031](0031-deploy-only-what-ships.md) skips the deploy when nothing that ships changed since the builds production serves.
- **The owner's rule.** Production ships only when he asks, through a release with notes. A merge may deploy to a staging instance.
- **Kelpie has no staging.** A second instance means six more Workers, their Durable Object namespaces, domains, Access, a Telegram bot, a GitHub App and AI Gateway: extra cost, which is opt-in (`CLAUDE.md`).
- **The `critico` rule.** An issue labeled `critico` reaches production only with the mentor's comment «**Aceite** · <environment> · <link>». An owner listed in `PRUMO_DONOS` can force it with a reason, which is recorded on the issue and reviewed by the mentor afterwards. These marks are the prumo format other tools read, so they stay in Portuguese.
- **How GitHub behaves:**
  - a release created with the workflow's `GITHUB_TOKEN` starts no workflow;
  - the `release` event runs the workflow file at the release's tag;
  - `published` fires for prereleases too, and publishing a release again fires nothing;
  - the API shows a draft release only to accounts that can push, and never by its tag.

## Decision

1. **A merge into `main` runs CI only.** The gates and `CI passed` stay as ADR-0029 and [ADR-0038](0038-pull-requests-run-affected-gates.md) set them, and nothing deploys. Runs on `main` are still never cancelled: a release needs `CI passed` green on its commit. There is no staging for now; building one is a decision of its own.
2. **Production ships from a published GitHub release `vX.Y.Z`.**
   - Publishing it runs the Deploy workflow, which deploys the commit its tag names with ADR-0029's deploy, probes, watch and automatic rollback.
   - A draft or a prerelease deploys nothing.
   - The owner asks for production. The agent prepares the release with `release cut <patch|minor|major|vX.Y.Z>` in `tools/release`: alone it shows the tag and the notes; `--draft` saves a draft; `--publish` publishes it, only on the owner's order.
   - The release is `main`'s tip by default, with `CI passed` green. Its notes list the pull requests since the previous release and the issues they close, from GitHub's records, and how each `critico` issue stands.
3. **The Deploy workflow authorizes the release first.**
   - Whoever published it, or ran the workflow, is in the repository variable `PRUMO_DONOS`: logins separated by commas or spaces. The gate and deploy jobs check it again, since re-running failed jobs skips `authorize`, and so does the Rollback workflow.
   - Run by hand, the workflow is `main`'s.
   - The tag is `vX.Y.Z` with a published release that isn't a prerelease.
   - The tag's commit is on `main`'s first-parent history, and `CI passed` is green on it.
   - The `production` environment accepts `main` and tags `v*`.
4. **A critical gate stops a release that brings a `critico` issue without the mentor's acceptance.**
   - `release gate <tag>` reads `main`'s first-parent commits from a base to the tag, the pull requests merged into `main` that brought them, and the issues each one closes, through GitHub's GraphQL API. It never reads the release's text, which anyone who can edit the release could change.
   - The base is the release of the latest successful Deploy run, which the workflow names `Production vX.Y.Z`. A run counts only when it ran a workflow file the gate can trust: by hand from `main`, or on a release at the commit its tag names. A branch named like the tag doesn't count. Without such a run, or when that run's tag isn't in the checkout, the gate reads the whole history. A release the gate stopped leaves no successful run, so the next release's gate reads its commits again, even before anything shipped.
   - The label is read whatever its case. A repository without it fails the gate, since no issue could carry it.
   - A `critico` issue is accepted when a pull request in the range that closes it was opened by the mentor (`PRUMO_MENTOR`, `guedesdiogo` by default), or when the mentor commented on it with a body that starts with `**Aceite** ·`.
   - Any other `critico` issue stops the release, and the run's summary lists it. So does any failure to read GitHub: an error never reads as "no `critico`".
5. **Someone in `PRUMO_DONOS` can force a release.** They run the Deploy workflow by hand with the tag, `force` and a reason. `release force` then:
   - comments on each `critico` issue without acceptance: «**Aceite forçado** · produção · <tag> · <run>», with the lines `Dono:`, `Motivo:` and `Revisão retroativa:`;
   - opens «Revisão retroativa · <tag> · aceite forçado», assigned to the mentor and labeled `critico`, which asks for «**Aceite** · produção · <link>» on each issue, or the fix.

   A forced comment is not an acceptance.
6. **The way back is the Rollback workflow, with `target: vA.B.C`.** `tools/release` resolves the tag to its commit, then rolls back as ADR-0029 decision 6 does, with its checks of barriers and secrets. A release that shipped nothing, because nothing that ships changed, has no version to go back to, and the rollback says so. Publishing an older release again fires nothing. The Deploy workflow never goes back:
   - on a release, it skips one whose commit production already contains (ADR-0031);
   - by hand, where `always` is on, it refuses a release older than a build production serves, and names the Rollback workflow.
7. **The Deploy workflow by hand takes a release's tag.** It deploys the release production serves again, or a newer one, with `always` on by default; it forces a release, or rotates the deep probe's token. It authorizes and gates as a release does.
8. **ADR-0031's skip still applies,** judged at the release's commit: a release that ships nothing deploys nothing, and a deploy that was missed goes out with the next release.

The rest of ADR-0029 and ADR-0031 stands.

## Consequences

- **Merges are quick and change nothing in production.** `main` can run many merges ahead of production. `/version` shows the build of the release production serves.
- **Done is merged.** While merges deploy nothing, `CLAUDE.md`'s Done needs no deploy.
- **The first release can only come after this merges:** the `release` event runs the workflow file at the tag.
- **Releases come from the owner's `gh`,** which the agent uses: one made with `GITHUB_TOKEN` would deploy nothing. GitHub can't tell the agent from the owner, since both sign as the owner. The local guard that keeps `--publish` to the owner's order is a follow-up.
- **One-time setup:** `production` accepts tags `v*` besides `main`; the variable `PRUMO_DONOS`; the label `critico`.
- **Release tags are guarded.** Whoever can push a `v*` tag runs that tag's copy of `deploy.yml` in the `production` environment. The tag ruleset «Release tags v*» stops anyone from creating, moving or deleting `refs/tags/v*`, except the Admin role. That includes the owner's token, and so the agent, which uses it.
- **The gate stops only pull requests by other authors.** Agents open pull requests as `guedesdiogo`, the mentor, so the acceptance a mentor's pull request carries covers every `critico` issue they close. The owner chose this: «a regra não vale se foi guedesdiogo quem esta criando o PR».
- **Until a release ships through the Deploy workflow,** the gate reads `main`'s whole history, so a `critico` issue merged long ago without acceptance stops the first release too.
- **A forced release whose deploy then fails** leaves no successful run. The next release's gate stops on the same issues until the mentor accepts them, or someone forces it again.
- **A rollback moves production, not the gate's base.** The next release's gate starts at the release the Deploy workflow last shipped, whose issues were accepted or forced.

## Alternatives considered

- **Staging now.** Merges would deploy to `kelpie-staging-*`. It doubles the instance and its cost; it stays a decision of its own.
- **A required reviewer on `production`.** It is free on a public repository, but adds a click to every release, and with one account it can't tell the agent from the owner.
- **Deploying on a pushed tag.** A tag carries no notes and no draft, and one pushed by mistake would deploy.
- **The gate reading the release's notes.** Anyone who can edit the release could change them.
- **The gate starting at the build production serves**, from Cloudflare's version tags, as the deploy reads it. It needs the Cloudflare token in the gate's job, which also writes on issues. The Deploy workflow's run history needs only `actions: read`.

## References

- [docs/deploy.md](../deploy.md), "Releases"
- `tools/release/src/critical.ts` (the gate and the force), `cut.ts` (the release) and `github.ts` (GitHub's API)
- `.github/workflows/deploy.yml` and `rollback.yml`
