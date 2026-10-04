import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { DirectoryEntry } from "@kelpie/access";
import { describe, expect, it } from "vitest";

// Each test gets its own Directory object, so state doesn't leak between tests.
const directory = (name: string) => env.DIRECTORY.getByName(name);

const ana = { channel: "telegram", channelUserId: "1001" } as const;
const bruno = { channel: "telegram", channelUserId: "2002" } as const;

function member(version: number, agentIds: string[], identities = [ana]): DirectoryEntry {
  return { userId: "u-ana", version, deleted: false, role: "member", identities, agentIds };
}

describe("Directory", () => {
  it("drops a sender it doesn't know", async () => {
    const stub = directory("unknown");
    await stub.putUser(member(1, ["sales"]));

    expect(await stub.admit(bruno, "sales")).toEqual({
      admitted: false,
      reason: "unknown_identity",
    });
  });

  it("admits a granted agent and refuses the others", async () => {
    const stub = directory("grants");
    await stub.putUser(member(1, ["sales"]));

    expect(await stub.admit(ana, "sales")).toEqual({
      admitted: true,
      userId: "u-ana",
      role: "member",
    });
    expect(await stub.admit(ana, "finance")).toEqual({ admitted: false, reason: "no_grant" });
  });

  it("applies a revocation to the next message", async () => {
    const stub = directory("revoke");
    await stub.putUser(member(1, ["sales"]));
    await stub.putUser(member(2, []));

    expect(await stub.admit(ana, "sales")).toEqual({ admitted: false, reason: "no_grant" });
  });

  it("ignores a push older than the version it holds", async () => {
    const stub = directory("reorder");
    expect(await stub.putUser(member(5, []))).toEqual({ applied: true });
    expect(await stub.putUser(member(4, ["sales"]))).toEqual({ applied: false });

    expect(await stub.admit(ana, "sales")).toEqual({ admitted: false, reason: "no_grant" });
  });

  it("keeps a deleted user deleted when an older push arrives", async () => {
    const stub = directory("tombstone");
    await stub.putUser(member(1, ["sales"]));
    await stub.putUser({ userId: "u-ana", version: 3, deleted: true });
    await stub.putUser(member(2, ["sales"]));

    expect(await stub.admit(ana, "sales")).toEqual({
      admitted: false,
      reason: "unknown_identity",
    });
  });

  it("lets the owner reach every agent", async () => {
    const stub = directory("owner");
    await stub.putUser({
      userId: "u-owner",
      version: 1,
      deleted: false,
      role: "owner",
      identities: [bruno],
      agentIds: [],
    });

    expect(await stub.admit(bruno, "anything")).toEqual({
      admitted: true,
      userId: "u-owner",
      role: "owner",
    });
  });

  it("gives an identity to the user whose push lands last", async () => {
    const stub = directory("move");
    await stub.putUser(member(1, ["sales"]));
    await stub.putUser({
      userId: "u-carla",
      version: 2,
      deleted: false,
      role: "member",
      identities: [ana],
      agentIds: ["finance"],
    });

    expect(await stub.admit(ana, "finance")).toEqual({
      admitted: true,
      userId: "u-carla",
      role: "member",
    });
  });

  it("keeps its state after eviction", async () => {
    const stub = directory("evict");
    await stub.putUser(member(1, ["sales"]));
    await evictDurableObject(stub);

    expect(await stub.admit(ana, "sales")).toMatchObject({ admitted: true });
  });
});
