import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { RETIRED_AGENT_ID } from "@kelpie/config";
import { describe, expect, it } from "vitest";
import seedMaster from "../src/registry/migrations/0003_seed_main_agent.sql";

// Each test uses its own Registry instance; Kelpie itself runs one, named REGISTRY_NAME.
const registry = (name: string) => env.REGISTRY.getByName(name);
const owner = { userId: "u-owner", role: "owner", via: "admin-api" } as const;
/** A new instance's Master (#288). */
const KELPIE = { id: "kelpie", name: "Kelpie", role: "master", owner: null, chat: true };
/** An agent created after roles: a specialist Master owns, which doesn't chat yet. */
const specialist = (id: string, name: string, chat = false) => ({
  id,
  name,
  role: "specialist",
  owner: "kelpie",
  chat,
});

async function auditOf(stub: ReturnType<typeof registry>) {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec("SELECT action, agent_id, user_id, via FROM audit_log ORDER BY id")
      .toArray(),
  );
}

describe("Registry", () => {
  it("starts with Master, and adding it again changes nothing", async () => {
    const stub = registry("setup");

    expect(await stub.list()).toEqual([KELPIE]);
    expect(await stub.add("kelpie", "Another", owner)).toEqual({ ok: true, created: false });
    expect(await stub.get("kelpie")).toEqual(KELPIE);
  });

  it("never lists nor answers for the retired id, and keeps its row (ADR-0048)", async () => {
    const stub = registry("retired-setup");
    const unknown = { ok: false, reason: "unknown_agent" };

    expect(await stub.get(RETIRED_AGENT_ID)).toBeNull();
    expect(await stub.add(RETIRED_AGENT_ID, "Another", owner)).toEqual({
      ok: false,
      reason: "invalid_input",
    });
    expect(await stub.rename(RETIRED_AGENT_ID, "Configuração", owner)).toEqual(unknown);
    expect(await stub.setMaster(RETIRED_AGENT_ID, owner)).toEqual(unknown);
    expect(await stub.setChat(RETIRED_AGENT_ID, false, owner)).toEqual(unknown);
    expect(await stub.remove(RETIRED_AGENT_ID, owner)).toEqual(unknown);
    expect(await stub.addSubagent(RETIRED_AGENT_ID, "Helper", "kelpie", owner)).toEqual({
      ok: false,
      reason: "not_allowed",
    });
    expect(await stub.list()).toEqual([KELPIE]);
    // A rollback finds it as it was, and nothing was audited.
    const row = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec("SELECT name, role, owner_id, chat FROM agents WHERE id = 'setup'")
        .toArray(),
    );
    expect(row).toEqual([{ name: "Setup", role: "specialist", owner_id: null, chat: 1 }]);
    expect(await auditOf(stub)).toEqual([]);
  });

  it("adds agents as specialists of Master, with their chat off, and lists them by id", async () => {
    const stub = registry("list");
    expect(await stub.add("sales", "Sales", owner)).toEqual({ ok: true, created: true });
    expect(await stub.add("assistant", "Assistant", owner)).toEqual({ ok: true, created: true });

    expect(await stub.list()).toEqual([
      specialist("assistant", "Assistant"),
      KELPIE,
      specialist("sales", "Sales"),
    ]);
    expect(await stub.get("sales")).toEqual(specialist("sales", "Sales"));
    expect(await stub.get("ghost")).toBeNull();
  });

  it("treats adding an existing agent as a retry: nothing changes", async () => {
    const stub = registry("idempotent");
    await stub.add("sales", "Sales", owner);

    expect(await stub.add("sales", "Another name", owner)).toEqual({ ok: true, created: false });
    expect(await stub.get("sales")).toEqual(specialist("sales", "Sales"));
  });

  it("renames an agent it knows, and only those", async () => {
    const stub = registry("rename");
    await stub.add("sales", "Sales", owner);

    expect(await stub.rename("sales", "Sales team", owner)).toEqual({ ok: true });
    expect(await stub.rename("ghost", "Nobody", owner)).toEqual({
      ok: false,
      reason: "unknown_agent",
    });
    expect(await stub.get("sales")).toEqual(specialist("sales", "Sales team"));
  });

  it("validates what it stores, because it is an RPC boundary", async () => {
    const stub = registry("validates");
    const invalid = { ok: false, reason: "invalid_input" };

    expect(await stub.add("Sales Team", "Sales", owner)).toEqual(invalid);
    expect(await stub.add("sales", "Sales\nteam", owner)).toEqual(invalid);
    expect(await stub.add("sales", "x".repeat(81), owner)).toEqual(invalid);
    await stub.add("sales", "Sales", owner);
    expect(await stub.rename("sales", " ", owner)).toEqual(invalid);
    expect(await stub.setMaster("Sales", owner)).toEqual(invalid);
    expect(await stub.setChat("sales", "yes" as never, owner)).toEqual(invalid);
    expect(await stub.get("sales")).toEqual(specialist("sales", "Sales"));
  });

  it("audits each creation and rename, and nothing that changed nothing", async () => {
    const stub = registry("audited");
    await stub.add("sales", "Sales", owner);
    await stub.add("sales", "Sales", owner);
    await stub.rename("sales", "Sales team", { ...owner, via: "agent:kelpie" });
    await stub.rename("sales", "Sales team", owner);

    expect(await auditOf(stub)).toEqual([
      { action: "agent.created", agent_id: "sales", user_id: "u-owner", via: "admin-api" },
      { action: "agent.renamed", agent_id: "sales", user_id: "u-owner", via: "agent:kelpie" },
    ]);
  });
});

