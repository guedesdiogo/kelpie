# ADR-0010: Bun workspaces, strict TypeScript, Biome and Vitest with the Workers plugin

- Status: Accepted (the owner merged #30 after the tooling question)
- Date: 2026-10-03
- Issue: [#23](https://github.com/guedesdiogo/kelpie/issues/23)

## Context

Kelpie is a set of Workers plus domain modules that import nothing from the Agents SDK ([ADR-0002](0002-runtime-foundation.md)). It needs a monorepo layout, a test runner that runs code inside workerd (Durable Objects and alarms included), and lint and format rules that CI can enforce.

The owner asked how pnpm and Bun differ for this repository and whether Bun could replace only pnpm while the rest stays as recommended. In this repository the package manager only installs dependencies and runs scripts. Kelpie's code runs in workerd: tests run there through the Vitest plugin, and production runs on Cloudflare. The comparison:
- Bun 1.3 uses isolated installs by default in new workspaces, so it matches pnpm's guard against undeclared dependencies.
- The Vitest and Wrangler CLIs still run on Node either way, so CI needs Node with either choice.
- The owner already uses Bun in other projects.

Cloudflare's test integration was renamed on 2026-08-19 from `@cloudflare/vitest-pool-workers` to `@cloudflare/vitest-plugin`. It requires Vitest 4.1 or later.

## Decision

- **Package manager and workspaces:** Bun (`bun install`, `bun run`), with workspaces in `apps/*` (Workers) and `packages/*` (domain modules). `bunfig.toml` pins `linker = "isolated"`, and `packageManager` pins the Bun version.
- **Language:** TypeScript in strict mode, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `verbatimModuleSyntax`. Runtime types come from `wrangler types`, which the `typecheck` script writes to each Worker's `src/worker-configuration.d.ts`. That generated file is ignored by git and Biome. The types depend on the Worker's `compatibility_date` and flags, so a date bump is a deliberate change in its own pull request.
- **Lint and format:** Biome with the recommended preset.
- **Tests:** Vitest with `@cloudflare/vitest-plugin` (`cloudflareTest()`), so tests run inside workerd with each Worker's Wrangler config.
- **Root scripts:** `lint`, `format`, `typecheck` and `test`. The last two fan out to every workspace with `bun run --filter '*'`.

## Consequences

- A fresh clone needs Bun and Node 22 or later, and no third-party keys, to install, lint, typecheck and test.
- CI installs both Bun and Node.
- `bun run --filter '*'` silently skips a workspace that lacks the script, so every workspace must define `typecheck` and `test`. The CI story checks this.
- Bun's isolated linker has an open issue with TypeScript peer-dependency resolution for packages that lack a `types` export condition ([oven-sh/bun#29727](https://github.com/oven-sh/bun/issues/29727)). If it bites, the fallback is pnpm, which is a lockfile and script change.
- `biome migrate` turned the deprecated `recommended: true` into `preset: "none"`, which would have disabled every rule. The config sets `preset: "recommended"` explicitly, and a probe file confirmed that the rules fire.

## Alternatives considered

- **pnpm workspaces.** The most common choice in large TypeScript monorepos, and Node-only in CI. Kept as the fallback.
- **npm workspaces with ESLint and Prettier.** More configuration and slower tools, for no gain here.
- **Bun's own test runner.** It doesn't run code inside workerd, so Durable Object and alarm tests would not reflect production.

## References

- [Write your first test (Cloudflare docs)](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/)
- [Changelog: @cloudflare/vitest-pool-workers is now @cloudflare/vitest-plugin](https://developers.cloudflare.com/changelog/post/2026-08-19-vitest-plugin/)
- [Bun: isolated installs](https://bun.com/docs/pm/isolated-installs)
