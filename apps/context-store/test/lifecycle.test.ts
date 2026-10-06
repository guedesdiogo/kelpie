import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { LIFECYCLE_REPORT_PATH } from "@kelpie/memory";
import { FakeVaultBackend } from "@kelpie/vault/fake";
import { afterEach, describe, expect, it } from "vitest";
import { replaceBackendForTesting, replaceGatewayForTesting } from "../src/index.ts";

afterEach(() => {
  replaceBackendForTesting(undefined);
  replaceGatewayForTesting(undefined);
});

const vault = (name: string) => env.VAULT.getByName(name);

/** Makes the next daily run due now, as if a day had passed. */
async function aDayLater(stub: ReturnType<typeof vault>) {
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec("UPDATE state SET value = '0' WHERE key = 'lifecycle_after'");
  });
}

describe("Vault lifecycle", () => {
  const recipe = "# Receita de bolo\n\nTrês ovos.\n";

  it("writes the memory report once a day, and nothing when it hasn't changed", async () => {
    const backend = new FakeVaultBackend({
      "README.md": "# Vault",
      "memory/notes/receita-de-bolo.md": recipe,
      "knowledge/cozinha/receita-de-bolo.md": recipe,
    });
    replaceBackendForTesting(backend);
    replaceGatewayForTesting(null);
    const stub = vault("lifecycle-report");
    await stub.compile("kelpie");

    await runDurableObjectAlarm(stub);
    await runDurableObjectAlarm(stub);
    const report = backend.files()[LIFECYCLE_REPORT_PATH] ?? "";
    expect(report).toContain("## Duplicates");
    expect(report).toContain("[[knowledge/cozinha/receita-de-bolo|Receita de bolo]]");
    const commits = backend.commitRequests.length;

    // The same findings a day later: the same page, so no commit.
    await aDayLater(stub);
    await runDurableObjectAlarm(stub);
    await runDurableObjectAlarm(stub);
    expect(backend.commitRequests).toHaveLength(commits);

    // The report itself is never memory.
    const recalled = await stub.recall("kelpie", "receita de bolo duplicada", {
      scopes: "all",
      budgetTokens: 1_000,
    });
    expect(recalled.text).not.toContain("Memory report");
    expect(recalled.paths).not.toContain(LIFECYCLE_REPORT_PATH);
  });

  it("removes the page once memory is clean, and waits a day between runs", async () => {
    const backend = new FakeVaultBackend({
      "README.md": "# Vault",
      "memory/notes/receita-de-bolo.md": recipe,
      "knowledge/cozinha/receita-de-bolo.md": recipe,
    });
    replaceBackendForTesting(backend);
    replaceGatewayForTesting(null);
    const stub = vault("lifecycle-clean");
    await stub.compile("kelpie");
    await runDurableObjectAlarm(stub);
    await runDurableObjectAlarm(stub);
    expect(backend.files()).toHaveProperty(LIFECYCLE_REPORT_PATH);

    backend.push({ "knowledge/cozinha/receita-de-bolo.md": null });
    await runDurableObjectAlarm(stub);
    await runDurableObjectAlarm(stub);
    // Not due yet: the page stays until the next daily run.
    expect(backend.files()).toHaveProperty(LIFECYCLE_REPORT_PATH);

    await aDayLater(stub);
    await runDurableObjectAlarm(stub);
    await runDurableObjectAlarm(stub);
    expect(backend.files()).not.toHaveProperty(LIFECYCLE_REPORT_PATH);
  });
});
