# ADR-0031: A deploy skips when nothing that ships changed since the builds production serves

- Status: Accepted when the pull request for #250 merges
- Date: 2026-10-12
- Issue: [#250](https://github.com/guedesdiogo/kelpie/issues/250)
- Amends: [ADR-0029](0029-continuous-deployment-and-rollback.md), decision 2: a push to `main` deploys only when production lacks something that ships
- Amended by: [ADR-0066](0066-production-by-release.md), decisions 4 and 5: the Deploy job runs on a published release instead of every push, with `always` off
- Requested by the owner on 2026-10-12, on the suggestion to skip the deploy for merges that change only docs: «pode abrir as issues e pode paralelisar todos os 4 itens»

## Context

- **[ADR-0029](0029-continuous-deployment-and-rollback.md) deploys every push to `main`** that passes the gates: all six Workers, then a 10-minute watch, whatever the push changed.
- **#248 changed only `docs/`** and went through the full deploy anyway.
- **That deploy held up the next ones.** CI runs on `main` wait for each other, and GitHub keeps one waiting run per concurrency group: #246's run was cancelled when #240 merged behind it. #246's change reached production only because #240's deploy contained it.
- **The reference projects** (#250): hermes-agent filters its site deploy by path ([deploy-site.yml](https://github.com/NousResearch/hermes-agent/blob/c57331677d7fc46298a7159cf3a650853f0966c5/.github/workflows/deploy-site.yml#L1-L60)) [code]. Adapted here: the gates still run on every push, and the deploy decides against what production serves, not against the push.

## Decision

1. **A deploy skips when nothing that ships changed since the builds production serves.** Before it deploys, `tools/release` reads each Worker's live build tag. For each distinct live commit, it lists the paths that differ from the commit being deployed. A path ships when it is:
   - under `apps/`, `packages/`, `tools/release/` or `.github/actions/`;
   - `package.json`, `bun.lock`, `bunfig.toml`, `tsconfig.base.json` or `.github/workflows/deploy.yml`.

   Anything else, such as the docs, `ci.yml` or the CI scripts, ships nothing. The comparison is between trees, so the commits in between don't matter.

   A live build that already contains the commit, as when an older run is re-run, needs nothing from it. Deploying it would only go back.
2. **When it can't compare, it deploys.** That happens with a live version without a tag, or a live commit that the checkout lacks.
3. **A skipped deploy changes nothing.** It reads no analytics, writes a one-line summary and succeeds.
4. **The gates and the `Deploy` job still run on every push to `main`.** `CI passed` doesn't depend on the decision.
5. **By hand, `deploy.yml` deploys regardless.** Its `always` input is on by default there and off when CI calls it. From a terminal, `release deploy --always` does the same.

The rest of ADR-0029 stands.

## Consequences

- **A push that ships nothing** deploys nothing, probes nothing and doesn't watch. Its deploy job takes a minute or two instead of about 15. It still waits in the `production` group behind a running deploy.
- **A deploy that was missed catches up with the next push, whatever that push changes.** That covers a run that failed or was replaced while it waited. ADR-0029's "only the newest deploys, and it contains the others" holds again.
- **After an automatic rollback,** production serves the older build. The next push deploys `main` again, even if it changes only docs, so fix or revert the change first, as ADR-0029 says.
- **Production's build tag can trail `main`** by commits that ship nothing. `/version` reports the build that was deployed.
- **A path missing from the list** ships only with a change that ships, or a deploy by hand. `ci.yml` is not on the list, so a change to its `Deploy` job alone, like #241's, takes effect with the next deploy that runs.

## Alternatives considered

- **Deciding in CI from the push's own changes** (`HEAD^1` to the push), the first design of #250. It judges each push alone. A push that ships could miss its deploy, through a failed gate or a replaced run. If the next push shipped nothing, production would then stay behind `main` under a green run. A rebase merge of several commits would also be judged by its last commit only.
- **A `paths` filter on the push trigger,** as hermes-agent does for its site. It would skip the gates on `main` too, and it applies to a whole workflow, not to one job.
- **A third-party paths-filter action.** It would run another vendor's code in CI for a rule of a few lines, with no tests of its own here. It also judges the push, not production.

## References

- [docs/deploy.md](../deploy.md), "On merge"
- `tools/release/src/ships.ts` (the rule) and `tools/release/src/deploy.ts` (the decision)
