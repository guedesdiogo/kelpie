import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { DEFAULT_SETTINGS } from "@kelpie/config";
import { describe, expect, it } from "vitest";

const host = (id: string) => env.AGENT_HOST.getByName(id);
const owner = { userId: "u-owner", role: "owner", via: "admin-api" } as const;

async function auditOf(stub: ReturnType<typeof host>) {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<{ action: string; user_id: string; via: string; fields: string }>(
        "SELECT action, user_id, via, fields FROM audit_log ORDER BY id",
      )
      .toArray(),
  );
}

describe("AgentHost", () => {
  it("starts from the default settings, at prompt version 0", async () => {
    expect(await host("fresh").config()).toEqual({ settings: DEFAULT_SETTINGS, promptVersion: 0 });
  });

  it("applies a change, and bumps the prompt version only when the system prompt changes", async () => {
    const stub = host("versions");

    expect(await stub.configure({ tier: "frontier", maxOutputTokens: 2_000 }, owner)).toEqual({
      ok: true,
      value: {
        settings: { ...DEFAULT_SETTINGS, tier: "frontier", maxOutputTokens: 2_000 },
        promptVersion: 0,
      },
    });
    await stub.configure({ systemPrompt: "You are terse." }, owner);
    await stub.configure({ systemPrompt: "You are terse." }, owner);

    expect(await stub.config()).toMatchObject({
      settings: { tier: "frontier", systemPrompt: "You are terse." },
      promptVersion: 1,
    });
  });

  it("refuses unknown settings or insane values, and changes nothing", async () => {
    const stub = host("refusals");
    for (const bad of [{ tier: "gpt-9" }, { maxOutputTokens: -1 }, { surprise: true }, null]) {
      // biome-ignore lint/suspicious/noExplicitAny: the RPC boundary receives untyped input.
      expect(await stub.configure(bad as any, owner)).toEqual({
        ok: false,
        reason: "invalid_input",
      });
    }
    expect(await stub.config()).toEqual({ settings: DEFAULT_SETTINGS, promptVersion: 0 });
    expect(await auditOf(stub)).toEqual([]);
  });

  it("audits who changed which settings, and through what", async () => {
    const stub = host("audited");
    await stub.configure({ tier: "medium", conversational: false }, owner);
    await stub.configure({ systemPrompt: "Hi." }, { ...owner, via: "agent:setup" });

    expect(await auditOf(stub)).toEqual([
      {
        action: "settings.changed",
        user_id: "u-owner",
        via: "admin-api",
        fields: JSON.stringify(["tier", "conversational"]),
      },
      {
        action: "settings.changed",
        user_id: "u-owner",
        via: "agent:setup",
        fields: JSON.stringify(["systemPrompt"]),
      },
    ]);
  });
});
