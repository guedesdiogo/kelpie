# Testing

## Where tests run

| Code | Runner | Runtime |
|---|---|---|
| `packages/*` (domain modules, no Cloudflare imports) | Vitest | Node |
| `apps/*` (Workers and Durable Objects) | Vitest with `@cloudflare/vitest-plugin` | workerd, configured from each Worker's `wrangler.jsonc` |

Domain modules stay runtime-agnostic (ADR-0002), so Node is enough for them. Anything that touches bindings, Durable Object storage or alarms runs inside workerd. No Cloudflare account or key is needed for either.

## Durable Objects and alarms

The plugin's `cloudflare:test` module provides what the conversation engine needs to be tested deterministically ([test APIs](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/)):

- `runDurableObjectAlarm(stub)` runs the object's scheduled alarm now and reports whether one ran. Tests fire alarms explicitly instead of waiting for them.
- `runInDurableObject(stub, (instance, state) => …)` runs a callback inside the object, for example to read `state.storage.getAlarm()`.
- `evictDurableObject(stub)` tears down the in-memory instance and keeps storage, to prove that state and alarms survive eviction.
- Storage is isolated per test file. Within a file, give each test its own object with `getByName("<test name>")`.

## Controlling time

Code that schedules alarms takes the current time as a parameter that defaults to `Date.now()`; see `DebounceBuffer.ingest(fragment, now)` in `apps/conversation-runtime`. Tests pass timestamps a minute in the future (`Date.now() + 60_000` plus offsets), so:

- assertions compare exact alarm times;
- no alarm lands in the past, where the runtime would fire it on its own during the test;
- alarms fire only when a test calls `runDurableObjectAlarm`.

## Commands

```bash
bun run test        # every workspace
bun run typecheck   # generates Workers types, then runs tsc in every workspace
bun run lint
```
