import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// Times are offsets from "now" so every alarm lands in the future and only fires when a test
// runs it explicitly with runDurableObjectAlarm.
const t0 = () => Date.now() + 60_000;
const buffer = (name: string) => env.DEBOUNCE_BUFFER.getByName(name);

describe("DebounceBuffer", () => {
  it("re-arms the alarm on every new fragment", async () => {
    const stub = buffer("re-arm");
    const start = t0();

    expect(await stub.ingest({ providerMessageId: "m1", text: "hi" }, start)).toEqual({
      duplicate: false,
      flushAt: start + 2_000,
    });
    expect(await stub.ingest({ providerMessageId: "m2", text: "so" }, start + 1_500)).toEqual({
      duplicate: false,
      flushAt: start + 3_500,
    });
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBe(start + 3_500);
    });
  });

  it("caps the wait at maxWaitMs from the first fragment", async () => {
    const stub = buffer("cap");
    const start = t0();

    for (const [i, offset] of [0, 3_000, 6_000, 7_500].entries()) {
      await stub.ingest({ providerMessageId: `m${i}`, text: `part ${i}` }, start + offset);
    }
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBe(start + 8_000);
    });
  });

  it("ignores a duplicate provider message id", async () => {
    const stub = buffer("dedupe");
    const start = t0();

    await stub.ingest({ providerMessageId: "m1", text: "hi" }, start);
    expect(await stub.ingest({ providerMessageId: "m1", text: "hi" }, start + 1_000)).toEqual({
      duplicate: true,
      flushAt: start + 2_000,
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.batches()).toEqual(["hi"]);
  });

  it("flushes the pending fragments, in order, as one batch when the alarm fires", async () => {
    const stub = buffer("flush");
    const start = t0();

    await stub.ingest({ providerMessageId: "b", text: "second" }, start + 500);
    await stub.ingest({ providerMessageId: "a", text: "first" }, start);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.batches()).toEqual(["first\nsecond"]);

    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
    });
    expect(await runDurableObjectAlarm(stub)).toBe(false);

    await stub.ingest({ providerMessageId: "c", text: "next turn" }, start + 20_000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.batches()).toEqual(["first\nsecond", "next turn"]);
  });

  it("ignores an id that was already flushed in an earlier batch", async () => {
    const stub = buffer("dedupe-after-flush");
    const start = t0();

    await stub.ingest({ providerMessageId: "m1", text: "hi" }, start);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect(await stub.ingest({ providerMessageId: "m1", text: "hi" }, start + 30_000)).toEqual({
      duplicate: true,
      flushAt: null,
    });
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
    });
    expect(await stub.batches()).toEqual(["hi"]);
  });

  it("keeps the pending batch and its alarm across an eviction", async () => {
    const stub = buffer("evict");
    const start = t0();

    await stub.ingest({ providerMessageId: "m1", text: "survives" }, start);
    await evictDurableObject(stub);

    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBe(start + 2_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.batches()).toEqual(["survives"]);
  });
});
