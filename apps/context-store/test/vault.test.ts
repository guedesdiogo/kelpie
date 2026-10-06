import { createExecutionContext, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { FakeVaultBackend } from "@kelpie/vault/fake";
import { afterEach, describe, expect, it } from "vitest";
import { GitHubWebhooks, replaceBackendForTesting } from "../src/index.ts";
import { VAULT_README } from "../src/vault-readme.ts";

const SECRET = "webhook-secret-for-tests";

afterEach(() => replaceBackendForTesting(undefined));

/** A vault with a README already, so the first sync doesn't queue one. */
function vaultWith(files: Record<string, string>): FakeVaultBackend {
  const backend = new FakeVaultBackend({ "README.md": "# Vault", ...files });
  replaceBackendForTesting(backend);
  return backend;
}

const vault = (name: string) => env.VAULT.getByName(name);

async function signed(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `sha256=${Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

describe("Vault", () => {
  it("is off until the vault is configured", async () => {
    replaceBackendForTesting(null);
    const stub = vault("off");
    expect(await stub.compile("kelpie")).toEqual({ persona: null, rules: [], skills: [] });
    expect(await stub.read("AGENTS.md")).toBeNull();
    expect(await stub.write("kelpie", [{ path: "memory/notes/a.md", content: "a" }], "x")).toEqual({
      ok: false,
      reason: "vault_off",
    });
    expect(await stub.propose("kelpie", { kind: "persona" }, "x", "y")).toEqual({
      ok: false,
      reason: "vault_off",
    });
  });

  it("compiles an agent's persona, rules and skills", async () => {
    vaultWith({
      "AGENTS.md": "# Shared rules",
      "agents/kelpie/SOUL.md": "# Kelpie\n\nWarm and brief.",
      "agents/kelpie/AGENTS.md": "# Kelpie's rules",
      "agents/other/SOUL.md": "# Other",
      "skills/writing/brief/SKILL.md":
        "---\nname: brief\ndescription: Writes a brief.\n---\n# Brief",
      "skills/plain/SKILL.md": "# No frontmatter",
      "agents/kelpie/skills/recipes/SKILL.md": "---\ndescription: Finds recipes.\n---\nx",
      "agents/other/skills/secret/SKILL.md": "---\nname: secret\n---\nx",
    });
    expect(await vault("compile").compile("kelpie")).toEqual({
      persona: "# Kelpie\n\nWarm and brief.",
      rules: [
        { path: "AGENTS.md", content: "# Shared rules" },
        { path: "agents/kelpie/AGENTS.md", content: "# Kelpie's rules" },
      ],
      skills: [
        {
          name: "recipes",
          description: "Finds recipes.",
          path: "agents/kelpie/skills/recipes/SKILL.md",
        },
        { name: "plain", description: "", path: "skills/plain/SKILL.md" },
        { name: "brief", description: "Writes a brief.", path: "skills/writing/brief/SKILL.md" },
      ],
    });
    expect(await vault("compile").compile("Not An Id")).toEqual({
      persona: null,
      rules: [],
      skills: [],
    });
  });

  it("brings an edit made outside Kelpie to the next compile, through the signed webhook", async () => {
    const backend = vaultWith({ "agents/kelpie/SOUL.md": "# Before" });
    const stub = vault("vault");
    expect((await stub.compile("kelpie")).persona).toBe("# Before");

    const after = backend.push({ "agents/kelpie/SOUL.md": "# After, edited in Obsidian" });
    const body = JSON.stringify({ ref: "refs/heads/main", after, commits: [] });
    const hooks = new GitHubWebhooks(createExecutionContext(), env);
    expect(await hooks.receive({ event: "push", signature: "sha256=00", body })).toEqual({
      status: 401,
    });
    expect((await stub.compile("kelpie")).persona).toBe("# Before");
    expect(await hooks.receive({ event: "push", signature: await signed(body), body })).toEqual({
      status: 202,
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await stub.compile("kelpie")).persona).toBe("# After, edited in Obsidian");

    const ping = "{}";
    expect(
      await hooks.receive({ event: "ping", signature: await signed(ping), body: ping }),
    ).toEqual({
      status: 200,
    });
  });

  it("shows writes at once and commits them together, attributed to their agents", async () => {
    const backend = vaultWith({});
    const stub = vault("writes");
    expect(
      await stub.write(
        "kelpie",
        [{ path: "memory/people/ana.md", content: "# Ana" }],
        "Remember Ana",
      ),
    ).toEqual({ ok: true });
    expect(
      await stub.write(
        "helper",
        [
          { path: "knowledge/trip.md", content: "# Trip" },
          { path: "README.md", content: null },
        ],
        "Plan the trip",
      ),
    ).toEqual({ ok: false, reason: "invalid_path" });
    await stub.write("helper", [{ path: "knowledge/trip.md", content: "# Trip" }], "Plan the trip");
    expect(await stub.read("memory/people/ana.md")).toBe("# Ana");
    expect(backend.commitRequests).toHaveLength(0);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(backend.commitRequests).toHaveLength(1);
    expect(backend.commitRequests[0]).toMatchObject({
      branch: "main",
      headline: "Update 2 files from helper, kelpie",
      body: "Kelpie-Agent: helper\nKelpie-Agent: kelpie",
      deletions: [],
    });
    expect(backend.files()).toMatchObject({
      "memory/people/ana.md": "# Ana",
      "knowledge/trip.md": "# Trip",
    });
    // Its own commit comes back through the webhook and changes nothing.
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.storage.sql.exec("SELECT * FROM queue").toArray()).toEqual([]);
    });
    expect(await stub.read("memory/people/ana.md")).toBe("# Ana");
  });

  it("refuses writes outside memory and knowledge", async () => {
    vaultWith({});
    const stub = vault("refusals");
    for (const path of [
      "agents/kelpie/SOUL.md",
      "AGENTS.md",
      "skills/x/SKILL.md",
      "agents/other/memory/notes/a.md",
      "memory/../AGENTS.md",
      "memory/notes/photo.png",
      ".obsidian/workspace.md",
      "/memory/a.md",
    ]) {
      expect(await stub.write("kelpie", [{ path, content: "x" }], "x"), path).toEqual({
        ok: false,
        reason: "invalid_path",
      });
    }
    expect(
      await stub.write("kelpie", [{ path: "agents/kelpie/memory/notes/a.md", content: "x" }], "x"),
    ).toEqual({
      ok: true,
    });
  });

  it("commits on the owner's newer head, and lets the owner win on the same file", async () => {
    const backend = vaultWith({ "knowledge/shared.md": "# Shared" });
    const stub = vault("stale");
    await stub.compile("kelpie");
    await stub.write(
      "kelpie",
      [{ path: "knowledge/shared.md", content: "# Kelpie's version" }],
      "x",
    );
    await stub.write("kelpie", [{ path: "memory/notes/mine.md", content: "# Mine" }], "x");
    backend.push({
      "knowledge/shared.md": "# The owner's version",
      "knowledge/other.md": "# Other",
    });

    await runDurableObjectAlarm(stub);
    expect(backend.files()).toMatchObject({
      "knowledge/shared.md": "# The owner's version",
      "knowledge/other.md": "# Other",
      "memory/notes/mine.md": "# Mine",
    });
    expect(await stub.read("knowledge/shared.md")).toBe("# The owner's version");
    await runInDurableObject(stub, async (_instance, state) => {
      expect(
        state.storage.sql.exec("SELECT agent, path, content FROM conflicts").toArray(),
      ).toEqual([{ agent: "kelpie", path: "knowledge/shared.md", content: "# Kelpie's version" }]);
    });
  });

  it("opens a pull request for a skill, and leaves the main branch alone", async () => {
    const backend = vaultWith({ "agents/kelpie/SOUL.md": "# Kelpie" });
    const stub = vault("propose");
    const result = await stub.propose(
      "kelpie",
      { kind: "skill", name: "recipes" },
      "---\nname: recipes\ndescription: Finds recipes.\n---\n# Recipes",
      "The owner asked for recipes twice this week.",
    );
    expect(result).toEqual({ ok: true, url: "https://github.test/vault/pull/1" });
    const [pull] = backend.pullRequests;
    expect(pull).toMatchObject({ base: "main", title: "Propose skill recipes for kelpie" });
    expect(pull?.branch).toMatch(/^kelpie\/kelpie\/recipes-/);
    expect(backend.files(pull?.branch)).toHaveProperty("agents/kelpie/skills/recipes/SKILL.md");
    expect(backend.files()).not.toHaveProperty("agents/kelpie/skills/recipes/SKILL.md");
    expect(backend.commitRequests.at(-1)?.body).toBe(
      "The owner asked for recipes twice this week.\n\nKelpie-Agent: kelpie",
    );
    expect(await stub.propose("kelpie", { kind: "persona" }, "# Kelpie", "same")).toEqual({
      ok: false,
      reason: "unchanged",
    });
    expect(await stub.propose("kelpie", { kind: "skill", name: "../x" }, "x", "y")).toEqual({
      ok: false,
      reason: "invalid_target",
    });
  });

  it("writes a README to a vault that has none", async () => {
    const backend = new FakeVaultBackend({});
    replaceBackendForTesting(backend);
    const stub = vault("readme");
    await stub.compile("kelpie");
    await runDurableObjectAlarm(stub);
    expect(backend.files()["README.md"]).toBe(VAULT_README);
    expect(backend.commitRequests[0]?.body).toBe("Kelpie-Agent: context-store");
  });

  it("keeps queued writes and retries when GitHub fails", async () => {
    const backend = vaultWith({});
    const stub = vault("retry");
    await stub.write("kelpie", [{ path: "memory/notes/a.md", content: "# A" }], "x");
    const commit = backend.commit.bind(backend);
    backend.commit = async () => {
      throw new Error("GitHub commit answered 502");
    };
    await runDurableObjectAlarm(stub);
    expect(await stub.read("memory/notes/a.md")).toBe("# A");
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    backend.commit = commit;
    await runDurableObjectAlarm(stub);
    expect(backend.files()["memory/notes/a.md"]).toBe("# A");
  });
});
