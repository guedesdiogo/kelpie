# Testing

## Where tests run

| Code | Runner | Runtime |
|---|---|---|
| `packages/*` (domain modules, no Cloudflare imports) | Vitest | Node |
| `packages/memory` and `packages/access` | Vitest with `@cloudflare/vitest-plugin` | workerd, from a test-only Worker in `test/wrangler.jsonc` |
| `apps/*` (Workers and Durable Objects) | Vitest with `@cloudflare/vitest-plugin` | workerd, configured from each Worker's `wrangler.jsonc` |
| `tools/release` (deploys, rollbacks and the migration gate) | Vitest, with fakes for Cloudflare's API and production, and throwaway git repositories | Node |
| `tools/runner` (the VPS runner, [runner.md](runner.md)) | Vitest, with its handler called directly and secret files in a throwaway folder | Node; the runner itself runs on Bun |

Domain modules stay runtime-agnostic (ADR-0002), so Node is enough for them. Anything that touches bindings, Durable Object storage or alarms runs inside workerd. No Cloudflare account or key is needed for either.

`packages/memory` imports nothing from Cloudflare, but its index runs on a Durable Object's SQLite, with FTS5. Its tests run in workerd so the index is tested on that SQLite. The test Worker's only Durable Object hosts the storage that each test hands to the index through `runInDurableObject`.

`packages/access` checks Cloudflare Access's JWTs with WebCrypto. Its tests run in workerd too, because Node's WebCrypto imports some keys that workerd refuses.

## Durable Objects and alarms

The plugin's `cloudflare:test` module provides what the conversation engine needs to be tested deterministically ([test APIs](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/)):

- `runDurableObjectAlarm(stub)` runs the object's scheduled alarm now and reports whether one ran. Tests fire alarms explicitly instead of waiting for them.
- `runInDurableObject(stub, (instance, state) => …)` runs a callback inside the object, for example to read `state.storage.getAlarm()`.
- `evictDurableObject(stub)` tears down the in-memory instance and keeps storage, to prove that state and alarms survive eviction.
- Storage is isolated per test file. Within a file, give each test its own object with `getByName("<test name>")`.

## Controlling time

The `ConversationAgent` in `apps/conversation-runtime` reads time from its clock port, never from `Date.now()` directly. The fake clock in `test/fakes.ts` starts a minute in the future and tests move it, so:

- assertions compare exact flush times;
- no flush schedule comes due during the test, because the Agents SDK runs only due schedules when its alarm fires;
- turns start when a test calls `flush()`, the method the schedule calls. One test sets the clock to real time, lets a short schedule come due and fires it with `runDurableObjectAlarm`.

## Agents and their ports

The `ConversationAgent` reaches the model, the channel, the clock and timers through ports (`src/ports.ts`). The Worker runs in the test's isolate, so a test swaps them with `replacePortsForTesting()` for fakes (`test/fakes.ts`). Production never calls the override. The fakes provide:

- a scripted model that can reply, refuse, fail, end without a reply, or hang until cancelled;
- an egress that records bubbles and can fail, hold or hang a send;
- a sleep that returns at once or waits for an abort.

A promise created inside a Durable Object can't be resolved from the test's context ("Cannot perform I/O on behalf of a different Durable Object"). A fake that must wait for the test therefore polls a plain flag, or waits on a timer of its own.

A `Response` created in a test can't have its body read inside a Worker call either, so a fake `fetch` builds each response when it is called, from a factory.

Fiber recovery after an eviction runs when the fiber's heartbeat alarm fires on the new instance. To test it, call `evictDurableObject(stub)`, then `runDurableObjectAlarm(stub)`.

`llm-gateway` and `channel-egress` are service bindings that don't exist in tests, so `vitest.config.ts` replaces them with stubs; the fake model and channel ports mean they're never called. The `llm-gateway` stub answers `ping()`, which the deploy probe's tests call (#234), and `describe()`, which a turn's identity section reads (#286); its `LlmGatewayAdmin` entrypoint is empty (#289).

`ingress`'s `vitest.config.ts` does the same for the Workers it binds: stub Workers with the entrypoints and objects it calls, among them a `DeployProbe` that finds every part ok, and the probe's token as a binding.

`admin-api` binds Durable Objects and entrypoints that live in other Workers. Its `vitest.config.ts` adds stub Workers that only declare those classes, so the runtime starts; its tests pass fakes to `handle()` and never call the objects. The one exception is `llm-gateway`'s `LlmGatewayAdmin` stub, which answers the Worker's own test of the model commands' wiring (#289).

The `ConversationAgent` reads its settings from a real `AgentHost` in the same test Worker. A test that changes settings configures its own agent through `env.AGENT_HOST`, so settings don't leak between tests.

## Coverage

CI runs every workspace's tests once, with coverage (`bun run test:coverage`), and its summary shows a coverage table for each workspace. A pull request that changes only docs skips them ([ADR-0038](adr/0038-pull-requests-run-affected-gates.md)).
- **The provider is Istanbul.** V8's coverage doesn't work inside workerd, so every workspace uses Istanbul for the same numbers everywhere.
- **What counts:** each workspace counts its own `src/**/*.ts`, covered by its own tests. A package's code exercised only by an app's tests doesn't count for the package, so tests belong in the workspace whose code they test. Two files are excluded: `tools/release/src/main.ts`, the CLI's wiring to the process, git, wrangler and Cloudflare, and `tools/runner/src/main.ts`, the runner's wiring to the process and Bun's server. Their decisions live in tested modules.
- **The floor ([ADR-0030](adr/0030-coverage-floor.md)).** Every workspace's `vitest.config.ts` sets 80% for statements, branches, functions and lines.
  - A run under any of them fails CI, so the pull request can't merge.
  - Above 80%, coverage may move without failing CI. The summary's table shows each workspace's numbers, so a drop is visible in review.
- **`check:workspaces`** fails a workspace without a `test:coverage` script that passes `--coverage`, or with a threshold missing or under 80.
- **New code comes with tests.** Every feature, fix or change of behavior brings tests that check the behavior, in the workspace whose code it changes. A fix starts with a test that reproduces the bug. A pull request without tests for new behavior says why in its Verification section.

## Commands

```bash
bun run test        # every workspace
bun run test:coverage   # the same, with coverage and each workspace's thresholds, as CI runs it
bun run typecheck   # generates Workers types, then runs tsc in every workspace
bun run lint
bun run --filter @kelpie/memory eval   # the memory evaluation (#108); half a minute, so not in `test`
bun run --cwd tools/release release guard --base origin/main   # CI's migration gate (docs/deploy.md)
bun run --cwd tools/release release gates --base origin/main   # the gates CI runs for this branch
```
