# Kelpie: instructions for coding agents

## Language

Everything in this repository is written in English: code, comments, commit messages, docs, ADRs, issues, pull requests and labels.

## Design rules

- **Pluggable connectors.** Every external service (Postgres provider, Jev access path, model provider, channel, tool source) sits behind an interface and a config value. Ship one adapter first; adding another must be one new adapter plus configuration, with the provider's specific strengths still usable. Don't build extra adapters until they are asked for.
- Decisions recorded in `docs/adr/` are binding; changing one takes a new ADR.

## Reference projects

Kelpie learns from these projects. They are references, not dependencies:

- [Hermes Agent](https://github.com/NousResearch/hermes-agent): the personal agent harness Kelpie is modeled on, and a client of the same vault (Decision 3.13).
- [Hermes-Bot-Mode](https://github.com/NousResearch/Hermes-Bot-Mode): archived; it now lives in `hermes-agent` under `apps/desktop/src/plugins/hermes-bots/`. The reference for the bot roster and the management UI.
- [ai-memory](https://github.com/akitaonrails/ai-memory): Markdown memory with a wiki, temporal versions and the OKF format.
- [invokta](https://github.com/vinilana/invokta): tool and capability import, and an Obsidian context engine.

At the start of every story, before writing its plan, check how these projects solve the same problem:

- Read the source, not only the docs: their docs have drifted from the code before. Mark each claim `[code]` or `[doc]`.
- Post the findings on the story's issue as **adopt**, **adapt** or **avoid**, with links pinned to a commit. If none of them covers the topic, say so in one line.
- A finding that contradicts an ADR or an approved decision goes to the owner as a question; it never changes the design silently.
- Earlier findings are in `docs/research/` (notes 01 to 03) and on the stories' issues. Re-check them against the current source instead of trusting them.

## Work tracking

- Board: [Kelpie project](https://github.com/users/guedesdiogo/projects/1) (user project `guedesdiogo/1`, linked to this repository).
- Status flow: Backlog (issue has its plan) → Ready (plan approved by the owner) → In progress (branch open) → In review (PR open and verification posted on the issue) → Done (merged, and the deploy the merge triggers is green; while nothing deploys, merged is enough). Done never authorizes a merge.
- Issue titles: `[Epic N] <theme>`, `[Story N.M] <deliverable>` as a sub-issue of its epic, `[Decision N.M] <topic>` (closed by a merged ADR in `docs/adr/`), `[Follow-up N.M] <subject>`; ad-hoc issues carry no prefix.
- Labels: one of `type:epic`, `type:story`, `type:follow-up` or `type:decision` per issue; `epic:N` on everything that belongs to an epic; `security` when the change touches authentication, authorization, secrets or personal data.
- Issue body sections: Context, Goal, Out of scope, Plan, Acceptance criteria, Planned verification, Risks and rollback.
- Pull requests: one `Closes #N` line per story and a **Verification** section: residuals first, then what ran with real numbers, then what did not run and why. The same verification goes as a comment on the issue.
- Commits reference issues without closing keywords (`issue #N`).
- The owner may merge a pull request from the GitHub UI at any time. Before pushing to a branch with an open PR, check that the PR is still open (`gh pr view N --json state`). If it was merged, push to a new branch and open a follow-up PR.
- Don't stack pull requests: base every PR on a freshly fetched `main`, because the owner merges as soon as a PR looks right and `Closes` only applies to PRs into `main`. Work that depends on an open PR stays local until that PR merges.
- Never write bare `@handles` in issues, PRs or commits; put roles in backticks.

## Repository state

The viability study is `docs/viability-study.md`; research notes go in `docs/research/` and architecture decisions in `docs/adr/`.

- A pull request merges only when `CI passed` is green, its branch is up to date with `main`, and CodeQL found no new high-severity alert. `CI passed` covers lint, typecheck, the tests with each workspace's coverage thresholds, the Workers' bundles, the migration gate, workflow lint and dependency review (`docs/deploy.md`, `docs/testing.md`).
- Coverage can't drop. New code comes with tests; raise a workspace's thresholds in `vitest.config.ts` when its coverage rises.
- A merge into `main` deploys all six Workers, watches production and rolls back by itself when it is unhealthy (ADR-0029). Never deploy production by hand. A rollback on request goes through the Rollback workflow, which needs the owner's request.
- Migrations stay add-only, so production can roll back. A migration that drops, renames or rewrites data needs a `rollback-barrier` comment and the owner's agreement.
