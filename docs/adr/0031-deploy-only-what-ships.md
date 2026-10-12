# ADR-0031: A push to main deploys only when it changes something that ships

- Status: Accepted when the pull request for #250 merges
- Date: 2026-10-12
- Issue: [#250](https://github.com/guedesdiogo/kelpie/issues/250)
- Amends: [ADR-0029](0029-continuous-deployment-and-rollback.md), decision 2: which pushes to `main` deploy
- Requested by the owner on 2026-10-12, on the suggestion to skip the deploy for merges that change only docs: «pode abrir as issues e pode paralelisar todos os 4 itens»

## Context

- **[ADR-0029](0029-continuous-deployment-and-rollback.md) deploys every push to `main`** that passes the gates: all six Workers, then a 10-minute watch, whatever the push changed.
- **#248 changed only `docs/`** and went through the full deploy anyway.
- **That deploy held up the next ones.** CI runs on `main` wait for each other, and GitHub keeps one waiting run per concurrency group: #246's run was cancelled when #240 merged behind it.
- **The reference projects** (#250): hermes-agent filters its site deploy by path ([deploy-site.yml](https://github.com/NousResearch/hermes-agent/blob/c57331677d7fc46298a7159cf3a650853f0966c5/.github/workflows/deploy-site.yml#L1-L60)) [code]. Adapted here: the gates still run on every push, and only the deploy is skipped.

## Decision

1. **A push to `main` deploys only when it changes something that ships.** CI lists the paths changed from the push's first parent (`HEAD^1`), the previous tip of `main` after a merge commit or a squash merge. It ships when any of them is:
   - under `apps/`, `packages/`, `tools/release/` or `.github/actions/`;
   - `package.json`, `bun.lock`, `bunfig.toml`, `tsconfig.base.json` or `.github/workflows/deploy.yml`.

   Anything else, such as the docs, `ci.yml` or the CI scripts, ships nothing.
2. **The gates are unchanged.** They run on every push, and `CI passed` doesn't depend on the decision. The `Changes` job decides with `tools/release`'s `ships` command, whose rule has its own tests.
3. **`deploy.yml` by hand deploys `main` regardless.**

The rest of ADR-0029 stands.

## Consequences

- **A push that ships nothing** takes only the gates' time, and leaves the `production` group free.
- **A path missing from the list** ships nothing until the next push that ships, or a deploy by hand. `ci.yml` is not on the list, so a change to its `Deploy` job alone, like #241's, takes effect with the next push that ships.
- **Residual: a waiting run can be replaced by one that ships nothing.** If a push that ships nothing replaces the waiting CI run of one that ships, that change doesn't deploy until the next push that ships. ADR-0029's "only the newest deploys, and it contains the others" holds only when the newest ships. The Actions tab shows the replaced run as cancelled; `deploy.yml` by hand deploys it.
- **Residual: a rebase merge of several commits is judged by its last commit.** `HEAD^1` is then the commit before it, not the previous tip of `main`. The repository allows rebase merges, but its merges so far are merge commits. The `Migrations` gate reads from `HEAD^1` the same way.

## Alternatives considered

- **A `paths` filter on the push trigger,** as hermes-agent does for its site. It would skip the gates on `main` too, and it applies to a whole workflow, not to one job.
- **A third-party paths-filter action.** It would run another vendor's code in CI for a rule of a few lines, without tests of its own here.
- **Deciding inside the deploy, from the live build to the push.** It closes the residual above, since it compares with what production serves. But every push would still enter the `production` environment and wait in its group. It stays an option if the residual bites.

## References

- [docs/deploy.md](../deploy.md), "On merge"
- `tools/release/src/ships.ts`
