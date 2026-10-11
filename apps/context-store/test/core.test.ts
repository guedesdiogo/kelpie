import { reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { FakeVaultBackend } from "@kelpie/vault/fake";
import { afterEach, describe, expect, it } from "vitest";
import { replaceBackendForTesting, replaceGatewayForTesting } from "../src/index.ts";

afterEach(async () => {
  replaceBackendForTesting(undefined);
  replaceGatewayForTesting(undefined);
  // A test's vaults go, alarms and all (#223): one left with an alarm wakes in a later test, where
  // it syncs with that test's backend and asks that test's model.
  await reset();
});

const vault = (name: string) => env.VAULT.getByName(name);

const pinned = (title: string, body: string) => `---\npinned: true\n---\n# ${title}\n\n${body}\n`;

describe("Vault core", () => {
  it("loads the agent's core from the vault, and counts no access", async () => {
    replaceBackendForTesting(
      new FakeVaultBackend({
        "README.md": "# Vault",
        "memory/notes/cafe.md": pinned("Café", "Sem açúcar."),
        "memory/notes/cha.md": "# Chá\n\nVerde.\n",
        "memory/profile/rotina.md": "# Rotina\n\nAcorda cedo.\n",
        "agents/kelpie/memory/profile/tom.md": "# Tom\n\nCurto e direto.\n",
        "agents/hermes/memory/notes/agenda.md": pinned("Agenda", "Só do Hermes."),
      }),
    );
    replaceGatewayForTesting(null);
    const stub = vault("core-loads");
    const core = await stub.core("kelpie", 1_000);
    expect(core.paths).toEqual([
      "memory/notes/cafe.md",
      "memory/profile/rotina.md",
      "agents/kelpie/memory/profile/tom.md",
    ]);
    expect(core.text).toContain("Acorda cedo.");
    expect(core.text).not.toContain("Só do Hermes.");
    expect(core.omitted).toBe(0);
    expect(
      await runInDurableObject(
        stub,
        (_instance, state) =>
          state.storage.sql.exec("SELECT count(*) AS n FROM recall_counts").one().n,
      ),
    ).toBe(0);
  });

  it("caps the budget at 8,000 tokens, as recall's", async () => {
    const long = (title: string) => pinned(title, "Longa. ".repeat(2_000));
    replaceBackendForTesting(
      new FakeVaultBackend({
        "README.md": "# Vault",
        "memory/notes/a.md": long("A"),
        "memory/notes/b.md": long("B"),
        "memory/notes/c.md": long("C"),
      }),
    );
    replaceGatewayForTesting(null);
    const core = await vault("core-cap").core("kelpie", 1_000_000);
    expect(core.paths).toEqual(["memory/notes/a.md", "memory/notes/b.md"]);
    expect(core.omitted).toBe(1);
    expect(core.text.length).toBeLessThanOrEqual(8_000 * 4);
  });

  it("answers an empty core while the vault is off, and for an agent id that isn't one", async () => {
    replaceBackendForTesting(null);
    const empty = { text: "", tokens: 0, paths: [], omitted: 0 };
    expect(await vault("core-off").core("kelpie", 1_000)).toEqual(empty);
    replaceBackendForTesting(
      new FakeVaultBackend({ "README.md": "# Vault", "memory/notes/cafe.md": pinned("Café", "x") }),
    );
    replaceGatewayForTesting(null);
    expect(await vault("core-bad-id").core("../kelpie", 1_000)).toEqual(empty);
    expect(await vault("core-no-budget").core("kelpie", 0)).toEqual(empty);
  });
});
