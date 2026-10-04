import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Directory } from "../src/directory/directory.ts";

// Each test gets its own Directory object, so state doesn't leak between tests.
const directory = (name: string) => env.DIRECTORY.getByName(name);

const OWNER = "u-owner";
const telegram = { channel: "telegram", channelUserId: "1001" } as const;
const webchat = { channel: "webchat", channelUserId: "owner@example.com" } as const;

async function withEnabledOwner(name: string) {
  const stub = directory(name);
  await stub.registerOwner(OWNER);
  await stub.addIdentity(OWNER, telegram);
  await stub.enableIdentity(telegram);
  return stub;
}

function auditActions(stub: ReturnType<typeof directory>) {
  return runInDurableObject(stub, (_instance: Directory, state) =>
    state.storage.sql
      .exec<{ action: string }>("SELECT action FROM audit_log ORDER BY id")
      .toArray()
      .map((row) => row.action),
  );
}

describe("Directory", () => {
  it("admits the owner's enabled identity to any agent", async () => {
    const stub = await withEnabledOwner("enabled");

    for (const agentId of ["sales", "finance"]) {
      expect(await stub.admit(telegram, agentId)).toEqual({
        admitted: true,
        userId: OWNER,
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
    // The same id on another channel is another identity.
    expect(await stub.admit({ channel: "whatsapp", channelUserId: "1001" }, "sales")).toEqual({
      admitted: false,
      reason: "unknown_identity",
    });
  });

  it("drops a pending identity until it is enabled", async () => {
    const stub = directory("pending");
    await stub.registerOwner(OWNER);

    expect(await stub.addIdentity(OWNER, webchat)).toEqual({ ok: true, status: "pending" });
    expect(await stub.admit(webchat, "sales")).toMatchObject({ admitted: false });

    await stub.enableIdentity(webchat);
    expect(await stub.admit(webchat, "sales")).toMatchObject({ admitted: true });
  });

  it("drops a disabled identity on the next message, and admits it again once re-enabled", async () => {
    const stub = await withEnabledOwner("disable");

    expect(await stub.disableIdentity(telegram)).toEqual({ ok: true, status: "disabled" });
    expect(await stub.admit(telegram, "sales")).toEqual({
      admitted: false,
      reason: "unknown_identity",
    });

    await stub.enableIdentity(telegram);
    expect(await stub.admit(telegram, "sales")).toMatchObject({ admitted: true });
  });

  it("refuses a user who isn't the owner, since grants wait for multi-user", async () => {
    const stub = await withEnabledOwner("member");
    await runInDurableObject(stub, (_instance: Directory, state) => {
      state.storage.sql.exec(
        "INSERT INTO users (user_id, role, created_at) VALUES ('u-member', 'member', 0)",
      );
      state.storage.sql.exec(
        "INSERT INTO identities (channel, channel_user_id, user_id, status, updated_at) VALUES ('telegram', '3003', 'u-member', 'enabled', 0)",
      );
    });

    expect(await stub.admit({ channel: "telegram", channelUserId: "3003" }, "sales")).toEqual({
      admitted: false,
      reason: "no_grant",
    });
    // An identity belongs to one user.
    expect(await stub.addIdentity(OWNER, { channel: "telegram", channelUserId: "3003" })).toEqual({
      ok: false,
      reason: "identity_taken",
    });
  });

  it("accepts one owner only, even under concurrent registrations", async () => {
    const stub = directory("one-owner");
    const results = await Promise.all([stub.registerOwner("u-a"), stub.registerOwner("u-b")]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: "owner_exists" }]);
  });

  it("refuses invalid input from callers", async () => {
    const stub = directory("invalid");

    expect(await stub.registerOwner("  ")).toEqual({ ok: false, reason: "invalid_user" });
    await stub.registerOwner(OWNER);
    expect(await stub.addIdentity(OWNER, { channel: "telegram", channelUserId: "" })).toEqual({
      ok: false,
      reason: "invalid_identity",
    });
    expect(
      await stub.addIdentity(OWNER, { channel: "fax" as "telegram", channelUserId: "1" }),
    ).toEqual({ ok: false, reason: "invalid_identity" });
    expect(await stub.addIdentity("u-nobody", telegram)).toEqual({
      ok: false,
      reason: "unknown_user",
    });
    expect(await stub.enableIdentity(telegram)).toEqual({
      ok: false,
      reason: "unknown_identity",
    });
  });

  it("writes no audit entry for a change that changes nothing", async () => {
    const stub = await withEnabledOwner("no-ops");
    await stub.registerOwner(OWNER);
    await stub.addIdentity(OWNER, telegram);
    await stub.enableIdentity(telegram);

    expect(await auditActions(stub)).toEqual([
      "owner.registered",
      "identity.added",
      "identity.enabled",
    ]);
    expect(await stub.listIdentities()).toEqual([{ ...telegram, status: "enabled" }]);
  });

  it("keeps its state after eviction", async () => {
    const stub = await withEnabledOwner("evict");
    await evictDurableObject(stub);

    expect(await stub.admit(telegram, "sales")).toMatchObject({ admitted: true });
  });

  it("keeps identity values out of the audit log", async () => {
    const stub = directory("audit");
    const phone = { channel: "whatsapp", channelUserId: "+5511987654321" } as const;
    await stub.registerOwner(OWNER);
    await stub.addIdentity(OWNER, phone);
    await stub.enableIdentity(phone);
    await stub.disableIdentity(phone);

    const rows = await runInDurableObject(stub, (_instance: Directory, state) =>
      state.storage.sql.exec("SELECT * FROM audit_log ORDER BY id").toArray(),
    );
    expect(rows.map((row) => row.action)).toEqual([
      "owner.registered",
      "identity.added",
      "identity.enabled",
      "identity.disabled",
    ]);
    expect(JSON.stringify(rows)).not.toContain(phone.channelUserId);
  });
});
