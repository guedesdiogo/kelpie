import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { SETUP_AGENT_ID } from "@kelpie/config";
import { describe, expect, it } from "vitest";
import seedMainAgent from "../src/registry/migrations/0003_seed_main_agent.sql";

// Each test uses its own Registry instance; Kelpie itself runs one, named REGISTRY_NAME.
const registry = (name: string) => env.REGISTRY.getByName(name);
const owner = { userId: "u-owner", role: "owner", via: "admin-api" } as const;
/** Every registry starts with the setup agent (Story 3.11), Admin by its id (ADR-0036 §1). */
const SETUP = { id: SETUP_AGENT_ID, name: "Setup", role: "admin", owner: null, chat: true };
/** A new instance's main agent (#288). */
const KELPIE = { id: "kelpie", name: "Kelpie", role: "main", owner: null, chat: true };
/** An agent created after roles: a specialist the main agent owns, which doesn't chat yet. */
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
  it("starts with the setup agent and the main agent, and adding them again changes nothing", async () => {
    const stub = registry("setup");

    expect(await stub.list()).toEqual([KELPIE, SETUP]);
    expect(await stub.add(SETUP_AGENT_ID, "Another", owner)).toEqual({ ok: true, created: false });
    expect(await stub.add("kelpie", "Another", owner)).toEqual({ ok: true, created: false });
    expect(await stub.rename(SETUP_AGENT_ID, "Configuração", owner)).toEqual({ ok: true });
    expect(await stub.get(SETUP_AGENT_ID)).toEqual({ ...SETUP, name: "Configuração" });
  });

  it("adds agents as specialists of the main agent, with their chat off, and lists them by id", async () => {
    const stub = registry("list");
    expect(await stub.add("sales", "Sales", owner)).toEqual({ ok: true, created: true });
    expect(await stub.add("assistant", "Assistant", owner)).toEqual({ ok: true, created: true });

    expect(await stub.list()).toEqual([
      specialist("assistant", "Assistant"),
      KELPIE,
      specialist("sales", "Sales"),
      SETUP,
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
    expect(await stub.setMain("Sales", owner)).toEqual(invalid);
    expect(await stub.setChat("sales", "yes" as never, owner)).toEqual(invalid);
    expect(await stub.get("sales")).toEqual(specialist("sales", "Sales"));
  });

  it("audits each creation and rename, and nothing that changed nothing", async () => {
    const stub = registry("audited");
    await stub.add("sales", "Sales", owner);
    await stub.add("sales", "Sales", owner);
    await stub.rename("sales", "Sales team", { ...owner, via: "agent:setup" });
    await stub.rename("sales", "Sales team", owner);

    expect(await auditOf(stub)).toEqual([
      { action: "agent.created", agent_id: "sales", user_id: "u-owner", via: "admin-api" },
      { action: "agent.renamed", agent_id: "sales", user_id: "u-owner", via: "agent:setup" },
    ]);
  });
});

describe("Registry roles (#288)", () => {
  it("makes an agent the main agent: the previous one and every specialist become its own", async () => {
    const stub = registry("set-main");
    await stub.add("sales", "Sales", owner);
    await stub.add("bia", "Bia", owner);

    expect(await stub.setMain("bia", { ...owner, via: "agent:setup" })).toEqual({ ok: true });
    expect(await stub.list()).toEqual([
      { id: "bia", name: "Bia", role: "main", owner: null, chat: true },
      // The previous main agent keeps chatting, now as a specialist.
      { ...specialist("kelpie", "Kelpie", true), owner: "bia" },
      { ...specialist("sales", "Sales"), owner: "bia" },
      SETUP,
    ]);
    // New agents belong to the new main agent; choosing it again changes nothing.
    await stub.add("ops", "Ops", owner);
    expect(await stub.get("ops")).toEqual({ ...specialist("ops", "Ops"), owner: "bia" });
    expect(await stub.setMain("bia", owner)).toEqual({ ok: true });
    expect(await auditOf(stub)).toEqual([
      { action: "agent.created", agent_id: "sales", user_id: "u-owner", via: "admin-api" },
      { action: "agent.created", agent_id: "bia", user_id: "u-owner", via: "admin-api" },
      { action: "agent.main_set", agent_id: "bia", user_id: "u-owner", via: "agent:setup" },
      { action: "agent.created", agent_id: "ops", user_id: "u-owner", via: "admin-api" },
    ]);
  });

  it("never makes Admin the main agent, and knows only the agents it holds", async () => {
    const stub = registry("set-main-refused");
    expect(await stub.setMain(SETUP_AGENT_ID, owner)).toEqual({ ok: false, reason: "not_allowed" });
    expect(await stub.setMain("ghost", owner)).toEqual({ ok: false, reason: "unknown_agent" });
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

    for (const id of [SETUP_AGENT_ID, "kelpie"]) {
      expect(await stub.setChat(id, false, owner)).toEqual({ ok: false, reason: "not_allowed" });
    }
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

  it("seeds the main agent only where no agent but setup exists; older agents keep chatting", async () => {
    const stub = registry("before-roles");
    const ids = () =>
      runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(seedMainAgent);
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
    expect(await ids()).toEqual([{ id: "assistant" }, { id: SETUP_AGENT_ID }]);
    expect(await stub.get("assistant")).toEqual({
      id: "assistant",
      name: "Assistant",
      role: "specialist",
      owner: null,
      chat: true,
    });
    // With only the setup agent, the seed adds Kelpie.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM agents WHERE id = 'assistant'");
    });
    expect(await ids()).toEqual([{ id: "kelpie" }, { id: SETUP_AGENT_ID }]);
    expect(await stub.get("kelpie")).toEqual(KELPIE);
  });
});