describe("Registry roles (#288)", () => {
  it("makes an agent Master: the previous one and every specialist become its own", async () => {
    const stub = registry("set-master");
    await stub.add("sales", "Sales", owner);
    await stub.add("bia", "Bia", owner);

    expect(await stub.setMaster("bia", { ...owner, via: "agent:kelpie" })).toEqual({ ok: true });
    expect(await stub.list()).toEqual([
      { id: "bia", name: "Bia", role: "master", owner: null, chat: true },
      // The previous Master keeps chatting, now as a specialist.
      { ...specialist("kelpie", "Kelpie", true), owner: "bia" },
      { ...specialist("sales", "Sales"), owner: "bia" },
    ]);
    // New agents belong to the new Master; choosing it again changes nothing.
    await stub.add("ops", "Ops", owner);
    expect(await stub.get("ops")).toEqual({ ...specialist("ops", "Ops"), owner: "bia" });
    expect(await stub.setMaster("bia", owner)).toEqual({ ok: true });
    expect(await auditOf(stub)).toEqual([
      { action: "agent.created", agent_id: "sales", user_id: "u-owner", via: "admin-api" },
      { action: "agent.created", agent_id: "bia", user_id: "u-owner", via: "admin-api" },
      { action: "agent.main_set", agent_id: "bia", user_id: "u-owner", via: "agent:kelpie" },
      { action: "agent.created", agent_id: "ops", user_id: "u-owner", via: "admin-api" },
    ]);
  });

  it("knows only the agents it holds", async () => {
    const stub = registry("set-master-refused");
    expect(await stub.setMaster("ghost", owner)).toEqual({ ok: false, reason: "unknown_agent" });
    expect(await stub.get("kelpie")).toEqual(KELPIE);
  });

  it("turns a specialist's chat on and off, and only a specialist's", async () => {
    const stub = registry("set-chat");
    await stub.add("sales", "Sales", owner);

    expect(await stub.setChat("sales", true, owner)).toEqual({ ok: true });
    expect(await stub.get("sales")).toEqual(specialist("sales", "Sales", true));
    expect(await stub.setChat("sales", true, owner)).toEqual({ ok: true });
    expect(await stub.setChat("sales", false, owner)).toEqual({ ok: true });
    expect(await stub.get("sales")).toEqual(specialist("sales", "Sales"));

    expect(await stub.setChat("kelpie", false, owner)).toEqual({
      ok: false,
      reason: "not_allowed",
    });
    expect(await stub.setChat("ghost", true, owner)).toEqual({
      ok: false,
      reason: "unknown_agent",
    });
    expect(
      (await auditOf(stub)).filter(
        (row) => (row as { action: string }).action === "agent.chat_set",
      ),
    ).toHaveLength(2);
  });

  it("picks a Master on an instance that has none, as this one after the deploy", async () => {
    const stub = registry("no-master");
    // As an instance with agents from before roles: no Master, and no seed.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM agents WHERE id = 'kelpie'");
      state.storage.sql.exec(
        "INSERT INTO agents (id, name, created_at, updated_at) VALUES ('assistant', 'Assistant', 0, 0), ('sales', 'Sales', 0, 0)",
      );
    });
    // A new agent with no Master to own it has no owner yet.
    await stub.add("ops", "Ops", owner);
    expect(await stub.get("ops")).toEqual({ ...specialist("ops", "Ops"), owner: null });

    expect(await stub.setMaster("assistant", owner)).toEqual({ ok: true });
    expect(await stub.list()).toEqual([
      { id: "assistant", name: "Assistant", role: "master", owner: null, chat: true },
      { ...specialist("ops", "Ops"), owner: "assistant" },
      { ...specialist("sales", "Sales", true), owner: "assistant" },
    ]);
    // The retired id's row is left as it was (ADR-0048).
    const setupRow = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec("SELECT owner_id FROM agents WHERE id = 'setup'").one(),
    );
    expect(setupRow).toEqual({ owner_id: null });
  });

  it("holds the roles' rules whatever a row says, and refuses a subagent's changes", async () => {
    const stub = registry("clamps");
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE agents SET chat = 0 WHERE id = 'kelpie'");
      state.storage.sql.exec(
        "INSERT INTO agents (id, name, created_at, updated_at, role, owner_id, chat) VALUES ('helper', 'Helper', 0, 0, 'subagent', 'kelpie', 1)",
      );
    });
    expect(await stub.get("kelpie")).toEqual(KELPIE);
    expect(await stub.get("helper")).toEqual({
      id: "helper",
      name: "Helper",
      role: "subagent",
      owner: "kelpie",
      chat: false,
    });
    expect(await stub.setMaster("helper", owner)).toEqual({ ok: false, reason: "not_allowed" });
    expect(await stub.setChat("helper", true, owner)).toEqual({ ok: false, reason: "not_allowed" });
  });

  it("seeds Master only where no agent but setup exists; older agents keep chatting", async () => {
    const stub = registry("before-roles");
    const ids = () =>
      runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(seedMaster);
        return state.storage.sql
          .exec<{ id: string }>("SELECT id FROM agents ORDER BY id")
          .toArray();
      });
    // An instance with an agent from before #288: the columns' defaults, and no seed.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM agents WHERE id = 'kelpie'");
      state.storage.sql.exec(
        "INSERT INTO agents (id, name, created_at, updated_at) VALUES ('assistant', 'Assistant', 0, 0)",
      );
    });
    expect(await ids()).toEqual([{ id: "assistant" }, { id: RETIRED_AGENT_ID }]);
    expect(await stub.get("assistant")).toEqual({
      id: "assistant",
      name: "Assistant",
      role: "specialist",
      owner: null,
      chat: true,
    });
    // With only the retired id's row, the seed adds Kelpie.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM agents WHERE id = 'assistant'");
    });
    expect(await ids()).toEqual([{ id: "kelpie" }, { id: RETIRED_AGENT_ID }]);
    expect(await stub.get("kelpie")).toEqual(KELPIE);
  });

  it("removes an agent and audits it, and refuses Master and unknown ids (#303)", async () => {
    const stub = registry("remove");
    await stub.add("sales", "Sales", owner);

    expect(await stub.remove("sales", owner)).toEqual({ ok: true });
    expect(await stub.get("sales")).toBeNull();
    expect(await stub.list()).toEqual([KELPIE]);
    expect((await auditOf(stub)).at(-1)).toEqual({
      action: "agent.deleted",
      agent_id: "sales",
      user_id: "u-owner",
      via: "admin-api",
    });

    expect(await stub.remove("kelpie", owner)).toEqual({ ok: false, reason: "not_allowed" });
    expect(await stub.remove("sales", owner)).toEqual({ ok: false, reason: "unknown_agent" });
    expect(await stub.remove("Not An Agent", owner)).toEqual({
      ok: false,
      reason: "invalid_input",
    });
    expect(await stub.list()).toEqual([KELPIE]);
  });

  it("removes an agent only once nothing is owned by it, so no subagent loses its owner", async () => {
    const stub = registry("remove-owner");
    await stub.add("sales", "Sales", owner);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO agents (id, name, created_at, updated_at, role, owner_id, chat) VALUES ('helper', 'Helper', 0, 0, 'subagent', 'sales', 0)",
      );
    });

    expect(await stub.remove("sales", owner)).toEqual({ ok: false, reason: "not_allowed" });
    expect(await stub.remove("helper", owner)).toEqual({ ok: true });
    expect(await stub.remove("sales", owner)).toEqual({ ok: true });
    expect(
      (await auditOf(stub))
        .filter((row) => row.action === "agent.deleted")
        .map((row) => row.agent_id),
    ).toEqual(["helper", "sales"]);
  });
});

