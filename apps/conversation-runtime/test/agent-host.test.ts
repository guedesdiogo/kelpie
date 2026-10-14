import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { DEFAULT_SETTINGS, REGISTRY_NAME, SETUP_AGENT_ID } from "@kelpie/config";
import type { CompiledContext, ContextStoreContract } from "@kelpie/context-store/contract";
import { afterEach, describe, expect, it } from "vitest";
import {
  replaceContextStoreForTesting,
  replaceIdentitySourcesForTesting,
} from "../src/agent-host/agent-host.ts";
import { SETUP_PROMPT } from "../src/setup-agent.ts";
import { withIdentity } from "./prompts.ts";

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

/** Leaves state rows as an earlier deploy would have; `null` removes one. */
async function seedState(stub: ReturnType<typeof host>, rows: Record<string, unknown>) {
  await runInDurableObject(stub, (_instance, state) => {
    for (const [key, value] of Object.entries(rows)) {
      if (value === null) state.storage.sql.exec("DELETE FROM state WHERE key = ?", key);
      else
        state.storage.sql.exec(
          "INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)",
          key,
          JSON.stringify(value),
        );
    }
  });
}

/** A state row as stored, or undefined when there is none. */
async function stateOf(stub: ReturnType<typeof host>, key: string) {
  return runInDurableObject(stub, (_instance, state) => {
    const [row] = state.storage.sql
      .exec<{ value: string }>("SELECT value FROM state WHERE key = ?", key)
      .toArray();
    return row ? JSON.parse(row.value) : undefined;
  });
}

/** The settings row as stored, not as `config()` fills it in. */
const storedOf = (stub: ReturnType<typeof host>) => stateOf(stub, "settings");

/**
 * Leaves the settings, the prompt version and the audit log as a deploy that stored the whole
 * settings would have, with no cleanup run yet, then evicts the object so the next call starts it
 * again.
 */
