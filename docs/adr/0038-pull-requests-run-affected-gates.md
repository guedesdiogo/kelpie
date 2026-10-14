# ADR-0038: A pull request runs only the CI gates its changes can affect

- Status: Accepted when the pull request for #292 merges
- Date: 2026-10-13
- Issue: [#292](https://github.com/guedesdiogo/kelpie/issues/292)
- Amends: [ADR-0029](0029-continuous-deployment-and-rollback.md), decision 1: a pull request skips the gates its changes can't affect
- Requested by the owner on 2026-10-13: «Para cada runner que é executado no PR que geramos, deveria ter uma verificação se deveria mesmo estar executando ou simplesmente dando skipped naquele runner especifico.» The plan on #292 was approved with «pode seguir»

## Context

- **[ADR-0029](0029-continuous-deployment-and-rollback.md) runs every gate on every pull request.** `CI passed` aggregates them, and it is the one check the ruleset requires.
- **A docs-only pull request ran all five gates.** For #285, which changed only `docs/adr`, that took about 2 minutes on 7 runners ([run 38491778125](https://github.com/guedesdiogo/kelpie/actions/runs/38491778125)). Lint, typecheck and test took 1m57s of them.
- **None of the gates reads the Markdown docs.** Biome excludes `**/*.md`, the bundles take only `*.sql` as text, and no test or migration reads a Markdown file from the repository. Biome does check the JSON results under `docs/spikes/`.
- **Of the last 30 merges into `main`, 8 changed only docs.**
- **The reference projects** (#292). hermes-agent runs a `detect` job first, gates each lane on its outputs, and fails open on pushes ([ci.yaml](https://github.com/NousResearch/hermes-agent/blob/d97007c32d6340f7ba79ac1dfb5773cc00846448/.github/workflows/ci.yaml#L67-L124)) [code]. ai-memory does the same with a third-party action, which [ADR-0031](0031-deploy-only-what-ships.md) turned down.

## Decision

1. **A first job, `Detect changes`, decides which gates a pull request runs.** It lists the paths from the base (`HEAD^1`, `main`'s tip in the pull request's merge commit) to `HEAD`. `release gates` in `tools/release` writes one output per gate:

   | Gate | Runs when a changed path is |
   |---|---|
   | `Lint, typecheck and test` | anything but the docs (the Markdown files under `docs/` and at the root, and `LICENSE`) and the files under `.github/` that only GitHub reads, such as `rollback.yml` and `dependabot.yml` |
   | `Build Workers` | something that ships ([ADR-0031](0031-deploy-only-what-ships.md)), or `ci.yml` |
   | `Migrations` | the same as `Build Workers` |
   | `Workflow lint` | under `.github/` |
   | `Dependency review` | a `package.json`, `bun.lock`, or under `.github/` |

   A path no rule names runs lint and tests. An empty change, or a path git quotes for its unusual characters (`"caf\303\251.ts"`), runs every gate, since the rule can't judge it.
2. **A gate skips only on an explicit `false`.** Each gate's `if:` checks that its output isn't `false`, so an output the job didn't write runs the gate.
3. **The rule never judges a change to itself.** When a pull request changes `tools/release/` or `ci.yml`, `Detect changes` doesn't ask the rule, and every gate runs. Otherwise it runs the rule with `bun src/main.ts` from `tools/release`, not `bun run`, which would put the checkout's `node_modules/.bin` ahead of git and Bun on the `PATH`. A pull request could commit a fake `git` there.
4. **A push to `main` runs every gate,** as [ADR-0031](0031-deploy-only-what-ships.md) decision 4 says. `Detect changes` doesn't ask the rule there either.
5. **`CI passed` accepts only the skips `Detect changes` decided.** It fails when `Detect changes` doesn't succeed, and when a gate that had to run skipped, failed or was cancelled. `Dependency review` still skips outside pull requests.

## Consequences

- **A docs-only pull request** runs `Detect changes` and `CI passed`, and its five gates show as skipped. The ruleset needs no change, as it requires only `CI passed`.
- **A rule that misses an input** lets a pull request merge without a gate it needed. The push to `main` runs every gate before the deploy, so such a change turns `main` red and deploys nothing. The fix goes into the rule, with a test.
- **The rule runs the pull request's own code,** as every gate does. A pull request can still make its gates lie, by editing their scripts as much as by editing the rule. The owner's review, and the push to `main` that runs every gate before the deploy, are what stop it.
- **The rule lives in `tools/release/src/gates.ts`,** next to `ships.ts`, with Vitest tests. `Detect changes` installs only Bun, as `tools/release` needs no dependencies to run.
- **CodeQL keeps running on every pull request.** GitHub's default setup runs it outside `ci.yml`, and the ruleset needs its results.

## Alternatives considered

- **A `paths` filter on the `pull_request` trigger.** It applies to the whole workflow, not to one gate. A workflow it skips never reports `CI passed`, so the pull request can't merge.
- **A third-party paths-filter action,** as ai-memory uses. [ADR-0031](0031-deploy-only-what-ships.md) turned it down: another vendor's code in CI for a rule of a few lines, with no tests here.
- **The rule as a shell script in `ci.yml`.** It would protect itself, as any change to `ci.yml` runs every gate, but it would have no tests.
- **Skipping gates on `main` too.** The deploy needs them, and they catch what a pull request skipped.

## References

- [docs/deploy.md](../deploy.md), "The gates"
- `tools/release/src/gates.ts` (the rule) and `.github/workflows/ci.yml` (`Detect changes` and `CI passed`)
