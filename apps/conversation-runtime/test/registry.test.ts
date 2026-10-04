import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// Each test uses its own Registry instance; Kelpie itself runs one, named REGISTRY_NAME.
const registry = (name: string) => env.REGISTRY.getByName(name);
const owner = { userId: "u-owner", role: "owner", via: "admin-api" } as const;

describe("Registry", () => {
  it("adds agents and lists them by id", async () => {
    const stub = registry("list");
    expect(await stub.add("sales", "Sales", owner)).toEqual({ ok: true, created: true });
    expect(await stub.add("assistant", "Assistant", owner)).toEqual({ ok: true, created: true });

    expect(await stub.list()).toEqual([
      { id: "assistant", name: "Assistant" },
      { id: "sales", name: "Sales" },
    ]);
    expect(await stub.get("sales")).toEqual({ id: "sales", name: "Sales" });
    expect(await stub.get("ghost")).toBeNull();
  });

  it("treats adding an existing agent as a retry: nothing changes", async () => {
    const stub = registry("idempotent");
    await stub.add("sales", "Sales", owner);

    expect(await stub.add("sales", "Another name", owner)).toEqual({ ok: true, created: false });
    expect(await stub.list()).toEqual([{ id: "sales", name: "Sales" }]);
  });

  it("renames an agent it knows, and only those", async () => {
    const stub = registry("rename");
    await stub.add("sales", "Sales", owner);

    expect(await stub.rename("sales", "Sales team", owner)).toEqual({ ok: true });
    expect(await stub.rename("ghost", "Nobody", owner)).toEqual({
      ok: false,
      reason: "unknown_agent",
    });
    expect(await stub.get("sales")).toEqual({ id: "sales", name: "Sales team" });
  });

  it("validates what it stores, because it is an RPC boundary", async () => {
    const stub = registry("validates");
    const invalid = { ok: false, reason: "invalid_input" };

    expect(await stub.add("Sales Team", "Sales", owner)).toEqual(invalid);
    expect(await stub.add("sales", "Sales\nteam", owner)).toEqual(invalid);
    expect(await stub.add("sales", "x".repeat(81), owner)).toEqual(invalid);
    await stub.add("sales", "Sales", owner);
    expect(await stub.rename("sales", " ", owner)).toEqual(invalid);
    expect(await stub.list()).toEqual([{ id: "sales", name: "Sales" }]);
  });

  it("audits each creation and rename, and nothing that changed nothing", async () => {
    const stub = registry("audited");
    await stub.add("sales", "Sales", owner);
    await stub.add("sales", "Sales", owner);
    await stub.rename("sales", "Sales team", { ...owner, via: "agent:setup" });
    await stub.rename("sales", "Sales team", owner);

    const audit = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec("SELECT action, agent_id, user_id, via FROM audit_log ORDER BY id")
        .toArray(),
    );
    expect(audit).toEqual([
      { action: "agent.created", agent_id: "sales", user_id: "u-owner", via: "admin-api" },
      { action: "agent.renamed", agent_id: "sales", user_id: "u-owner", via: "agent:setup" },
    ]);
  });
});
