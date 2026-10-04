import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Directory } from "../src/directory/directory.ts";

// Each test gets its own Directory object, so state doesn't leak between tests.
const directory = (name: string) => env.DIRECTORY.getByName(name);

const telegram = { channel: "telegram", channelUserId: "1001" } as const;
const webchat = { channel: "webchat", channelUserId: "owner@example.com" } as const;

async function withEnabledOwner(name: string) {
  const stub = directory(name);
  await stub.registerOwner("u-owner");
  await stub.addIdentity(telegram);
  await stub.enableIdentity(telegram);
  return stub;
}

describe("Directory", () => {
  it("admits the owner's enabled identity to any agent", async () => {
    const stub = await withEnabledOwner("enabled");

    for (const agentId of ["sales", "finance"]) {
      expect(await stub.admit(telegram, agentId)).toEqual({
        admitted: true,
        userId: "u-owner",
        role: "owner",
      });
    }
  });

  it("drops a sender it doesn't know", async () => {
    const stub = await withEnabledOwner("unknown");

    expect(await stub.admit({ channel: "telegram", channelUserId: "2002" }, "sales")).toEqual({
      admitted: false,
      reason: "unknown_identity",
    });
    // Same id on another channel is another identity.
    expect(await stub.admit({ channel: "whatsapp", channelUserId: "1001" }, "sales")).toEqual({
      admitted: false,
      reason: "unknown_identity",
    });
  });

  it("drops a pending identity until it is enabled", async () => {
    const stub = directory("pending");
    await stub.registerOwner("u-owner");

    expect(await stub.addIdentity(webchat)).toEqual({ ok: true, status: "pending" });
    expect(await stub.admit(webchat, "sales")).toMatchObject({ admitted: false });

    await stub.enableIdentity(webchat);
    expect(await stub.admit(webchat, "sales")).toMatchObject({ admitted: true });
  });

  it("drops a disabled identity on the next message", async () => {
    const stub = await withEnabledOwner("disable");
    await stub.disableIdentity(telegram);

    expect(await stub.admit(telegram, "sales")).toEqual({
      admitted: false,
      reason: "unknown_identity",
    });
  });

  it("accepts one owner only", async () => {
    const stub = directory("one-owner");
    expect(await stub.registerOwner("u-owner")).toEqual({ ok: true });
    expect(await stub.registerOwner("u-owner")).toEqual({ ok: true });
    expect(await stub.registerOwner("u-someone-else")).toEqual({
      ok: false,
      reason: "owner_exists",
    });
  });

  it("needs the owner before identities, and known identities to change status", async () => {
    const stub = directory("order");

    expect(await stub.addIdentity(telegram)).toEqual({ ok: false, reason: "no_owner" });
    await stub.registerOwner("u-owner");
    expect(await stub.enableIdentity(telegram)).toEqual({
      ok: false,
      reason: "unknown_identity",
    });
  });

  it("keeps an identity's status when it is added again", async () => {
    const stub = await withEnabledOwner("re-add");

    expect(await stub.addIdentity(telegram)).toEqual({ ok: true, status: "enabled" });
    expect(await stub.listIdentities()).toEqual([{ ...telegram, status: "enabled" }]);
  });

  it("keeps its state after eviction", async () => {
    const stub = await withEnabledOwner("evict");
    await evictDurableObject(stub);

    expect(await stub.admit(telegram, "sales")).toMatchObject({ admitted: true });
  });

  it("keeps identity values out of the audit log", async () => {
    const stub = await withEnabledOwner("audit");
    await stub.disableIdentity(telegram);

    const rows = await runInDurableObject(stub, (_instance: Directory, state) =>
      state.storage.sql.exec("SELECT * FROM audit_log ORDER BY id").toArray(),
    );
    expect(rows.map((row) => row.action)).toEqual([
      "owner.registered",
      "identity.added",
      "identity.enabled",
      "identity.disabled",
    ]);
    expect(JSON.stringify(rows)).not.toContain(telegram.channelUserId);
  });
});
