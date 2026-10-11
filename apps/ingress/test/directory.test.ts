import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { ACCESS_SOURCE, ADMIN_AGENT_ID, type ChannelIdentity } from "@kelpie/access";
import type { ChannelId } from "@kelpie/channels";
import { describe, expect, it } from "vitest";
import type { Directory } from "../src/directory/directory.ts";

// Each test gets its own Directory object, so state doesn't leak between tests.
const directory = (name: string) => env.DIRECTORY.getByName(name);

const OWNER = "u-owner";
const telegram = { channel: "telegram", channelUserId: "1001" } as const;
const webchat = { channel: "webchat", channelUserId: "owner@example.com" } as const;

/** Pairs `identity` with the owner the way the bot does: a code issued, then redeemed. */
async function pair(stub: ReturnType<typeof directory>, identity: ChannelIdentity) {
  const issued = await stub.issuePairingCode(OWNER, identity.channel as ChannelId);
  if (!issued.ok) throw new Error(`no code: ${issued.reason}`);
  return stub.redeemPairingCode(issued.code, identity);
}

async function withEnabledOwner(name: string) {
  const stub = directory(name);
  await stub.registerOwner(OWNER);
  await pair(stub, telegram);
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
        timeZone: null,
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

  it("never enables a pending identity on request: only pairing does", async () => {
    const stub = directory("pending");
    await stub.registerOwner(OWNER);
    // Before pairing, identities were added as pending and enabled by a typed value.
    await runInDurableObject(stub, (_instance: Directory, state) => {
      state.storage.sql.exec(
        "INSERT INTO identities (channel, channel_user_id, user_id, status, updated_at) VALUES ('webchat', 'owner@example.com', 'u-owner', 'pending', 0)",
      );
    });

    expect(await stub.enableIdentity(webchat)).toEqual({ ok: false, reason: "not_paired" });
    // Nor by way of disabling it first.
    expect(await stub.disableIdentity(webchat)).toEqual({ ok: false, reason: "not_paired" });
    expect(await stub.enableIdentity(webchat)).toEqual({ ok: false, reason: "not_paired" });
    expect(await stub.admit(webchat, "sales")).toMatchObject({ admitted: false });

    expect(await pair(stub, webchat)).toEqual({ ok: true, userId: OWNER });
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
    expect(await pair(stub, { channel: "telegram", channelUserId: "3003" })).toEqual({
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
    expect(await pair(stub, { channel: "telegram", channelUserId: "" })).toEqual({
      ok: false,
      reason: "invalid_identity",
    });
    expect(await stub.issuePairingCode(OWNER, "fax" as ChannelId)).toEqual({
      ok: false,
      reason: "invalid_channel",
    });
    expect(await stub.issuePairingCode("u-nobody", "telegram")).toEqual({
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
    await stub.enableIdentity(telegram);

    expect(await auditActions(stub)).toEqual([
      "owner.registered",
      "pairing.code_issued",
      "identity.paired",
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
    await pair(stub, phone);
    await stub.disableIdentity(phone);

    const rows = await runInDurableObject(stub, (_instance: Directory, state) =>
      state.storage.sql.exec("SELECT * FROM audit_log ORDER BY id").toArray(),
    );
    expect(rows.map((row) => row.action)).toEqual([
      "owner.registered",
      "pairing.code_issued",
      "identity.paired",
      "identity.disabled",
    ]);
    expect(JSON.stringify(rows)).not.toContain(phone.channelUserId);
  });
});

describe("Directory first-run bootstrap", () => {
  const access = { channel: ACCESS_SOURCE, channelUserId: "7335d417-access-sub" } as const;

  it("registers the owner with their Access login enabled, in one step", async () => {
    const stub = directory("bootstrap");
    expect(await stub.ownerExists()).toBe(false);

    expect(await stub.bootstrapOwner(OWNER, access.channelUserId)).toEqual({ ok: true });

    expect(await stub.ownerExists()).toBe(true);
    expect(await stub.admit(access, ADMIN_AGENT_ID)).toEqual({
      admitted: true,
      userId: OWNER,
      role: "owner",
      timeZone: null,
    });
    const rows = await runInDurableObject(stub, (_instance: Directory, state) =>
      state.storage.sql.exec("SELECT action, channel FROM audit_log ORDER BY id").toArray(),
    );
    expect(rows).toEqual([
      { action: "owner.registered", channel: null },
      { action: "identity.added", channel: ACCESS_SOURCE },
      { action: "identity.enabled", channel: ACCESS_SOURCE },
    ]);
    expect(JSON.stringify(rows)).not.toContain(access.channelUserId);
  });

  it("works once: an existing owner disables it, even under concurrent calls", async () => {
    const stub = directory("bootstrap-once");
    const results = await Promise.all([
      stub.bootstrapOwner("u-a", "sub-a"),
      stub.bootstrapOwner("u-b", "sub-b"),
    ]);
    expect(results).toContainEqual({ ok: true });
    expect(results).toContainEqual({ ok: false, reason: "owner_exists" });

    const later = directory("bootstrap-after-owner");
    await later.registerOwner(OWNER);
    expect(await later.bootstrapOwner("u-other", "sub-other")).toEqual({
      ok: false,
      reason: "owner_exists",
    });
  });

  it("refuses empty ids, and lets no pairing add an Access identity", async () => {
    const stub = directory("bootstrap-input");
    expect(await stub.bootstrapOwner(OWNER, " ")).toEqual({ ok: false, reason: "invalid_user" });
    await stub.registerOwner(OWNER);

    expect(await stub.issuePairingCode(OWNER, ACCESS_SOURCE as ChannelId)).toEqual({
      ok: false,
      reason: "invalid_channel",
    });
    const issued = await stub.issuePairingCode(OWNER, "telegram");
    if (!issued.ok) throw new Error("no code");
    expect(await stub.redeemPairingCode(issued.code, access)).toEqual({
      ok: false,
      reason: "invalid_identity",
    });
  });

  it("never lets a status change touch the owner's Access login", async () => {
    const stub = directory("bootstrap-status");
    await stub.bootstrapOwner(OWNER, access.channelUserId);
    const refused = { ok: false, reason: "invalid_identity" };

    expect(await stub.disableIdentity(access)).toEqual(refused);
    expect(await stub.enableIdentity(access)).toEqual(refused);
    expect(await stub.admit(access, ADMIN_AGENT_ID)).toMatchObject({ admitted: true });
  });
});

describe("Directory access recovery", () => {
  const oldSub = { channel: ACCESS_SOURCE, channelUserId: "sub-old" } as const;
  const newSub = { channel: ACCESS_SOURCE, channelUserId: "sub-new" } as const;

  async function bootstrapped(name: string) {
    const stub = directory(name);
    await stub.bootstrapOwner(OWNER, oldSub.channelUserId);
    await pair(stub, telegram);
    return stub;
  }

  it("relinks the owner to a new Access login, and keeps their userId and channels", async () => {
    const stub = await bootstrapped("relink");

    expect(await stub.relinkOwnerAccess(newSub.channelUserId, "a".repeat(64))).toEqual({
      ok: true,
    });

    expect(await stub.admit(newSub, ADMIN_AGENT_ID)).toMatchObject({
      admitted: true,
      userId: OWNER,
    });
    expect(await stub.admit(oldSub, ADMIN_AGENT_ID)).toEqual({
      admitted: false,
      reason: "unknown_identity",
    });
    expect(await stub.admit(telegram, "sales")).toMatchObject({ admitted: true, userId: OWNER });
    const rows = await runInDurableObject(stub, (_instance: Directory, state) =>
      state.storage.sql.exec("SELECT action, channel FROM audit_log ORDER BY id").toArray(),
    );
    expect(rows.at(-1)).toEqual({ action: "owner.access_relinked", channel: ACCESS_SOURCE });
    expect(JSON.stringify(rows)).not.toContain("sub-");
  });

  it("takes each token once, even to relink to the login the owner already has", async () => {
    const stub = await bootstrapped("relink-once");
    expect(await stub.relinkOwnerAccess(oldSub.channelUserId, "b".repeat(64))).toEqual({
      ok: true,
    });
    expect(await stub.admit(oldSub, ADMIN_AGENT_ID)).toMatchObject({ admitted: true });
    // The spent token is still audited, though nothing else changed.
    expect((await auditActions(stub)).at(-1)).toBe("owner.access_relinked");
    expect(await stub.relinkOwnerAccess(newSub.channelUserId, "b".repeat(64))).toEqual({
      ok: false,
      reason: "token_spent",
    });
    expect(await stub.admit(newSub, ADMIN_AGENT_ID)).toMatchObject({ admitted: false });
  });

  it("refuses without an owner, with empty input, or for a login another user holds", async () => {
    expect(await directory("relink-empty").relinkOwnerAccess("sub-x", "c".repeat(64))).toEqual({
      ok: false,
      reason: "no_owner",
    });

    const stub = await bootstrapped("relink-refusals");
    for (const [sub, hash] of [
      [" ", "d".repeat(64)],
      ["sub-y", ""],
    ] as const) {
      expect(await stub.relinkOwnerAccess(sub, hash)).toEqual({
        ok: false,
        reason: "invalid_user",
      });
    }
    await runInDurableObject(stub, (_instance: Directory, state) => {
      state.storage.sql.exec(
        "INSERT INTO users (user_id, role, created_at) VALUES ('u-member', 'member', 0)",
      );
      state.storage.sql.exec(
        "INSERT INTO identities (channel, channel_user_id, user_id, status, updated_at) VALUES ('cloudflare-access', 'sub-member', 'u-member', 'enabled', 0)",
      );
    });
    expect(await stub.relinkOwnerAccess("sub-member", "e".repeat(64))).toEqual({
      ok: false,
      reason: "identity_taken",
    });
    expect(await stub.admit(oldSub, ADMIN_AGENT_ID)).toMatchObject({ admitted: true });
    // A refusal spends nothing: the same token still works for a login nobody holds.
    expect(
      (await auditActions(stub)).filter((action) => action === "owner.access_relinked"),
    ).toEqual([]);
    expect(await stub.relinkOwnerAccess(newSub.channelUserId, "e".repeat(64))).toEqual({
      ok: true,
    });
  });
});

describe("Directory time zone", () => {
  it("stores a user's zone in its canonical spelling, and admits with it", async () => {
    const stub = await withEnabledOwner("tz");
    expect(await stub.setTimeZone(OWNER, "america/sao_paulo")).toEqual({
      ok: true,
      timeZone: "America/Sao_Paulo",
    });
    expect(await stub.admit(telegram, "sales")).toMatchObject({ timeZone: "America/Sao_Paulo" });
    // Setting the same zone again changes nothing, so it isn't audited.
    await stub.setTimeZone(OWNER, "America/Sao_Paulo");
    expect(
      (await auditActions(stub)).filter((action) => action === "user.time_zone_changed"),
    ).toHaveLength(1);
  });

  it("refuses what isn't an IANA zone, and a user it doesn't know", async () => {
    const stub = await withEnabledOwner("tz-refusals");
    for (const zone of ["Mars/Phobos", "+03:00", ""]) {
      expect(await stub.setTimeZone(OWNER, zone)).toEqual({
        ok: false,
        reason: "invalid_time_zone",
      });
    }
    expect(await stub.setTimeZone("u-ghost", "UTC")).toEqual({
      ok: false,
      reason: "unknown_user",
    });
    expect(await stub.admit(telegram, "sales")).toMatchObject({ timeZone: null });
  });
});

describe("Directory pairing", () => {
  const stranger = { channel: "telegram", channelUserId: "6666" } as const;

  async function owned(name: string) {
    const stub = directory(name);
    await stub.registerOwner(OWNER);
    return stub;
  }

  async function issue(stub: ReturnType<typeof directory>) {
    const issued = await stub.issuePairingCode(OWNER, "telegram");
    if (!issued.ok) throw new Error(`no code: ${issued.reason}`);
    return issued;
  }

  it("issues an 8-character code for an hour, and keeps only its salted hash", async () => {
    const stub = await owned("pair-issue");
    const before = Date.now();
    const issued = await issue(stub);

    expect(issued.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    expect(issued.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(issued.expiresAt).toBeLessThanOrEqual(Date.now() + 3_600_000);
    const rows = await runInDurableObject(stub, (_instance: Directory, state) =>
      state.storage.sql.exec("SELECT * FROM pairing_codes").toArray(),
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(issued.code);
  });

  it("pairs the sender with the code's owner, enabled, and spends the code", async () => {
    const stub = await owned("pair-redeem");
    const { code } = await issue(stub);

    expect(await stub.redeemPairingCode(code, telegram)).toEqual({ ok: true, userId: OWNER });
    expect(await stub.admit(telegram, "sales")).toMatchObject({ admitted: true, userId: OWNER });
    expect(await stub.redeemPairingCode(code, stranger)).toEqual({
      ok: false,
      reason: "invalid_code",
    });
    expect(await stub.admit(stranger, "sales")).toMatchObject({ admitted: false });
  });

  it("ignores spacing and case, as chat apps may change them", async () => {
    const stub = await owned("pair-spacing");
    const { code } = await issue(stub);
    const typed = ` ${code.slice(0, 4).toLowerCase()} ${code.slice(4)} `;
    expect(await stub.redeemPairingCode(typed, telegram)).toEqual({ ok: true, userId: OWNER });
  });

  it("refuses an expired code, and an old code once a new one is issued", async () => {
    const stub = await owned("pair-expiry");
    const old = await issue(stub);
    const current = await issue(stub);
    expect(await stub.redeemPairingCode(old.code, telegram)).toMatchObject({
      reason: "invalid_code",
    });

    await runInDurableObject(stub, (_instance: Directory, state) => {
      state.storage.sql.exec("UPDATE pairing_codes SET expires_at = 0");
    });
    expect(await stub.redeemPairingCode(current.code, telegram)).toMatchObject({
      reason: "invalid_code",
    });
  });

  it("locks a sender out for an hour after five wrong codes, and nobody else", async () => {
    const stub = await owned("pair-lockout");
    const { code } = await issue(stub);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await stub.redeemPairingCode("WRONGCD2", stranger)).toMatchObject({
        reason: "invalid_code",
      });
    }
    // The lock is checked first, so even the right code fails for the locked sender.
    expect(await stub.redeemPairingCode(code, stranger)).toEqual({ ok: false, reason: "locked" });
    // The owner, on another account, can still pair.
    expect(await stub.redeemPairingCode(code, telegram)).toEqual({ ok: true, userId: OWNER });
    expect((await auditActions(stub)).filter((action) => action === "pairing.locked")).toHaveLength(
      1,
    );

    await runInDurableObject(stub, (_instance: Directory, state) => {
      state.storage.sql.exec("UPDATE pairing_failures SET locked_until = 0, last_failure_at = 0");
    });
    const next = await issue(stub);
    expect(await stub.redeemPairingCode(next.code, stranger)).toEqual({ ok: true, userId: OWNER });
  });

  it("keeps a lock until it ends, and lets wrong codes an hour apart start over", async () => {
    const stub = await owned("pair-window");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await stub.redeemPairingCode("WRONGCD2", stranger);
    }
    await runInDurableObject(stub, (_instance: Directory, state) => {
      state.storage.sql.exec(
        `UPDATE pairing_failures SET locked_until = ${Date.now() + 60_000}, last_failure_at = 0`,
      );
    });
    expect(await stub.redeemPairingCode((await issue(stub)).code, stranger)).toEqual({
      ok: false,
      reason: "locked",
    });

    const patient = { channel: "telegram", channelUserId: "7777" } as const;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await stub.redeemPairingCode("WRONGCD2", patient);
    }
    await runInDurableObject(stub, (_instance: Directory, state) => {
      state.storage.sql.exec(
        `UPDATE pairing_failures SET last_failure_at = ${Date.now() - 61 * 60_000} WHERE channel_user_id = '7777'`,
      );
    });
    await stub.redeemPairingCode("WRONGCD2", patient);
    expect(await stub.redeemPairingCode((await issue(stub)).code, patient)).toMatchObject({
      ok: true,
    });
  });

  it("pairs one account only when two redeem the same code at once", async () => {
    const stub = await owned("pair-race");
    const { code } = await issue(stub);
    const other = { channel: "telegram", channelUserId: "8888" } as const;

    const results = await Promise.all([
      stub.redeemPairingCode(code, telegram),
      stub.redeemPairingCode(code, other),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results).toContainEqual({ ok: false, reason: "invalid_code" });
    const enabled = (await stub.listIdentities()).filter((row) => row.status === "enabled");
    expect(enabled).toHaveLength(1);
  });

  it("forgets earlier wrong codes once the sender pairs", async () => {
    const stub = await owned("pair-reset");
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await stub.redeemPairingCode("WRONGCD2", telegram);
    }
    expect(await stub.redeemPairingCode((await issue(stub)).code, telegram)).toMatchObject({
      ok: true,
    });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await stub.redeemPairingCode("WRONGCD2", telegram);
    }
    expect(await stub.redeemPairingCode((await issue(stub)).code, telegram)).toMatchObject({
      ok: true,
    });
  });

  it("re-enables a disabled identity with a fresh code, which the owner issued on purpose", async () => {
    const stub = await withEnabledOwner("pair-disabled");
    await stub.disableIdentity(telegram);
    expect(await pair(stub, telegram)).toEqual({ ok: true, userId: OWNER });
    expect(await stub.admit(telegram, "sales")).toMatchObject({ admitted: true });
  });

  it("keeps pairing codes and senders' ids out of the audit log", async () => {
    const stub = await owned("pair-audit");
    const { code } = await issue(stub);
    await stub.redeemPairingCode("WRONGCD2", stranger);
    await stub.redeemPairingCode(code, telegram);
    const rows = await runInDurableObject(stub, (_instance: Directory, state) =>
      state.storage.sql.exec("SELECT * FROM audit_log").toArray(),
    );
    expect(JSON.stringify(rows)).not.toContain(code);
    expect(JSON.stringify(rows)).not.toContain(stranger.channelUserId);
    expect(JSON.stringify(rows)).not.toContain(telegram.channelUserId);
  });
});

describe("Directory stranger notices", () => {
  const sender = (id: number) => ({ channel: "telegram", channelUserId: String(id) }) as const;

  it("names the owner's app language as their account was last seen, kept through messages that name none (#187)", async () => {
    const stub = await withEnabledOwner("notice-language");
    await stub.admit(telegram, "kelpie", "pt-br");
    expect(await stub.noticeStranger(sender(7301))).toEqual({
      notify: true,
      ownerChannelUserId: telegram.channelUserId,
      ownerLanguage: "pt-br",
    });
    // A message without one, or with an odd one, keeps it.
    await stub.admit(telegram, "kelpie");
    await stub.admit(telegram, "kelpie", "x".repeat(36));
    expect(await stub.noticeStranger(sender(7302))).toMatchObject({ ownerLanguage: "pt-br" });
  });

  it("tells the owner about each stranger once, on the owner's own account there", async () => {
    const stub = await withEnabledOwner("notice-once");
    expect(await stub.noticeStranger(sender(7001))).toEqual({
      notify: true,
      ownerChannelUserId: telegram.channelUserId,
    });
    expect(await stub.noticeStranger(sender(7001))).toEqual({ notify: false });
  });

  it("can tell the owner again about a stranger whose notice couldn't be sent", async () => {
    const stub = await withEnabledOwner("notice-release");
    expect(await stub.noticeStranger(sender(7101))).toMatchObject({ notify: true });
    await stub.releaseStrangerNotice(sender(7101));
    expect(await stub.noticeStranger(sender(7101))).toMatchObject({ notify: true });
  });

  it("tells nobody while the owner has no account on that channel", async () => {
    const stub = directory("notice-unpaired");
    await stub.registerOwner(OWNER);
    expect(await stub.noticeStranger(sender(7002))).toEqual({ notify: false });
    // Once the owner pairs, the same stranger is news.
    await pair(stub, telegram);
    expect(await stub.noticeStranger(sender(7002))).toMatchObject({ notify: true });
  });

  it("stops at ten notices a day, and forgets a stranger after thirty days", async () => {
    const stub = await withEnabledOwner("notice-cap");
    for (let id = 8000; id < 8010; id += 1) {
      expect(await stub.noticeStranger(sender(id))).toMatchObject({ notify: true });
    }
    expect(await stub.noticeStranger(sender(8010))).toEqual({ notify: false });

    await runInDurableObject(stub, (_instance: Directory, state) => {
      state.storage.sql.exec("UPDATE noticed_senders SET noticed_at = 0");
    });
    expect(await stub.noticeStranger(sender(8000))).toMatchObject({ notify: true });
    const kept = await runInDurableObject(stub, (_instance: Directory, state) =>
      state.storage.sql.exec("SELECT channel_user_id FROM noticed_senders").toArray(),
    );
    expect(kept).toEqual([{ channel_user_id: "8000" }]);
  });
});