async function seedStored(
  stub: ReturnType<typeof host>,
  settings: Record<string, unknown>,
  audited: string[][],
  promptVersion: number,
) {
  await stub.config();
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec("DELETE FROM state WHERE key = 'settingsOverridesOnly'");
    for (const [key, value] of [
      ["settings", settings],
      ["promptVersion", promptVersion],
    ] as const) {
      state.storage.sql.exec(
        "INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)",
        key,
        JSON.stringify(value),
      );
    }
    for (const fields of audited) {
      state.storage.sql.exec(
        "INSERT INTO audit_log (at, action, user_id, via, fields, prompt_version) VALUES (?, 'settings.changed', 'u-owner', 'admin-api', ?, ?)",
        Date.now(),
        JSON.stringify(fields),
        promptVersion,
      );
    }
  });
  await evictDurableObject(stub);
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

    // Its default is its persona: the other agents' default is a prompt of its own, kept.
    await stub.configure({ systemPrompt: DEFAULT_SETTINGS.systemPrompt }, owner);
    expect(await storedOf(stub)).toEqual({ systemPrompt: DEFAULT_SETTINGS.systemPrompt });
    await stub.configure({ systemPrompt: SETUP_PROMPT }, owner);
    expect(await storedOf(stub)).toEqual({});
  });

  it("keeps the prompt version when a deploy edits a built-in prompt: the prompt key marks it (#220)", async () => {
    // The last deploy ran an older persona at version 4, and kept it as #210 did.
    const setup = host(SETUP_AGENT_ID);
    await setup.config();
    await seedState(setup, {
      settings: null,
      promptVersion: 4,
      defaultPrompt: "An older persona.",
    });
    expect(await setup.config()).toEqual({
      settings: { ...DEFAULT_SETTINGS, systemPrompt: SETUP_PROMPT },
      promptVersion: 4,
    });
    expect((await setup.turnConfig()).promptVersion).toBe(4);
    // Only this id gets the persona: leave it as a new agent for the other test that uses it.
    await seedState(setup, { promptVersion: null, defaultPrompt: null, defaultMemoryCore: null });

    // Any agent's built-in prompt, and one from before #210, which kept none, alike.
    for (const [id, defaultPrompt] of [
      ["default-changed", "You are an older assistant."],
      ["untracked", null],
    ] as const) {
      const stub = host(id);
      await stub.config();
      await seedState(stub, { promptVersion: 2, defaultPrompt });
      await evictDurableObject(stub);
      expect((await stub.config()).promptVersion).toBe(2);
      expect((await stub.turnConfig()).promptVersion).toBe(2);
    }
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

  it("stores only the settings a change sets, so the others keep following the defaults", async () => {
    const stub = host("overrides");
    await stub.configure({ tier: "frontier" }, owner);
    expect(await storedOf(stub)).toEqual({ tier: "frontier" });

    // A value the agent already has isn't stored, even beside one that changes.
    await stub.configure({ conversational: true, maxOutputTokens: 2_000 }, owner);
    expect(await storedOf(stub)).toEqual({ tier: "frontier", maxOutputTokens: 2_000 });
    expect((await stub.config()).settings).toEqual({
      ...DEFAULT_SETTINGS,
      tier: "frontier",
      maxOutputTokens: 2_000,
    });
  });

  it("follows a default again once a change sets it back, the system prompt included", async () => {
    const stub = host("back-to-default");
    await stub.configure({ tier: "frontier", systemPrompt: "You are terse." }, owner);
    expect((await stub.config()).promptVersion).toBe(1);

    await stub.configure(
      { tier: DEFAULT_SETTINGS.tier, systemPrompt: DEFAULT_SETTINGS.systemPrompt },
      owner,
    );
    expect(await storedOf(stub)).toEqual({});
    expect(await stub.config()).toEqual({ settings: DEFAULT_SETTINGS, promptVersion: 2 });
  });

  it("drops the defaults an earlier change stored, and keeps what a change named", async () => {
    const stub = host("frozen-current");
    await seedStored(stub, { ...DEFAULT_SETTINGS, tier: "frontier" }, [["tier"]], 3);

    // The prompt in effect is the same, so the cleanup doesn't bump.
    expect(await stub.config()).toEqual({
      settings: { ...DEFAULT_SETTINGS, tier: "frontier" },
      promptVersion: 3,
    });
    expect(await storedOf(stub)).toEqual({ tier: "frontier" });
  });

  it("starts a new prompt version when a dropped default prompt or memory core was another", async () => {
    const prompt = host("frozen-older-prompt");
    await seedStored(
      prompt,
      { ...DEFAULT_SETTINGS, systemPrompt: "You are an older assistant.", tier: "frontier" },
      [["tier"]],
      2,
    );
    expect(await prompt.config()).toEqual({
      settings: { ...DEFAULT_SETTINGS, tier: "frontier" },
      promptVersion: 3,
    });
    await evictDurableObject(prompt);
    expect((await prompt.config()).promptVersion).toBe(3);

    const core = host("frozen-older-core");
    await seedStored(core, { ...DEFAULT_SETTINGS, memoryCore: true }, [["tier"]], 0);
    expect(await core.config()).toEqual({ settings: DEFAULT_SETTINGS, promptVersion: 1 });
  });

  it("keeps a prompt a change named, and drops a named setting equal to its default", async () => {
    const stub = host("chosen");
    await seedStored(
      stub,
      { ...DEFAULT_SETTINGS, systemPrompt: "Fale como um pirata." },
      [["tier"], ["systemPrompt"], ["tier"]],
      1,
    );

    expect(await stub.config()).toEqual({
      settings: { ...DEFAULT_SETTINGS, systemPrompt: "Fale como um pirata." },
      promptVersion: 1,
    });
    expect(await storedOf(stub)).toEqual({ systemPrompt: "Fale como um pirata." });

    // A prompt a change set to the built-in text is dropped, and the prompt in effect is the same.
    const builtIn = host("chosen-built-in");
    await seedStored(builtIn, { ...DEFAULT_SETTINGS }, [["systemPrompt"]], 2);
    expect(await builtIn.config()).toEqual({ settings: DEFAULT_SETTINGS, promptVersion: 2 });
    expect(await storedOf(builtIn)).toEqual({});

    // The cleanup ran once: an audit log that lost its rows later changes nothing.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM audit_log");
    });
    await evictDurableObject(stub);
    expect((await stub.config()).settings.systemPrompt).toBe("Fale como um pirata.");
  });

  it("drops the end-of-turn windows and the old cap from storage, even when a change named the cap", async () => {
    const stub = host("legacy-stored");
    await seedStored(
      stub,
      {
        ...DEFAULT_SETTINGS,
        tier: "frontier",
        quietWindow: { finishedMs: 1_500, defaultMs: 3_000, unfinishedMs: 6_000 },
        maxWaitMs: 10_000,
      },
      [["tier", "maxWaitMs", "quietWindow"]],
      0,
    );

    expect(await stub.config()).toEqual({
      settings: { ...DEFAULT_SETTINGS, tier: "frontier" },
      promptVersion: 0,
    });
    expect(await storedOf(stub)).toEqual({ tier: "frontier" });
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

  it("starts a new prompt version when the memory core is turned on or off", async () => {
    const stub = host("memory-core");
    await stub.configure({ memoryCore: true }, owner);
    expect(await stub.config()).toMatchObject({
      settings: { memoryCore: true },
      promptVersion: 1,
    });
    // The same value again changes nothing.
    await stub.configure({ memoryCore: true }, owner);
    expect((await stub.config()).promptVersion).toBe(1);
    await stub.configure({ memoryCore: false, tier: "medium" }, owner);
    expect((await stub.config()).promptVersion).toBe(2);
  });

  it("starts a new prompt version once, at the next turn, when a deploy flips the memory core's default (#224)", async () => {
    const stub = host("core-default-flipped");
    await stub.turnConfig();
    expect(await stateOf(stub, "defaultMemoryCore")).toBe(DEFAULT_SETTINGS.memoryCore);
    // The last deploy had the other default, and the agent follows it.
    await seedState(stub, { defaultMemoryCore: !DEFAULT_SETTINGS.memoryCore });

    // Reading the settings changes nothing: only a turn uses the core.
    expect((await stub.config()).promptVersion).toBe(0);
    expect(await stateOf(stub, "defaultMemoryCore")).toBe(!DEFAULT_SETTINGS.memoryCore);

    expect((await stub.turnConfig()).promptVersion).toBe(1);
    expect((await stub.turnConfig()).promptVersion).toBe(1);
    expect((await stub.config()).promptVersion).toBe(1);
    expect(await stateOf(stub, "defaultMemoryCore")).toBe(DEFAULT_SETTINGS.memoryCore);
  });

  it("keeps the prompt version when the agent's own memory core setting outlives a flipped default", async () => {
    const stub = host("core-default-overridden");
    await stub.configure({ memoryCore: !DEFAULT_SETTINGS.memoryCore }, owner);
    await seedState(stub, { defaultMemoryCore: !DEFAULT_SETTINGS.memoryCore });

    expect((await stub.turnConfig()).promptVersion).toBe(1);
    expect(await stateOf(stub, "defaultMemoryCore")).toBe(DEFAULT_SETTINGS.memoryCore);
  });

  it("records the memory core's default at an agent's first turn after this deploy, without a bump", async () => {
    const stub = host("core-default-unseen");
    await stub.config();
    await seedState(stub, { promptVersion: 3, defaultMemoryCore: null });
    await evictDurableObject(stub);

    expect((await stub.turnConfig()).promptVersion).toBe(3);
    expect(await stateOf(stub, "defaultMemoryCore")).toBe(DEFAULT_SETTINGS.memoryCore);
  });
});

