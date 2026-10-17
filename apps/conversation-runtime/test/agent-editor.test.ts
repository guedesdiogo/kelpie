import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type Actor, type Mascot, REGISTRY_NAME } from "@kelpie/config";
import { describe, expect, it } from "vitest";
import { AgentEditor } from "../src/agent-editor.ts";
import * as worker from "../src/index.ts";

// What ingress binds for the webchat's agent editor (#379): an agent's mascot, name, remit and
// specialty, each through its configuration command, and nothing else. The commands check the
// actor again, so a member, or a stolen session that isn't the owner's, changes nothing.

const owner: Actor = { userId: "u-owner", role: "owner", via: "webchat" };
const member: Actor = { userId: "u-member", role: "member", via: "webchat" };
const admin = { userId: "u-owner", role: "owner", via: "admin-api" } as const;

// Called in place, as AgentLooks's test does: the Worker's own RPC loopback sometimes hangs in a
// run of many files. Ingress's tests cover the binding.
const editor = new AgentEditor(createExecutionContext(), env);
const registry = env.REGISTRY.getByName(REGISTRY_NAME);
const settingsOf = async (id: string) => (await env.AGENT_HOST.getByName(id).config()).settings;

const picked: Mascot = {
  shape: "star",
  color: "pink",
  eyes: "frog",
  cheeks: true,
  head: { type: "horns", variation: "one" },
  accessory: { type: "hat", variation: "beanie" },
};

describe("AgentEditor", () => {
  it("is an entrypoint of the Worker, which ingress's AGENT_EDITOR binding names", () => {
    expect(worker.AgentEditor).toBe(AgentEditor);
  });

  it("sets an agent's mascot, whole, and answers with the one it now shows", async () => {
    await registry.add("editor-sales", "Sales", admin);
    expect(await editor.setMascot(owner, "editor-sales", picked)).toEqual({
      ok: true,
      value: picked,
    });
    expect((await settingsOf("editor-sales")).mascot).toEqual(picked);
  });

  it("passes only the mascot: nothing else of the input reaches the agent's settings", async () => {
    await registry.add("editor-only", "Only", admin);
    const before = await settingsOf("editor-only");
    for (const input of [
      { ...picked, tier: "frontier" },
      { mascot: picked, tier: "frontier" },
      { ...picked, shape: "triangle" },
      null,
      "star",
    ]) {
      expect(await editor.setMascot(owner, "editor-only", input), JSON.stringify(input)).toEqual({
        ok: false,
        reason: "invalid_input",
      });
    }
    expect(await settingsOf("editor-only")).toEqual(before);
  });

  it("renames an agent, and sets its remit and its specialty", async () => {
    await registry.add("editor-agenda", "Agenda", admin);
    expect(await editor.rename(owner, "editor-agenda", " Agenda e Mail ")).toEqual({
      ok: true,
      value: "Agenda e Mail",
    });
    expect((await registry.get("editor-agenda"))?.name).toBe("Agenda e Mail");
    expect(await editor.setRemit(owner, "editor-agenda", "Books meetings.")).toEqual({
      ok: true,
      value: "Books meetings.",
    });
    expect(await editor.setSpecialty(owner, "editor-agenda", "Agenda e e-mail")).toEqual({
      ok: true,
      value: "Agenda e e-mail",
    });
    expect(await settingsOf("editor-agenda")).toMatchObject({
      remit: "Books meetings.",
      specialty: "Agenda e e-mail",
    });
  });

  it("refuses what a field doesn't take", async () => {
    await registry.add("editor-limits", "Limits", admin);
    const invalid = { ok: false, reason: "invalid_input" };
    expect(await editor.rename(owner, "editor-limits", "Two\nlines")).toEqual(invalid);
    expect(await editor.rename(owner, "editor-limits", " ")).toEqual(invalid);
    expect(await editor.setRemit(owner, "editor-limits", "a".repeat(201))).toEqual(invalid);
    expect(await editor.setSpecialty(owner, "editor-limits", "a".repeat(41))).toEqual(invalid);
    expect(await editor.setSpecialty(owner, "editor-limits", { specialty: "x" })).toEqual(invalid);
    expect((await registry.get("editor-limits"))?.name).toBe("Limits");
  });

  it("keeps the main agent's specialty: always principal (#379)", async () => {
    expect(await editor.setSpecialty(owner, "kelpie", "Agenda")).toEqual({
      ok: false,
      reason: "not_allowed",
    });
    expect((await settingsOf("kelpie")).specialty).toBe("");
    // Its remit stays the owner's to change.
    expect(await editor.setRemit(owner, "kelpie", "Your day.")).toEqual({
      ok: true,
      value: "Your day.",
    });
  });

  it("changes nothing for anyone but the owner", async () => {
    await registry.add("editor-guarded", "Guarded", admin);
    const before = await settingsOf("editor-guarded");
    const forbidden = { ok: false, reason: "forbidden" };
    expect(await editor.setMascot(member, "editor-guarded", picked)).toEqual(forbidden);
    expect(await editor.rename(member, "editor-guarded", "Mine")).toEqual(forbidden);
    expect(await editor.setRemit(member, "editor-guarded", "Mine")).toEqual(forbidden);
    expect(await editor.setSpecialty(member, "editor-guarded", "Mine")).toEqual(forbidden);
    expect(await settingsOf("editor-guarded")).toEqual(before);
    expect((await registry.get("editor-guarded"))?.name).toBe("Guarded");
  });

  it("refuses an actor that isn't one, before running anything", async () => {
    await registry.add("editor-actor", "Actor", admin);
    for (const actor of [null, { role: "owner" }, { userId: "u-owner", role: "owner" }, "owner"]) {
      expect(
        await editor.setRemit(actor as unknown as Actor, "editor-actor", "Mine"),
        JSON.stringify(actor),
      ).toEqual({ ok: false, reason: "forbidden" });
    }
    expect((await settingsOf("editor-actor")).remit).toBe("");
  });

  it("answers for an agent the Registry lists, and an id that is one", async () => {
    expect(await editor.setMascot(owner, "nobody", picked)).toEqual({
      ok: false,
      reason: "unknown_agent",
    });
    expect(await editor.rename(owner, "nobody", "Ghost")).toEqual({
      ok: false,
      reason: "unknown_agent",
    });
    expect(await editor.setRemit(owner, "../kelpie", "x")).toEqual({
      ok: false,
      reason: "invalid_input",
    });
  });
});
