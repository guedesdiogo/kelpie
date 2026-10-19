import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { BotPhotoRequest } from "@kelpie/channels";
import {
  DEFAULT_SETTINGS,
  derivedMascot,
  KELPIE_MASCOT,
  type Mascot,
  REGISTRY_NAME,
  SETUP_AGENT_ID,
} from "@kelpie/config";
import type { CompiledContext, ContextStoreContract } from "@kelpie/context-store/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CREATE_SUBAGENT_SKILL,
  clampModel,
  replaceChannelEgressForTesting,
  replaceContextStoreForTesting,
  replaceIdentitySourcesForTesting,
} from "../src/agent-host/agent-host.ts";
import { CONFIGURE_KELPIE_SKILL } from "../src/configuration.ts";
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

  it("gives the retired setup agent's id no persona of its own (ADR-0048)", async () => {
    expect(await host(SETUP_AGENT_ID).config()).toEqual({
      settings: DEFAULT_SETTINGS,
      promptVersion: 0,
    });
  });

  it("keeps the prompt version when a deploy edits a built-in prompt: the prompt key marks it (#220)", async () => {
    // Any agent's built-in prompt, and one from before #210, which kept none, alike: the last
    // deploy ran an older one and kept it.
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
    compile: async () => ({ persona: null, rules: [], skills: [], memory: null, ...context }),
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
      specialists: async () => {
        throw new Error("Durable Object reset because its code was updated");
      },
    });
    expect((await stub.turnConfig()).settings.systemPrompt).toBe(seen);

    // An agent whose sources never answered goes by its id, with no model named.
    const never = (await host("identity-never").turnConfig()).settings.systemPrompt;
    expect(never).toContain("You are identity-never, one of the owner's agents on Kelpie");
    expect(never).not.toContain("You run on");
  });

  it("runs on the configured prompt while the vault has nothing for the agent", async () => {
    expect(await host("empty-vault").turnConfig()).toEqual({
      settings: {
        ...DEFAULT_SETTINGS,
        systemPrompt: withIdentity("empty-vault", DEFAULT_SETTINGS.systemPrompt),
      },
      promptVersion: 0,
      // What a turn's limits read (#290): an agent the Registry doesn't list has no role.
      agent: { role: null, owner: null, spawn: false, creatorTools: null },
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

  it("puts the agent's memory file after its skills, and a change to it starts a new version (#437)", async () => {
    const stub = host("vault-memory");
    const path = "agents/vault-memory/memories/MEMORY.md";
    replaceContextStoreForTesting(
      vaultOf({
        persona: "# Kelpie",
        skills: [{ name: "recipes", description: "", path: "skills/recipes/SKILL.md" }],
        memory: { path, content: "The owner deploys on Fridays.\n§\nReplies stay short." },
      }),
    );
    expect(await stub.turnConfig()).toMatchObject({
      settings: {
        systemPrompt: withIdentity(
          "vault-memory",
          `# Kelpie\n\n# Skills in your vault\n\n- recipes\n\n# Memory (${path})\n\nThe owner deploys on Fridays.\n§\nReplies stay short.`,
        ),
      },
      promptVersion: 1,
    });

    // A memory file alone keeps the configured prompt, and the owner's Save reaches the next turn.
    replaceContextStoreForTesting(vaultOf({ memory: { path, content: "Replies stay short." } }));
    expect(await stub.turnConfig()).toMatchObject({
      settings: {
        systemPrompt: withIdentity(
          "vault-memory",
          `${DEFAULT_SETTINGS.systemPrompt}\n\n# Memory (${path})\n\nReplies stay short.`,
        ),
      },
      promptVersion: 2,
    });
  });

  it("composes a vault compiled before the memory file existed, as none (#437)", async () => {
    const stub = host("vault-before-memory");
    // A Context Store not yet deployed answers without the field, and the turn keeps it as its last.
    const older = { persona: "# Older", rules: [], skills: [] } as unknown as CompiledContext;
    replaceContextStoreForTesting({ ...vaultOf({}), compile: async () => older });
    const seen = withIdentity("vault-before-memory", "# Older");
    expect((await stub.turnConfig()).settings.systemPrompt).toBe(seen);
    replaceContextStoreForTesting({
      ...vaultOf({}),
      compile: async () => {
        throw new Error("context-store is down");
      },
    });
    expect(await stub.turnConfig()).toMatchObject({
      settings: { systemPrompt: seen },
      promptVersion: 1,
    });
  });

  it("keeps the version across the deploy that added the memory file, until the agent has one (#437)", async () => {
    const stub = host("vault-memory-deploy");
    // What the turn before the deploy kept: the vault as it was compiled, without the field.
    const persona = "# Kelpie";
    await seedState(stub, {
      promptVersion: 3,
      vaultContext: JSON.stringify({ persona, rules: [], skills: [] }),
    });
    replaceContextStoreForTesting(vaultOf({ persona }));
    expect((await stub.turnConfig()).promptVersion).toBe(3);

    const path = "agents/vault-memory-deploy/memories/MEMORY.md";
    replaceContextStoreForTesting(vaultOf({ persona, memory: { path, content: "A note." } }));
    expect((await stub.turnConfig()).promptVersion).toBe(4);
    // The file emptied, the vault keys as before it, and that is a change too.
    replaceContextStoreForTesting(vaultOf({ persona }));
    expect((await stub.turnConfig()).promptVersion).toBe(5);
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
        return { persona, rules: [], skills: [], memory: null };
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

describe("Deleting an agent's storage (#303)", () => {
  const conversation = (name: string) => env.CONVERSATION_AGENT.getByName(name);
  /** Keeps a value in a conversation, as its first message would. */
  const seedConversation = (name: string) =>
    runInDurableObject(conversation(name), (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO state (key, value) VALUES ('agentId', ?)",
        JSON.stringify(name.split(":")[0]),
      );
    });
  const conversationsOf = (stub: ReturnType<typeof host>) =>
    runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ name: string }>("SELECT name FROM conversations ORDER BY name")
        .toArray()
        .map((row) => row.name),
    );
  /**
   * Reads an object again once its destroyed instance is gone: the SDK ends it on the next tick,
   * and a call that lands before that is refused with "destroyed".
   */
  async function afterDestroy<T>(read: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await read();
      } catch (error) {
        if (attempt >= 20 || !String(error).includes("destroyed")) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }

  it("records the conversations of its own agent that start a turn, once each", async () => {
    const stub = host("recorder");
    await stub.turnConfig("recorder:webchat:u-owner");
    await stub.turnConfig("recorder:webchat:u-owner");
    await stub.turnConfig("recorder:telegram:1001");
    // Another agent's conversation, or a caller from before this release, records nothing.
    await stub.turnConfig("other:webchat:u-owner");
    await stub.turnConfig();

    expect(await conversationsOf(stub)).toEqual([
      "recorder:telegram:1001",
      "recorder:webchat:u-owner",
    ]);
  });

  it("erases each recorded or named conversation, then itself", async () => {
    const stub = host("leaving");
    expect(await stub.configure({ systemPrompt: "Leaving." }, owner)).toMatchObject({ ok: true });
    await stub.turnConfig("leaving:webchat:u-owner");
    await seedConversation("leaving:webchat:u-owner");
    await seedConversation("leaving:telegram:1001");

    expect(await stub.erase(["leaving:telegram:1001", "leaving:webchat:u-owner"])).toEqual({
      ok: true,
      conversations: 2,
    });

    const left = (name: string) =>
      afterDestroy(() =>
        runInDurableObject(conversation(name), (_instance, state) =>
          state.storage.sql.exec("SELECT key FROM state").toArray(),
        ),
      );
    expect(await left("leaving:webchat:u-owner")).toEqual([]);
    expect(await left("leaving:telegram:1001")).toEqual([]);
    const after = await afterDestroy(() => host("leaving").config());
    expect(after).toEqual({ settings: DEFAULT_SETTINGS, promptVersion: 0 });
    expect(await afterDestroy(() => auditOf(host("leaving")))).toEqual([]);
    expect(await conversationsOf(host("leaving"))).toEqual([]);
  });

  it("takes only names of its own agent's conversations, and then erases nothing", async () => {
    const stub = host("strict");
    await stub.configure({ systemPrompt: "Strict." }, owner);
    await seedConversation("other:webchat:u-owner");
    const invalid = { ok: false, reason: "invalid_input" };

    expect(await stub.erase(["other:webchat:u-owner"])).toEqual(invalid);
    expect(await stub.erase(["strict"])).toEqual(invalid);
    expect(await stub.erase("strict:webchat:u-owner" as never)).toEqual(invalid);
    expect(await stub.erase([7] as never)).toEqual(invalid);
    expect((await stub.config()).settings.systemPrompt).toBe("Strict.");
    expect(
      await runInDurableObject(conversation("other:webchat:u-owner"), (_instance, state) =>
        state.storage.sql.exec("SELECT key FROM state").toArray(),
      ),
    ).toEqual([{ key: "agentId" }]);
  });
});

describe("AgentHost and subagents (#290)", () => {
  /** Identity sources where each agent's role and owner are given, and a trio is its own tier. */
  function roster(
    entries: Record<string, { role: "main" | "specialist" | "subagent"; owner?: string }>,
  ) {
    replaceIdentitySourcesForTesting({
      agent: async (id) => {
        const entry = entries[id];
        return entry ? { name: id, role: entry.role, owner: entry.owner ?? null } : null;
      },
      describe: async (model) => ({
        provider: model.provider ?? "anthropic",
        tier: model.conversation?.tier ?? "cheap",
        ...(model.conversation?.effort ? { effort: model.conversation.effort } : {}),
        route: [],
      }),
      specialists: async () => [],
    });
  }
  afterEach(() => {
    replaceIdentitySourcesForTesting(undefined);
  });

  it("teaches configure-kelpie to Master alone, over any persona (ADR-0048)", async () => {
    roster({
      "cfg-main": { role: "main" },
      "cfg-specialist": { role: "specialist" },
      "cfg-child": { role: "subagent", owner: "cfg-main" },
    });
    await host("cfg-main").configure({ systemPrompt: "Fale como um pirata." }, owner);
    const prompt = async (id: string) => (await host(id).turnConfig()).settings.systemPrompt;
    const master = await prompt("cfg-main");
    expect(master).toContain("Fale como um pirata.");
    expect(master.endsWith(`\n\n${CONFIGURE_KELPIE_SKILL}`)).toBe(true);
    expect(await prompt("cfg-specialist")).not.toContain("configure-kelpie");
    expect(await prompt("cfg-child")).not.toContain("configure-kelpie");
  });

  it("teaches create-subagent to the main agent and to an agent with spawn, never a subagent", async () => {
    roster({
      "sub-main": { role: "main" },
      "sub-specialist": { role: "specialist" },
      "sub-spawner": { role: "specialist" },
      "sub-child": { role: "subagent", owner: "sub-main" },
    });
    await host("sub-spawner").configure({ spawn: true }, owner);
    await host("sub-child").configure({ spawn: true }, owner);
    const taught = async (id: string) => {
      const config = await host(id).turnConfig();
      return {
        prompt: config.settings.systemPrompt.includes(CREATE_SUBAGENT_SKILL),
        agent: config.agent,
      };
    };
    expect(await taught("sub-main")).toEqual({
      prompt: true,
      agent: { role: "main", owner: null, spawn: true, creatorTools: null },
    });
    expect(await taught("sub-specialist")).toMatchObject({
      prompt: false,
      agent: { spawn: false },
    });
    expect(await taught("sub-spawner")).toMatchObject({ prompt: true, agent: { spawn: true } });
    expect(await taught("sub-child")).toEqual({
      prompt: false,
      agent: { role: "subagent", owner: "sub-main", spawn: false, creatorTools: null },
    });
  });

  it("puts a subagent's soul, skills and remit in its prompt, and its creator in its identity", async () => {
    roster({ "sub-briefed": { role: "subagent", owner: "kelpie" } });
    await host("sub-briefed").configure(
      {
        systemPrompt: "You find flights.",
        remit: "Flights to Lisbon.",
        skills: [{ name: "Fares", instructions: "Compare three fares." }],
      },
      owner,
    );
    const prompt = (await host("sub-briefed").turnConfig()).settings.systemPrompt;
    expect(prompt).toContain(
      "a temporary subagent on Kelpie, working on one demand of the agent that created you, the agent kelpie. Your remit: Flights to Lisbon.",
    );
    expect(prompt).toContain("You find flights.");
    expect(prompt).toContain("# Your skills\n\n## Fares\n\nCompare three fares.");
  });

  it("runs a subagent on its creator's trio once its own is above it", async () => {
    roster({
      "sub-maker": { role: "main" },
      "sub-climber": { role: "subagent", owner: "sub-maker" },
    });
    await host("sub-maker").configure({ model: { conversation: { tier: "medium" } } }, owner);
    await host("sub-climber").configure({ model: { conversation: { tier: "frontier" } } }, owner);
    const climbed = await host("sub-climber").turnConfig();
    // Held to its creator's tier, on its creator's route.
    expect(climbed.settings.model).toEqual({
      provider: "anthropic",
      conversation: { tier: "medium" },
    });
    expect(climbed.settings.systemPrompt).toContain("You run on Kelpie's medium tier");

    // Within its creator's, it keeps its own.
    await host("sub-climber").configure({ model: { conversation: { tier: "cheap" } } }, owner);
    expect((await host("sub-climber").turnConfig()).settings.model).toEqual({
      provider: "anthropic",
      conversation: { tier: "cheap" },
    });
  });

  it("stays a subagent once its creator is pinned, whatever the Registry answers", async () => {
    roster({});
    expect(await host("sub-pinned").bindCreator("kelpie")).toEqual({ ok: true });
    expect(await host("sub-pinned").bindCreator("someone-else")).toEqual({ ok: false });
    // A new subagent whose id collides with a live agent's never takes that agent over (#344).
    expect(await host("sub-pinned").bindCreator("kelpie")).toEqual({ ok: false });
    await host("sub-in-use").configure({ remit: "Quotes." }, owner);
    expect(await host("sub-in-use").bindCreator("kelpie")).toEqual({ ok: false });
    expect((await host("sub-in-use").config()).settings.remit).toBe("Quotes.");
    // Nor one configured back to its defaults, one with a task, or one with a conversation.
    await host("sub-reset").configure({ remit: "Quotes." }, owner);
    await host("sub-reset").configure({ remit: "" }, owner);
    expect(await host("sub-reset").bindCreator("kelpie")).toEqual({ ok: false });
    const task = await host("sub-tasked").createTask(
      { title: "Later", body: "", status: "backlog", scheduledStartAt: null },
      owner,
    );
    expect(task.ok).toBe(true);
    expect(await host("sub-tasked").bindCreator("kelpie")).toEqual({ ok: false });
    await host("sub-talked").turnConfig("sub-talked:telegram:1");
    expect(await host("sub-talked").bindCreator("kelpie")).toEqual({ ok: false });
    expect((await host("sub-pinned").turnConfig()).agent).toMatchObject({
      role: "subagent",
      owner: "kelpie",
      spawn: false,
    });
  });

  it("lets a narrowed Master's subagent keep the task tools Master always holds (#391)", async () => {
    roster({
      "held-main": { role: "main" },
      "held-child": { role: "subagent", owner: "held-main" },
      "held-spec": { role: "specialist" },
      "held-spec-child": { role: "subagent", owner: "held-spec" },
    });
    await host("held-main").configure({ tools: ["memory_search"] }, owner);
    expect((await host("held-child").turnConfig()).agent?.creatorTools).toEqual(
      expect.arrayContaining(["memory_search", "complete_task", "wait_on_task", "comment_task"]),
    );
    // A specialist's list stays its own.
    await host("held-spec").configure({ tools: ["memory_search"], spawn: true }, owner);
    expect((await host("held-spec-child").turnConfig()).agent?.creatorTools).toEqual([
      "memory_search",
    ]);
  });

  it("keeps a subagent's creator limits when only the creator's role can't be read (#391)", async () => {
    replaceIdentitySourcesForTesting({
      agent: async (id) => {
        if (id === "role-down-main") throw new Error("Durable Object reset");
        return { name: id, role: "subagent", owner: "role-down-main" };
      },
      describe: async () => ({ provider: "anthropic", tier: "medium", route: [] }),
      specialists: async () => [],
    });
    await host("role-down-main").configure({ tools: ["memory_search", "complete_task"] }, owner);
    // Its own list, read without the role: never the cheapest limits' empty one, and never wider.
    expect((await host("role-down-child").turnConfig()).agent?.creatorTools).toEqual([
      "memory_search",
      "complete_task",
    ]);
  });

  it("holds a subagent to the tier its creator runs on, the instance's when it sets none (#344)", async () => {
    // The instance's conversation tier is frontier: an agent that sets none runs on it.
    replaceIdentitySourcesForTesting({
      agent: async (id) =>
        id === "inherit-main"
          ? { name: id, role: "main", owner: null }
          : { name: id, role: "subagent", owner: "inherit-main" },
      describe: async (model) => ({
        provider: "anthropic",
        tier: model.conversation?.tier ?? "frontier",
        route: [],
      }),
      specialists: async () => [],
    });
    expect(await host("inherit-sub").bindCreator("inherit-main")).toEqual({ ok: true });
    await host("inherit-sub").configure({ model: { conversation: { tier: "medium" } } }, owner);
    // The creator's own model has no tier: not the defaults' cheap.
    expect(await host("inherit-main").ownModel()).toEqual({});
    expect((await host("inherit-sub").turnConfig()).settings.model).toEqual({
      provider: "anthropic",
      conversation: { tier: "medium" },
    });
  });

  it("names no model in a subagent's prompt when its clamped trio can't be described (#344)", async () => {
    replaceIdentitySourcesForTesting({
      agent: async (id) =>
        id === "unread-main"
          ? { name: id, role: "main", owner: null }
          : { name: id, role: "subagent", owner: "unread-main" },
      describe: async (model) => {
        // The clamped trio is the only one pinned to a provider: llm-gateway fails on it.
        if (model.provider !== undefined) throw new Error("down");
        return { provider: "anthropic", tier: model.conversation?.tier ?? "cheap", route: [] };
      },
      specialists: async () => [],
    });
    await host("unread-main").configure({ model: { conversation: { tier: "medium" } } }, owner);
    expect(await host("unread-sub").bindCreator("unread-main")).toEqual({ ok: true });
    await host("unread-sub").configure({ model: { conversation: { tier: "frontier" } } }, owner);
    const { settings } = await host("unread-sub").turnConfig();
    expect(settings.model.conversation).toEqual({ tier: "medium" });
    // Not its own frontier tier, which it doesn't run on.
    expect(settings.systemPrompt).not.toContain("You run on");
  });

  it("gives a subagent's calls outside a turn its creator's limits too (#344)", async () => {
    roster({ "own-maker": { role: "main" } });
    await host("own-maker").configure(
      { model: { conversation: { tier: "medium" }, memory: { tier: "cheap" } } },
      owner,
    );
    expect(await host("own-sub").bindCreator("own-maker")).toEqual({ ok: true });
    await host("own-sub").configure(
      { model: { conversation: { tier: "frontier" }, memory: { tier: "frontier" } } },
      owner,
    );
    // A checkpoint's summary runs on the memory area: its creator's, not its own frontier.
    expect(await host("own-sub").ownModel()).toEqual({
      provider: "anthropic",
      memory: { tier: "cheap" },
      conversation: { tier: "medium" },
    });
    // Any other agent's are its own settings, unclamped.
    expect(await host("own-maker").ownModel()).toEqual({
      conversation: { tier: "medium" },
      memory: { tier: "cheap" },
    });
  });

  it("falls back to the cheapest tier when its creator was never read", async () => {
    replaceIdentitySourcesForTesting({
      agent: async (id) =>
        id === "sub-orphan" ? { name: id, role: "subagent", owner: "sub-silent" } : null,
      describe: async (model) => {
        // The creator's trio can't be described: as if llm-gateway didn't answer for it.
        if (model.conversation?.tier === "frontier") throw new Error("down");
        return { provider: "anthropic", tier: model.conversation?.tier ?? "cheap", route: [] };
      },
      specialists: async () => [],
    });
    await host("sub-silent").configure({ model: { conversation: { tier: "frontier" } } }, owner);
    await host("sub-orphan").configure({ model: { conversation: { tier: "medium" } } }, owner);
    expect((await host("sub-orphan").turnConfig()).settings.model).toEqual({
      conversation: { tier: "cheap" },
    });
  });
});

describe("the specialists in an agent's prompt (#287)", () => {
  afterEach(() => {
    replaceIdentitySourcesForTesting(undefined);
  });

  it("lists the specialists it owns with their remits, and keeps the last list when it can't be read", async () => {
    let specialists: () => Promise<{ id: string; name: string; remit: string }[]> = async () => [
      { id: "sales", name: "Sales", remit: "Quotes for wholesale clients." },
      { id: "docs", name: "Docs", remit: "" },
    ];
    replaceIdentitySourcesForTesting({
      agent: async (id) => ({ name: id, role: "main", owner: null }),
      describe: async () => ({ provider: "anthropic", tier: "cheap", route: [] }),
      specialists: () => specialists(),
    });
    const stub = host("roster-main");
    const listed = (await stub.turnConfig()).settings.systemPrompt;
    expect(listed).toContain("# Your specialists");
    expect(listed).toContain(
      '- sales ("Sales"): Quotes for wholesale clients.\n- docs ("Docs"): no remit set',
    );
    expect(listed).toContain("even when the owner didn't name it");

    specialists = async () => {
      throw new Error("Durable Object reset because its code was updated");
    };
    expect((await stub.turnConfig()).settings.systemPrompt).toBe(listed);

    // An agent that owns none has no such section.
    specialists = async () => [];
    expect((await stub.turnConfig()).settings.systemPrompt).not.toContain("# Your specialists");
  });
});

describe("a subagent's trio, held to its creator's (#290)", () => {
  const limits = (fields: object) =>
    ({ tier: "medium", provider: "anthropic", tools: null, ...fields }) as never;

  it("takes the lower tier, and its creator's for a tier it doesn't rank", () => {
    expect(clampModel({ conversation: { tier: "frontier" } }, limits({}))).toEqual({
      provider: "anthropic",
      conversation: { tier: "medium" },
    });
    expect(clampModel({ conversation: { tier: "cheap" } }, limits({}))).toMatchObject({
      conversation: { tier: "cheap" },
    });
    expect(clampModel({ conversation: { tier: "auto" as never } }, limits({}))).toMatchObject({
      conversation: { tier: "medium" },
    });
    expect(clampModel({}, limits({}))).toMatchObject({ conversation: { tier: "medium" } });
  });

  it("holds its effort to the creator's, none when the creator sets none", () => {
    const effortOf = (own: object, creator: object) =>
      clampModel({ conversation: { tier: "cheap", ...own } }, limits(creator)).conversation;
    expect(effortOf({ effort: "max" }, { effort: "high" })).toEqual({
      tier: "cheap",
      effort: "high",
    });
    expect(effortOf({ effort: "low" }, { effort: "high" })).toEqual({
      tier: "cheap",
      effort: "low",
    });
    // Unset counts as the model's default, which may be above the creator's: it takes the creator's.
    expect(effortOf({}, { effort: "low" })).toEqual({ tier: "cheap", effort: "low" });
    expect(effortOf({ effort: "high" }, {})).toEqual({ tier: "cheap" });
  });
});

describe("The bot's photo (ADR-0046)", () => {
  const picked: Mascot = { ...KELPIE_MASCOT, color: "lagoon" };

  /** Waits for the photo the object asks for when it starts (#388), which the test egress takes. */
  const started = (stub: ReturnType<typeof host>) =>
    vi.waitFor(async () => expect(await stateOf(stub, "botPhoto")).toBeDefined(), {
      timeout: 5_000,
    });

  /** The agent's AgentHost, with a channel-egress that records what it is asked for. */
  async function photoHost(id: string, answer: object = { ok: true }) {
    const asked: [string, unknown][] = [];
    const stub = host(id);
    await started(stub);
    await runInDurableObject(stub, (instance) => {
      const configurable = instance as unknown as { env: Env };
      configurable.env = {
        ...configurable.env,
        CHANNEL_EGRESS: {
          updateBotPhoto: async (agentId: string, mascot: unknown) => {
            asked.push([agentId, mascot]);
            if ("throws" in answer) throw new Error("egress is down");
            return answer;
          },
        } as unknown as Env["CHANNEL_EGRESS"],
      };
    });
    return { stub, asked };
  }

  it("is asked for when the mascot changes, and when the bot connects", async () => {
    const { stub, asked } = await photoHost("photo-agent");
    await stub.configure({ mascot: picked }, owner);
    // The same mascot again, or another setting, asks nothing.
    await stub.configure({ mascot: picked }, owner);
    await stub.configure({ systemPrompt: "Fale como um pirata." }, owner);
    await stub.setupDone({ step: "telegram_paired", userId: "u-owner" });
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    await stub.setupDone({
      step: "telegram_connected",
      userId: "u-owner",
      bot: "PhotoBot",
      webhookRegistered: true,
    });
    await vi.waitFor(() => expect(asked).toHaveLength(2));
    // Back to its default: an agent the Registry doesn't list draws one from its id.
    await stub.configure({ mascot: null }, owner);
    await vi.waitFor(() => expect(asked).toHaveLength(3));
    expect(asked).toEqual([
      ["photo-agent", picked],
      ["photo-agent", picked],
      ["photo-agent", derivedMascot("photo-agent")],
    ]);
  });

  it("costs only the photo when channel-egress fails or refuses", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const refused = await photoHost("photo-refused", { ok: false, reason: "store_unavailable" });
      expect(await refused.stub.configure({ mascot: picked }, owner)).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
      expect(warn).toHaveBeenLastCalledWith(
        "AgentHost: the bot's photo wasn't asked for",
        "store_unavailable",
      );

      const down = await photoHost("photo-down", { throws: true });
      expect(await down.stub.configure({ mascot: picked }, owner)).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2));
      expect(warn).toHaveBeenLastCalledWith("AgentHost: the bot's photo wasn't asked for", "Error");

      // An agent without a bot isn't a failure.
      const none = await photoHost("photo-none", { ok: false, reason: "not_connected" });
      await none.stub.configure({ mascot: picked }, owner);
      await vi.waitFor(() => expect(none.asked).toHaveLength(1));
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  describe("when the object starts (#388)", () => {
    /** Kelpie as it was before ADR-0049. */
    const OLD_KELPIE: Mascot = {
      ...KELPIE_MASCOT,
      eyes: "shine",
      head: { type: "ears", variation: "pointed" },
      accessory: { type: "belt", variation: "collar" },
    };
    const asked: [string, unknown][] = [];
    let answer: BotPhotoRequest = { ok: true };

    beforeEach(() => {
      replaceChannelEgressForTesting({
        updateBotPhoto: async (agentId, mascot) => {
          asked.push([agentId, mascot]);
          return answer;
        },
      });
    });

    afterEach(() => {
      replaceChannelEgressForTesting(undefined);
      asked.length = 0;
      answer = { ok: true };
    });

    /** One more answer from the Registry: a start's lookup that came before it has been answered. */
    const registryRoundTrip = () => env.REGISTRY.getByName(REGISTRY_NAME).get("kelpie");

    /**
     * Leaves the agent's object with `rows` in its state, as an earlier deploy would have, and
     * evicts it, so its next call starts it again. What its first start asked for isn't counted.
     */
    async function stopped(id: string, rows: Record<string, unknown> = {}) {
      const stub = host(id);
      await started(stub);
      await seedState(stub, rows);
      await evictDurableObject(stub);
      asked.length = 0;
      return stub;
    }

    it("asks for the main agent's new default when its bot was last asked for the old one", async () => {
      const kelpie = await stopped("kelpie", { botPhoto: OLD_KELPIE });
      // As the deploy's probe wakes it, before anyone writes to it.
      await kelpie.ping();
      await vi.waitFor(() => expect(asked).toEqual([["kelpie", KELPIE_MASCOT]]));
      await vi.waitFor(async () =>
        expect(await stateOf(kelpie, "botPhoto")).toEqual(KELPIE_MASCOT),
      );
    });

    it("asks nothing when it last asked for the mascot it shows, or the owner picked one", async () => {
      const same = await stopped("photo-start-same");
      const own = await stopped("photo-start-picked", {
        settings: { mascot: picked },
        botPhoto: OLD_KELPIE,
      });
      const control = await stopped("photo-start-control", { botPhoto: OLD_KELPIE });
      await same.ping();
      await own.ping();
      // Started last, so the others would have asked before it.
      await control.ping();
      await vi.waitFor(() => expect(asked).toHaveLength(1));
      await registryRoundTrip();
      expect(asked).toEqual([["photo-start-control", derivedMascot("photo-start-control")]]);
    });

    it("asks again at the next start after a failure, and remembers an agent without a bot", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const stub = await stopped("photo-start-retry", { botPhoto: OLD_KELPIE });
        const mascot = derivedMascot("photo-start-retry");
        answer = { ok: false, reason: "store_unavailable" };
        await stub.ping();
        await vi.waitFor(() =>
          expect(warn).toHaveBeenCalledWith(
            "AgentHost: the bot's photo wasn't asked for",
            "store_unavailable",
          ),
        );
        expect(await stateOf(stub, "botPhoto")).toEqual(OLD_KELPIE);

        answer = { ok: false, reason: "not_connected" };
        await evictDurableObject(stub);
        await stub.ping();
        await vi.waitFor(async () => expect(await stateOf(stub, "botPhoto")).toEqual(mascot));
        expect(asked).toEqual([
          ["photo-start-retry", mascot],
          ["photo-start-retry", mascot],
        ]);
      } finally {
        warn.mockRestore();
      }
    });

    it("keeps a mascot the owner picks while its default is looked up", async () => {
      const racing = await stopped("photo-start-race", { botPhoto: OLD_KELPIE });
      const control = await stopped("photo-start-race-control", { botPhoto: OLD_KELPIE });
      // The pick starts the object, whose start looks its default up in the Registry meanwhile.
      await racing.configure({ mascot: picked }, owner);
      await control.ping();
      await vi.waitFor(() => expect(asked).toHaveLength(2));
      await registryRoundTrip();
      expect(asked).toEqual([
        ["photo-start-race", picked],
        ["photo-start-race-control", derivedMascot("photo-start-race-control")],
      ]);
      await vi.waitFor(async () => expect(await stateOf(racing, "botPhoto")).toEqual(picked));
    });
  });
});
