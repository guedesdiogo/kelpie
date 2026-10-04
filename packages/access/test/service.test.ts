import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";
import type { DirectoryEntry } from "../src/directory.ts";
import * as schema from "../src/schema.ts";
import { AccessError, AccessService } from "../src/service.ts";

// Postgres in memory (PGlite), built from the committed migrations. Production reaches Neon with
// node-postgres through Hyperdrive; only a run against Neon proves that path.

const migrationsFolder = decodeURIComponent(new URL("../migrations", import.meta.url).pathname);
const system = { userId: null };
const ana = { channel: "telegram", channelUserId: "1001" } as const;

async function setup() {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder });
  const pushes: DirectoryEntry[] = [];
  let failures = 0;
  const directory = {
    async putUser(entry: DirectoryEntry) {
      if (failures > 0) {
        failures -= 1;
        throw new Error("Directory unreachable");
      }
      pushes.push(entry);
    },
  };
  const service = new AccessService(db, directory);
  await service.registerAgent(system, { id: "sales", name: "Sales" });
  const userId = await service.createUser(system, { displayName: "Ana", role: "member" });
  return { db, service, pushes, userId, failNextPush: () => failures++ };
}

describe("AccessService", () => {
  it("pushes enabled identities and grants, with growing versions", async () => {
    const { service, pushes, userId } = await setup();
    const identityId = await service.addIdentity(system, userId, ana);
    expect(pushes).toEqual([]);

    await service.enableIdentity(system, identityId);
    await service.grantAgent(system, userId, "sales");

    expect(pushes).toEqual([
      expect.objectContaining({ identities: [ana], agentIds: [] }),
      {
        userId,
        version: expect.any(Number),
        deleted: false,
        role: "member",
        identities: [ana],
        agentIds: ["sales"],
      },
    ]);
    expect(pushes[1]?.version).toBeGreaterThan(pushes[0]?.version ?? Number.POSITIVE_INFINITY);
  });

  it("leaves pending and disabled identities out", async () => {
    const { service, pushes, userId } = await setup();
    const enabled = await service.addIdentity(system, userId, ana);
    await service.addIdentity(system, userId, { channel: "webchat", channelUserId: "ana@x" });
    await service.enableIdentity(system, enabled);
    await service.disableIdentity(system, enabled);

    expect(pushes.map((entry) => !entry.deleted && entry.identities)).toEqual([[ana], []]);
  });

  it("changes nothing when a restriction can't reach the Directory", async () => {
    const { db, service, pushes, userId, failNextPush } = await setup();
    await service.grantAgent(system, userId, "sales");
    failNextPush();

    await expect(service.revokeAgent(system, userId, "sales")).rejects.toThrow(
      "Directory unreachable",
    );
    expect(await db.select().from(schema.grants)).toHaveLength(1);
    const actions = (await db.select().from(schema.auditLog)).map((row) => row.action);
    expect(actions).not.toContain("grant.revoked");
    expect(pushes).toHaveLength(1);
  });

  it("commits a permission whose push failed, and resync delivers it", async () => {
    const { db, service, pushes, userId, failNextPush } = await setup();
    failNextPush();

    await expect(service.grantAgent(system, userId, "sales")).rejects.toThrow(
      "Directory unreachable",
    );
    expect(await db.select().from(schema.grants)).toHaveLength(1);
    expect(pushes).toEqual([]);

    await service.resyncUser(userId);
    expect(pushes).toEqual([expect.objectContaining({ agentIds: ["sales"] })]);
  });

  it("pushes a tombstone on delete and keeps the audit trail by id", async () => {
    const { db, service, pushes, userId } = await setup();
    const identityId = await service.addIdentity(system, userId, ana);
    await service.enableIdentity(system, identityId);
    await service.grantAgent(system, userId, "sales");

    await service.deleteUser(system, userId);

    expect(pushes.at(-1)).toEqual({ userId, version: expect.any(Number), deleted: true });
    expect(await db.select().from(schema.channelIdentities)).toEqual([]);
    expect(await db.select().from(schema.grants)).toEqual([]);
    const trail = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.targetUserId, userId));
    expect(trail.map((row) => row.action)).toEqual([
      "user.created",
      "identity.added",
      "identity.enabled",
      "grant.added",
      "user.deleted",
    ]);
  });

  it("keeps identity values out of the audit log", async () => {
    const { db, service, userId } = await setup();
    await service.addIdentity(system, userId, ana);

    const rows = await db.select().from(schema.auditLog);
    expect(JSON.stringify(rows)).not.toContain(ana.channelUserId);
  });

  it("refuses an identity that another user already has", async () => {
    const { service, userId } = await setup();
    const other = await service.createUser(system, { displayName: "Bruno", role: "member" });
    await service.addIdentity(system, userId, ana);

    await expect(service.addIdentity(system, other, ana)).rejects.toThrow();
  });

  it("reports an unknown user", async () => {
    const { service } = await setup();

    await expect(
      service.grantAgent(system, "00000000-0000-0000-0000-000000000000", "sales"),
    ).rejects.toBeInstanceOf(AccessError);
  });
});
