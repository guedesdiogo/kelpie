# ADR-0030: Every workspace keeps at least 80% test coverage, and new code comes with tests

- Status: Accepted when the pull request for #242 merges
- Date: 2026-10-11
- Issue: [#242](https://github.com/guedesdiogo/kelpie/issues/242)
- Amends: [ADR-0029](0029-continuous-deployment-and-rollback.md), its coverage thresholds
- Requested by the owner on 2026-10-11: «precisamos manter o minimo de 80% de cobertura de testes, acima disso não precisa quebrar o CI se diminuir, porém devemos sempre criar testes para as implementações novas para garantir a qualidade da plataforma.»

## Context

[ADR-0029](0029-continuous-deployment-and-rollback.md) gated merges on test coverage with per-workspace thresholds, each a point under the coverage measured when it was set. Any drop above 80% failed CI.

The owner wants a floor instead: 80%, with movement above it allowed. Quality comes from writing tests for every new implementation, not from freezing today's numbers.

Coverage measured on 2026-10-11, with the tests added for this decision, was at least 80% for statements, branches, functions and lines in all 15 workspaces. The lowest numbers were functions in admin-api (81.39%) and branches in config (83.41%).

## Decision

1. **The floor.** Every workspace's `vitest.config.ts` sets 80% for statements, branches, functions and lines.
   - CI's `test:coverage` fails under any of them, so the pull request can't merge.
   - `check:workspaces` fails a workspace whose thresholds are missing or under 80.
2. **Above the floor, coverage may move.** A drop that stays at or above 80% doesn't fail CI. The run's summary still shows each workspace's numbers, so a review sees a drop.
3. **Every new implementation comes with tests**: a feature, a fix, or a change of behavior.
   - The tests check behavior, not lines. A fix starts with a test that reproduces the bug.
   - They live in the workspace whose code they test, where its coverage counts.
   - A pull request without tests for new behavior says why in its Verification section.
4. **What counts is unchanged:** each workspace's own `src/**/*.ts`, measured with Istanbul. `tools/release/src/main.ts` stays out, as the CLI's wiring.

## Consequences

- A workspace well above 80% can lose coverage without CI noticing. The coverage table in each run's summary, and the rule that new code brings tests, are what keep it there.
- A workspace near 80% (admin-api's functions, at 81.39%) fails CI with a small change that adds untested code. That is the floor working.

## Alternatives considered

- **Per-workspace ratchets** (ADR-0029 as merged). They catch every drop, but the owner asked to fail only under 80%.
- **Coverage of the changed lines only.** It would enforce tests for new code directly, but it needs a diff-coverage tool, and it reports lines, not behavior. The rule in decision 3 is kept in review instead.
