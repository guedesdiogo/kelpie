import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { DREAM_PAGE_PATH, LIFECYCLE_REPORT_PATH } from "@kelpie/memory";
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
        "INSERT INTO conflicts (agent, path, content, reason, at) VALUES ('kelpie', ?, ?, 'owner_won', 1)",
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
          .exec(
            "SELECT (SELECT count(*) FROM queue WHERE path = ?1) + (SELECT count(*) FROM conflicts WHERE path = ?1) AS n",
            LIFECYCLE_REPORT_PATH,
          )
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

  it("lists the owner's notes Kelpie changed, and not its own", async () => {
    const backend = new FakeVaultBackend({
      "README.md": "# Vault",
      "memory/notes/cha.md": "# Chá\n\nVerde.\n",
      "memory/notes/velho.md": "# Velho\n\nApagar.\n",
      // The owner's edit of the report itself: Kelpie's next report isn't a change to list.
      [LIFECYCLE_REPORT_PATH]: "# Memory report\n\nEditado à mão.\n",
      // Nor is Dream's page, which goes with no summary to show.
      [DREAM_PAGE_PATH]: "# Dream's day summaries\n\nEditado à mão.\n",
    });
    replaceBackendForTesting(backend);
    replaceGatewayForTesting(null);
    const stub = vault("lifecycle-owner-changes");
    await stub.compile("kelpie");
    await stub.write(
      "kelpie",
      [{ path: "memory/notes/cha.md", content: "# Chá\n\nPreto.\n" }],
      "x",
    );
    await stub.write("kelpie", [{ path: "memory/notes/velho.md", content: null }], "x");
    await stub.write(
      "kelpie",
      [{ path: "memory/notes/pao.md", content: "# Pão\n\nIntegral.\n" }],
      "x",
    );
    await runDurableObjectAlarm(stub);
    await stub.write(
      "kelpie",
      [{ path: "memory/notes/pao.md", content: "# Pão\n\nCom sal.\n" }],
      "x",
    );
    await aDayLater(stub);
    // A change older than a week is no longer listed, nor kept.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO owner_changes (path, at) VALUES ('memory/notes/velha.md', 1)",
      );
    });
    await runDurableObjectAlarm(stub);
    await runDurableObjectAlarm(stub);
    const report = backend.files()[LIFECYCLE_REPORT_PATH] ?? "";
    expect(report).toContain("## Your notes Kelpie changed");
    expect(report).toContain("[[memory/notes/cha|Chá]]: changed");
    expect(report).not.toContain("memory/notes/pao");
    expect(report).toContain("- `memory/notes/velho.md`: removed");
    expect(report).not.toContain("velha");
    expect(backend.files()[DREAM_PAGE_PATH]).toBeUndefined();
    expect(
      await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec("SELECT path FROM owner_changes ORDER BY path").toArray(),
      ),
    ).toEqual([{ path: "memory/notes/cha.md" }, { path: "memory/notes/velho.md" }]);
  });

  it("drops a merge's mark once its version is gone, and keeps one still waiting to commit", async () => {
    const cha = "memory/notes/cha.md";
    const pao = "memory/notes/pao.md";
    const sal = "memory/notes/sal.md";
    const backend = new FakeVaultBackend({
      "README.md": "# Vault",
      [cha]: "# Chá\n\nVerde.\n",
      [pao]: "# Pão\n\nIntegral.\n",
      [sal]: "# Sal\n\nPouco.\n",
    });
    replaceBackendForTesting(backend);
    replaceGatewayForTesting(null);
    const stub = vault("lifecycle-owner-merges");
    await stub.compile("kelpie");
    // A conflict pushed into Sal holds it, so Kelpie's write to it waits in the queue.
    backend.push({
      [sal]: "# Sal\n\n<<<<<<< HEAD\nPouco.\n=======\nNada.\n>>>>>>> origin/main\n",
    });
    await runDurableObjectAlarm(stub);
    await stub.write("kelpie", [{ path: sal, content: "# Sal\n\nPouco, e fino.\n" }], "x");
    await runInDurableObject(stub, (_instance, state) => {
      for (const [path, content] of [
        // The vault's version: kept.
        [cha, "# Chá\n\nVerde.\n"],
        // A version replaced since, and a removed note: their text goes.
        [pao, "# Pão\n\nCom sal.\n"],
        ["memory/notes/velho.md", "# Velho\n"],
        // Still waiting to commit: kept.
        [sal, "# Sal\n\nPouco, e fino.\n"],
      ]) {
        state.storage.sql.exec(
          "INSERT INTO owner_merges (path, content) VALUES (?, ?)",
          path,
          content,
        );
      }
    });
    await aDayLater(stub);
    await runDurableObjectAlarm(stub);
    expect(
      await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec("SELECT path FROM owner_merges ORDER BY path").toArray(),
      ),
    ).toEqual([{ path: cha }, { path: sal }]);
  });

  it("lists a change whose commit answer was lost, once the sync finds it", async () => {
    const backend = new FakeVaultBackend({
      "README.md": "# Vault",
      "memory/notes/cha.md": "# Chá\n\nVerde.\n",
      "memory/notes/velho.md": "# Velho\n\nApagar.\n",
    });
    replaceBackendForTesting(backend);
    replaceGatewayForTesting(null);
    const stub = vault("lifecycle-owner-lost-answer");
    await stub.compile("kelpie");
    const commit = backend.commit.bind(backend);
    let lose = false;
    backend.commit = async (request) => {
      const outcome = await commit(request);
      if (lose) {
        lose = false;
        throw new Error("GitHub commit answered 502");
      }
      return outcome;
    };
    await stub.write(
      "kelpie",
      [{ path: "memory/notes/pao.md", content: "# Pão\n\nIntegral.\n" }],
      "x",
    );
    await runDurableObjectAlarm(stub);
    lose = true;
    await stub.write(
      "kelpie",
      [
        { path: "memory/notes/cha.md", content: "# Chá\n\nPreto.\n" },
        { path: "memory/notes/velho.md", content: null },
        // Kelpie's own note: replacing its version isn't the owner's change.
        { path: "memory/notes/pao.md", content: "# Pão\n\nCom sal.\n" },
      ],
      "x",
    );
    await runDurableObjectAlarm(stub);
    await runDurableObjectAlarm(stub);
    expect(backend.files()["memory/notes/cha.md"]).toBe("# Chá\n\nPreto.\n");
    expect(backend.files()["memory/notes/velho.md"]).toBeUndefined();
    expect(backend.files()["memory/notes/pao.md"]).toBe("# Pão\n\nCom sal.\n");
    expect(
      await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec("SELECT path, removed FROM owner_changes ORDER BY path").toArray(),
      ),
    ).toEqual([
      { path: "memory/notes/cha.md", removed: 0 },
      { path: "memory/notes/velho.md", removed: 1 },
    ]);
  });
});