describe("AgentHost with a vault", () => {
  const vaultOf = (context: Partial<CompiledContext>): ContextStoreContract => ({
    compile: async () => ({ persona: null, rules: [], skills: [], ...context }),
    read: async () => null,
    write: async () => ({ ok: false, reason: "vault_off" }),
    propose: async () => ({ ok: false, reason: "vault_off" }),
    recall: async () => ({ text: "", tokens: 0, paths: [], notes: [] }),
    core: async () => ({ text: "", tokens: 0, paths: [], omitted: 0 }),
    search: async () => ({ ok: false, reason: "vault_off" }),
    readNote: async () => ({ ok: false, reason: "vault_off" }),
    writeNote: async () => ({ ok: false, reason: "vault_off" }),
  });

  afterEach(() => {
    replaceContextStoreForTesting(undefined);
    replaceIdentitySourcesForTesting(undefined);
  });

  it("opens the prompt with who the agent is: its Registry name, its role, tier and route (#283)", async () => {
    const stub = host("named-agent");
    // Until the Registry lists it, the agent goes by its id.
    expect((await stub.turnConfig()).settings.systemPrompt).toBe(
      withIdentity("named-agent", DEFAULT_SETTINGS.systemPrompt),
    );

    const registry = env.REGISTRY.getByName(REGISTRY_NAME);
    await registry.add("named-agent", "Bia", owner);
    await stub.configure({ tier: "medium" }, owner);
    const named = (await stub.turnConfig()).settings.systemPrompt;
    expect(named).toBe(
      withIdentity("named-agent", DEFAULT_SETTINGS.systemPrompt, {
        name: "Bia",
        role: "specialist",
        tier: "medium",
      }),
    );
    expect(named).toContain("You run on Kelpie's medium tier: anthropic claude-test-medium.");

    // The trio comes from the agent's model settings, resolved by llm-gateway (#286).
    await stub.configure({ model: { conversation: { tier: "frontier", effort: "high" } } }, owner);
    expect((await stub.turnConfig()).settings.systemPrompt).toContain(
      "You run on Kelpie's frontier tier, at high effort: anthropic claude-test-frontier.",
    );
    await stub.configure({ model: {} }, owner);

    // A rename reaches the next turn, and the owner's settings still hold only their prompt.
    await registry.rename("named-agent", "Bia Assistente", owner);
    expect((await stub.turnConfig()).settings.systemPrompt).toContain(
      "You are Bia Assistente, a specialist agent on Kelpie",
    );
    expect((await stub.config()).settings.systemPrompt).toBe(DEFAULT_SETTINGS.systemPrompt);
  });

  it("keeps the last name and route when the Registry or llm-gateway fails, and still answers", async () => {
    const stub = host("identity-outage");
    await env.REGISTRY.getByName(REGISTRY_NAME).add("identity-outage", "Bia", owner);
    const seen = (await stub.turnConfig()).settings.systemPrompt;
    expect(seen).toBe(
      withIdentity("identity-outage", DEFAULT_SETTINGS.systemPrompt, {
        name: "Bia",
        role: "specialist",
      }),
    );

    // A partial rollback leaves an llm-gateway without `routes`, and the Registry may be resetting.
    replaceIdentitySourcesForTesting({
      agent: async () => {
        throw new Error("Durable Object reset because its code was updated");
      },
      describe: async () => {
        throw new TypeError('The RPC receiver does not implement the method "describe".');
      },
    });
    expect((await stub.turnConfig()).settings.systemPrompt).toBe(seen);

    // An agent whose sources never answered goes by its id, with no model named.
    const never = (await host("identity-never").turnConfig()).settings.systemPrompt;
    expect(never).toContain("You are identity-never, one of the owner's agents on Kelpie");
    expect(never).not.toContain("You run on");
  });

  it("tells the setup agent its own role, under its seeded name", async () => {
    expect((await host(SETUP_AGENT_ID).turnConfig()).settings.systemPrompt).toBe(
      withIdentity(SETUP_AGENT_ID, SETUP_PROMPT, { name: "Setup" }),
    );
  });

  it("runs on the configured prompt while the vault has nothing for the agent", async () => {
    expect(await host("empty-vault").turnConfig()).toEqual({
      settings: {
        ...DEFAULT_SETTINGS,
        systemPrompt: withIdentity("empty-vault", DEFAULT_SETTINGS.systemPrompt),
      },
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
      withIdentity(
        "vault-agent",
        "# Kelpie\n\nWarm and brief.\n\n# Rules (AGENTS.md)\n\nReply in PT-BR.\n\n# Skills in your vault\n\n- recipes: Finds recipes.",
      ),
    );
    expect(first.promptVersion).toBe(1);
    expect((await stub.turnConfig()).promptVersion).toBe(1);
    // The owner's settings still show the configured prompt.
    expect((await stub.config()).settings.systemPrompt).toBe(DEFAULT_SETTINGS.systemPrompt);

    // An edit to the persona, made outside Kelpie, reaches the next turn with a new version.
    replaceContextStoreForTesting(vaultOf({ persona: "# Kelpie\n\nNow playful." }));
    expect(await stub.turnConfig()).toMatchObject({
      settings: { systemPrompt: withIdentity("vault-agent", "# Kelpie\n\nNow playful.") },
      promptVersion: 2,
    });
  });

  it("keeps the version of an agent whose vault persona replaces an edited built-in prompt (#220)", async () => {
    const stub = host("vault-persona-default-edited");
    replaceContextStoreForTesting(vaultOf({ persona: "# Kelpie\n\nWarm and brief." }));
    expect((await stub.turnConfig()).promptVersion).toBe(1);
    // A deploy edited the built-in prompt the persona replaces, as #210 kept it.
    await seedState(stub, { defaultPrompt: "You are an older assistant." });

    expect(await stub.turnConfig()).toMatchObject({
      settings: {
        systemPrompt: withIdentity("vault-persona-default-edited", "# Kelpie\n\nWarm and brief."),
      },
      promptVersion: 1,
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
      settings: { systemPrompt: withIdentity("vault-outage", "# Steady") },
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

    // A flipped memory core default and a vault change, seen by racing turns, make one version.
    await seedState(stub, { defaultMemoryCore: !DEFAULT_SETTINGS.memoryCore });
    replaceContextStoreForTesting(slow("# V3"));
    const [c, d] = await Promise.all([stub.turnConfig(), stub.turnConfig()]);
    expect([c.promptVersion, d.promptVersion]).toEqual([4, 4]);
    expect(await stateOf(stub, "defaultMemoryCore")).toBe(DEFAULT_SETTINGS.memoryCore);

    // So does a configured change made while a turn waits on a flipped default.
    await seedState(stub, { defaultMemoryCore: !DEFAULT_SETTINGS.memoryCore });
    const waiting = stub.turnConfig();
    await stub.configure({ systemPrompt: "Configured again." }, owner);
    expect((await waiting).promptVersion).toBe(6);
    expect((await stub.config()).promptVersion).toBe(6);
  });
});
