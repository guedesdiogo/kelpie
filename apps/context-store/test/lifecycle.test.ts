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

  it("drops a queued report when content is forgotten, and writes it again from what is left", async () => {
    const backend = new FakeVaultBackend({
      "README.md": "# Vault",
      "memory/notes/receita-de-bolo.md": recipe,
      "knowledge/cozinha/receita-de-bolo.md": recipe,
    });
    replaceBackendForTesting(backend);
    replaceGatewayForTesting(null);
    const stub = vault("lifecycle-forget");
    await stub.compile("kelpie");
    await runDurableObjectAlarm(stub);
    await runDurableObjectAlarm(stub);
    expect(backend.files()).toHaveProperty(LIFECYCLE_REPORT_PATH);

    // A report still waiting in the queue names the note the owner is erasing.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO queue (agent, path, content, summary, queued_at) VALUES ('kelpie', ?, ?, 'x', 1)",
        LIFECYCLE_REPORT_PATH,
        "[[knowledge/cozinha/receita-de-bolo|Receita de bolo]]",
      );
      state.storage.sql.exec(
        "UPDATE state SET value = '9999999999999' WHERE key = 'lifecycle_after'",
      );
    });
    backend.forcePush({
      "README.md": "# Vault",
      "memory/notes/receita-de-bolo.md": recipe,
      [LIFECYCLE_REPORT_PATH]: backend.files()[LIFECYCLE_REPORT_PATH] ?? "",
    });
    expect(await stub.forget(["knowledge/cozinha/receita-de-bolo.md"])).toMatchObject({ ok: true });
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec("SELECT count(*) AS n FROM queue WHERE path = ?", LIFECYCLE_REPORT_PATH)
          .one().n,
      ).toBe(0);
    });

    // The next run is due at once, and memory is clean now.
    await runDurableObjectAlarm(stub);
    await runDurableObjectAlarm(stub);
    expect(backend.files()).not.toHaveProperty(LIFECYCLE_REPORT_PATH);
  });

  it("brings the index to the head before it reports", async () => {
    const backend = new FakeVaultBackend({
      "README.md": "# Vault",
      "memory/notes/receita-de-bolo.md": recipe,
      "knowledge/cozinha/receita-de-bolo.md": recipe,
    });
    replaceBackendForTesting(backend);
    replaceGatewayForTesting(null);
    const stub = vault("lifecycle-stale-index");
    await stub.compile("kelpie");
    await runDurableObjectAlarm(stub);
    await runDurableObjectAlarm(stub);
    const report = backend.files()[LIFECYCLE_REPORT_PATH];
    expect(report).toContain("## Duplicates");

    // As after a new schema: the index starts over empty.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM versions");
      state.storage.sql.exec("UPDATE state SET value = 'stale' WHERE key = 'index_commit'");
    });
    await aDayLater(stub);
    await runDurableObjectAlarm(stub);
    await runDurableObjectAlarm(stub);
    expect(backend.files()[LIFECYCLE_REPORT_PATH]).toBe(report);
  });
});
