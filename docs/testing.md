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

Fiber recovery after an eviction runs when the fiber's heartbeat alarm fires on the new instance. To test it, call `evictDurableObject(stub)`, then `runDurableObjectAlarm(stub)`.

`llm-gateway` is a service binding that doesn't exist in tests, so `vitest.config.ts` replaces it with a stub; the fake model port means it's never called.

## Commands

```bash
bun run test        # every workspace
bun run typecheck   # generates Workers types, then runs tsc in every workspace
bun run lint
```
