import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { DEFAULT_SETTINGS, SETUP_AGENT_ID } from "@kelpie/config";
import type { CompiledContext, ContextStoreContract } from "@kelpie/context-store/contract";
import { afterEach, describe, expect, it } from "vitest";
import { replaceContextStoreForTesting } from "../src/agent-host/agent-host.ts";
import { SETUP_PROMPT } from "../src/setup-agent.ts";

const host = (id: string) => env.AGENT_HOST.getByName(id);
const owner = { userId: "u-owner", role: "owner", via: "admin-api" } as const;

async function auditOf(stub: ReturnType<typeof host>) {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<{
        action: string;
        user_id: string;
        via: string;
        fields: string;
        prompt_version: number;
      }>("SELECT action, user_id, via, fields, prompt_version FROM audit_log ORDER BY id")
      .toArray(),
  );
}

describe("AgentHost", () => {
  it("starts from the default settings, at prompt version 0", async () => {
    expect(await host("fresh").config()).toEqual({ settings: DEFAULT_SETTINGS, promptVersion: 0 });
  });

  it("gives the setup agent its built-in persona, which a change can still replace", async () => {
    const stub = host(SETUP_AGENT_ID);
    expect(await stub.config()).toEqual({
      settings: { ...DEFAULT_SETTINGS, systemPrompt: SETUP_PROMPT },
      promptVersion: 0,
    });

    await stub.configure({ systemPrompt: "Fale como um pirata." }, owner);
    expect((await stub.config()).settings.systemPrompt).toBe("Fale como um pirata.");
  });

  it("drops the end-of-turn windows and the old 10 s cap from settings stored before ADR-0024", async () => {
    const stub = host("legacy");
    await stub.config();
    const legacy = {
      ...DEFAULT_SETTINGS,
      tier: "frontier",
      quietWindow: { finishedMs: 1_500, defaultMs: 3_000, unfinishedMs: 6_000 },
      maxWaitMs: 10_000,
    };
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT OR REPLACE INTO state (key, value) VALUES ('settings', ?)",
        JSON.stringify(legacy),
      );
    });

    const { settings } = await stub.config();
    expect(settings).toEqual({ ...DEFAULT_SETTINGS, tier: "frontier" });
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

  it("audits who changed which settings, through what, and the prompt version after", async () => {
    const stub = host("audited");
    await stub.configure({ tier: "medium", conversational: false }, owner);
    await stub.configure({ systemPrompt: "Hi.", tier: "medium" }, { ...owner, via: "agent:setup" });
    // Setting the current values changes nothing, so it isn't audited.
    await stub.configure({ systemPrompt: "Hi.", conversational: false }, owner);

    expect(await auditOf(stub)).toEqual([
      {
        action: "settings.changed",
        user_id: "u-owner",
        via: "admin-api",
        fields: JSON.stringify(["tier", "conversational"]),
        prompt_version: 0,
      },
      {
        action: "settings.changed",
        user_id: "u-owner",
        via: "agent:setup",
        fields: JSON.stringify(["systemPrompt"]),
        prompt_version: 1,
      },
    ]);
  });
});

describe("AgentHost with a vault", () => {
  const vaultOf = (context: Partial<CompiledContext>): ContextStoreContract => ({
    compile: async () => ({ persona: null, rules: [], skills: [], ...context }),
    read: async () => null,
    write: async () => ({ ok: false, reason: "vault_off" }),
    propose: async () => ({ ok: false, reason: "vault_off" }),
    recall: async () => ({ text: "", tokens: 0, paths: [], notes: [] }),
    search: async () => ({ ok: false, reason: "vault_off" }),
    readNote: async () => ({ ok: false, reason: "vault_off" }),
    writeNote: async () => ({ ok: false, reason: "vault_off" }),
  });

  afterEach(() => replaceContextStoreForTesting(undefined));

  it("runs on the configured prompt while the vault has nothing for the agent", async () => {
    expect(await host("empty-vault").turnConfig()).toEqual({
      settings: DEFAULT_SETTINGS,
      promptVersion: 0,
    });
  });

  it("composes the persona, rules and skills, and bumps the prompt version when they change", async () => {
    const stub = host("vault-agent");
    replaceContextStoreForTesting(
      vaultOf({
        persona: "# Kelpie\n\nWarm and brief.",
        rules: [{ path: "AGENTS.md", content: "Reply in PT-BR." }],
        skills: [
          { name: "recipes", description: "Finds recipes.", path: "skills/recipes/SKILL.md" },
        ],
      }),
    );
    const first = await stub.turnConfig();
    expect(first.settings.systemPrompt).toBe(
      "# Kelpie\n\nWarm and brief.\n\n# Rules (AGENTS.md)\n\nReply in PT-BR.\n\n# Skills in your vault\n\n- recipes: Finds recipes.",
    );
    expect(first.promptVersion).toBe(1);
    expect((await stub.turnConfig()).promptVersion).toBe(1);
    // The owner's settings still show the configured prompt.
    expect((await stub.config()).settings.systemPrompt).toBe(DEFAULT_SETTINGS.systemPrompt);

    // An edit to the persona, made outside Kelpie, reaches the next turn with a new version.
    replaceContextStoreForTesting(vaultOf({ persona: "# Kelpie\n\nNow playful." }));
    expect(await stub.turnConfig()).toMatchObject({
      settings: { systemPrompt: "# Kelpie\n\nNow playful." },
      promptVersion: 2,
    });
  });

  it("keeps the last vault when the Context Store fails", async () => {
    const stub = host("vault-outage");
    replaceContextStoreForTesting(vaultOf({ persona: "# Steady" }));
    await stub.turnConfig();
    replaceContextStoreForTesting({
      ...vaultOf({}),
      compile: async () => {
        throw new Error("context-store is down");
      },
    });
    expect(await stub.turnConfig()).toMatchObject({
      settings: { systemPrompt: "# Steady" },
      promptVersion: 1,
    });
  });

  it("gives concurrent turns one version, and doesn't lose a configured change made meanwhile", async () => {
    const slow = (persona: string): ContextStoreContract => ({
      ...vaultOf({}),
      compile: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { persona, rules: [], skills: [] };
      },
    });
    const stub = host("vault-race");
    replaceContextStoreForTesting(slow("# V1"));
    const [a, b] = await Promise.all([stub.turnConfig(), stub.turnConfig()]);
    expect([a.promptVersion, b.promptVersion]).toEqual([1, 1]);

    replaceContextStoreForTesting(slow("# V2"));
    const pending = stub.turnConfig();
    await stub.configure({ systemPrompt: "Configured meanwhile." }, owner);
    expect((await pending).promptVersion).toBe(3);
    expect((await stub.config()).promptVersion).toBe(3);
  });
});
