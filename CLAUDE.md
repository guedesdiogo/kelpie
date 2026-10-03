# Kelpie: instructions for coding agents

## Language

Everything in this repository is written in English: code, comments, commit messages, docs, ADRs, issues, pull requests and labels.

## Work tracking

- Board: [Kelpie project](https://github.com/users/guedesdiogo/projects/1) (user project `guedesdiogo/1`, linked to this repository).
- Status flow: Backlog (issue has its plan) → Ready (plan approved by the owner) → In progress (branch open) → In review (PR open and verification posted on the issue) → Done (merged, and the deploy the merge triggers is green; while nothing deploys, merged is enough). Done never authorizes a merge.
- Issue titles: `[Epic N] <theme>`, `[Story N.M] <deliverable>` as a sub-issue of its epic, `[Decision N.M] <topic>` (closed by a merged ADR in `docs/adr/`), `[Follow-up N.M] <subject>`; ad-hoc issues carry no prefix.
- Labels: one of `type:epic`, `type:story`, `type:follow-up` or `type:decision` per issue; `epic:N` on everything that belongs to an epic; `security` when the change touches authentication, authorization, secrets or personal data.
- Issue body sections: Context, Goal, Out of scope, Plan, Acceptance criteria, Planned verification, Risks and rollback.
- Pull requests: one `Closes #N` line per story and a **Verification** section: residuals first, then what ran with real numbers, then what did not run and why. The same verification goes as a comment on the issue.
- Commits reference issues without closing keywords (`issue #N`).
- Never write bare `@handles` in issues, PRs or commits; put roles in backticks.

## Repository state

Design phase: no code, build or test gates exist yet. The viability study is `docs/viability-study.md`; research notes go in `docs/research/` and architecture decisions in `docs/adr/`.