describe("Registry subagents (#290)", () => {
  const subagent = (id: string, name: string, creator: string) => ({
    id,
    name,
    role: "subagent",
    owner: creator,
    chat: false,
  });

  it("adds a creator's subagents, at most three live, with no chat", async () => {
    const stub = registry("subagents");
    for (const id of ["kelpie-sub-1", "kelpie-sub-2", "kelpie-sub-3"]) {
      expect(await stub.addSubagent(id, "Helper", "kelpie", owner)).toEqual({ ok: true });
    }
    expect(await stub.get("kelpie-sub-1")).toEqual(subagent("kelpie-sub-1", "Helper", "kelpie"));
    expect(await stub.addSubagent("kelpie-sub-4", "Helper", "kelpie", owner)).toEqual({
      ok: false,
      reason: "not_allowed",
    });
    // A deleted one frees its place.
    expect(await stub.remove("kelpie-sub-1", owner)).toEqual({ ok: true });
    expect(await stub.addSubagent("kelpie-sub-4", "Helper", "kelpie", owner)).toEqual({ ok: true });
    expect((await auditOf(stub)).filter((row) => row.action === "agent.created").at(-1)).toEqual({
      action: "agent.created",
      agent_id: "kelpie-sub-4",
      user_id: "u-owner",
      via: "admin-api",
    });
  });

  it("refuses a creator it doesn't know, a subagent as creator, and an id taken", async () => {
    const stub = registry("subagents-refused");
    expect(await stub.addSubagent("ghost-sub-1", "Helper", "ghost", owner)).toEqual({
      ok: false,
      reason: "unknown_agent",
    });
    await stub.addSubagent("kelpie-sub-1", "Helper", "kelpie", owner);
    expect(await stub.addSubagent("kelpie-sub-1-sub-1", "Deeper", "kelpie-sub-1", owner)).toEqual({
      ok: false,
      reason: "not_allowed",
    });
    expect(await stub.addSubagent("kelpie", "Taken", "kelpie", owner)).toEqual({
      ok: false,
      reason: "not_allowed",
    });
    expect(await stub.addSubagent("Not An Id", "Helper", "kelpie", owner)).toEqual({
      ok: false,
      reason: "invalid_input",
    });
  });

  it("counts only a creator's subagents against its day, not the agents Master creates (ADR-0048)", async () => {
    const stub = registry("subagents-master");
    const master = { userId: "u-owner", role: "owner", via: "agent:kelpie" } as const;
    for (let i = 0; i < 10; i++) {
      expect(await stub.add(`agent-${i}`, "Agent", master)).toEqual({ ok: true, created: true });
    }
    expect(await stub.addSubagent("kelpie-sub-m1", "Helper", "kelpie", master)).toEqual({
      ok: true,
    });
  });

  it("lets a creator make at most ten in a day, however many it deleted", async () => {
    const stub = registry("subagents-churn");
    const agentActor = { userId: "u-owner", role: "owner", via: "agent:kelpie" } as const;
    for (let i = 0; i < 10; i++) {
      expect(await stub.addSubagent(`kelpie-sub-c${i}`, "Helper", "kelpie", agentActor)).toEqual({
        ok: true,
      });
      await stub.remove(`kelpie-sub-c${i}`, agentActor);
    }
    expect(await stub.addSubagent("kelpie-sub-c10", "Helper", "kelpie", agentActor)).toEqual({
      ok: false,
      reason: "not_allowed",
    });
  });
});
