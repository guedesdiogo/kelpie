import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { DREAM_PAGE_PATH, LIFECYCLE_REPORT_PATH } from "@kelpie/memory";
import { gitBlobSha } from "@kelpie/vault";
import { FakeVaultBackend } from "@kelpie/vault/fake";
import { afterEach, describe, expect, it } from "vitest";
import {
  ContextStore,
  ContextStoreAdmin,
  type MemoryGateway,
  replaceBackendForTesting,
  replaceGatewayForTesting,
} from "../src/index.ts";

afterEach(() => {
  replaceBackendForTesting(undefined);
  replaceGatewayForTesting(undefined);
});

const vault = (name: string) => env.VAULT.getByName(name);

/** A gateway that embeds every note, so old content leaves vectors behind. */
function embeddingGateway(): void {
  const gateway: MemoryGateway = {
    async embed(texts) {
      return { ok: true, model: "fake-model", vectors: texts.map(() => [1, 0]) };
    },
    async qualify() {
      return { ok: false, reason: "failed" };
    },
    async generate() {
      throw new Error("forgetting never generates");
    },
  };
  replaceGatewayForTesting(gateway);
}

describe("Vault forget", () => {
  const ana = "memory/people/ana.md";
  const bia = "memory/people/bia.md";
  const leaked = "# Ana\n\nMora em Lisboa. Senha do wifi: girassol-42.\n";
  const clean = "# Ana\n\nMora em Lisboa.\n";

  it("drops old versions, their vectors and the rows that name the paths, and keeps the rest", async () => {
    const backend = new FakeVaultBackend({
      "README.md": "# Vault",
      [ana]: leaked,
      [bia]: "# Bia\n",
    });
    replaceBackendForTesting(backend);
    embeddingGateway();
    const stub = vault("forget");
    await stub.compile("kelpie");
    await runDurableObjectAlarm(stub);
    backend.push({ [ana]: clean });
    await runDurableObjectAlarm(stub);
    await stub.write("kelpie", [{ path: ana, content: `${clean}\nGosta de café.\n` }], "x");
    const sql = (query: string) =>
      runInDurableObject(stub, (_instance, state) => state.storage.sql.exec(query).toArray());
    await runInDurableObject(stub, (_instance, state) => {
      for (const path of [ana, bia]) {
        state.storage.sql.exec(
          "INSERT INTO conflicts (agent, path, content, reason, at) VALUES ('kelpie', ?, 'x', 'owner_won', 1)",
          path,
        );
        state.storage.sql.exec(
          "INSERT INTO recall_counts (path, count, last_at) VALUES (?, 1, 1)",
          path,
        );
        state.storage.sql.exec("INSERT INTO owner_changes (path, at) VALUES (?, 1)", path);
        state.storage.sql.exec("INSERT INTO owner_merges (path, content) VALUES (?, 'x')", path);
        state.storage.sql.exec(
          "INSERT INTO dream_proposals (path, blob_sha, abstract, at) VALUES (?, 'sha', 'x', 1)",
          path,
        );
        state.storage.sql.exec(
          "INSERT INTO dream_writes (path, blob_sha, abstract, at) VALUES (?, 'sha', 'x', 1)",
          path,
        );
        state.storage.sql.exec(
          "INSERT INTO dream_summaries (path, key, summary, sources, at) VALUES (?, 'k', 'x', '[]', 1)",
          path,
        );
        state.storage.sql.exec(
          "INSERT INTO dream_merges (path, key, sources, verdict, body, at) VALUES (?, 'k', '[]', 'same', NULL, 1)",
          path,
        );
        state.storage.sql.exec(
          "INSERT INTO held (path, content, previous, state, attempts, at) VALUES (?, 'x', NULL, 'resolved', 1, 1)",
          path,
        );
        state.storage.sql.exec(
          `INSERT INTO proposals (agent, path, content_sha, base_blob_sha, branch, pull_request, url, at)
           VALUES ('kelpie', ?, 'sha', NULL, 'b', 1, 'https://github.test/vault/pull/1', 1)`,
          path,
        );
      }
    });
    expect(await sql(`SELECT count(*) AS n FROM versions WHERE path = '${ana}'`)).toEqual([
      { n: 2 },
    ]);
    const leakedBlob = await gitBlobSha(leaked);
    expect(
      await sql(`SELECT count(*) AS n FROM embeddings WHERE blob_sha = '${leakedBlob}'`),
    ).toEqual([{ n: 1 }]);

    // The owner rewrote the history, so the leaked version is gone from git.
    // Its current files changed too: forgetting syncs before it rebuilds.
    backend.forcePush({ "README.md": "# Vault", [ana]: clean, [bia]: "# Bia\n\nNova.\n" });
    expect(await stub.forget([ana])).toEqual({ ok: true, forgotten: 11, stillInVault: [ana] });

    expect(await sql("SELECT path FROM versions ORDER BY path")).toEqual([
      { path: ana },
      { path: bia },
    ]);
    expect(
      await sql(`SELECT count(*) AS n FROM embeddings WHERE blob_sha = '${leakedBlob}'`),
    ).toEqual([{ n: 0 }]);
    // Ana's current vector stays; Bia's old one goes with her old content, which no version holds.
    expect(await sql("SELECT blob_sha FROM embeddings")).toEqual([
      { blob_sha: await gitBlobSha(clean) },
    ]);
    const named = [
      "conflicts",
      "held",
      "proposals",
      "recall_counts",
      "owner_changes",
      "owner_merges",
      "dream_proposals",
      "dream_writes",
      "dream_summaries",
      "dream_merges",
    ];
    for (const table of ["queue", ...named]) {
      expect(await sql(`SELECT count(*) AS n FROM ${table} WHERE path = '${ana}'`)).toEqual([
        { n: 0 },
      ]);
    }
    for (const table of named) {
      expect(await sql(`SELECT path FROM ${table}`)).toEqual([{ path: bia }]);
    }
    expect(await sql(`SELECT body FROM versions WHERE path = '${bia}'`)).toEqual([
      { body: expect.stringContaining("Nova.") },
    ]);
    // Recall works on, from the rebuilt index.
    const recalled = await stub.recall("kelpie", "onde a Ana mora?", {
      scopes: "all",
      budgetTokens: 1_000,
    });
    expect(recalled.text).toContain("Mora em Lisboa.");
    expect(recalled.text).not.toContain("girassol");
    // The rebuilt index stands at the head, so recall doesn't index it all over again.
    expect(await sql(`SELECT count(*) AS n FROM versions WHERE path = '${ana}'`)).toEqual([
      { n: 1 },
    ]);
  });

  it("drops the report and Dream's page wherever they wait, and wakes soon to write them again", async () => {
    replaceBackendForTesting(new FakeVaultBackend({ "README.md": "# Vault", [ana]: clean }));
    const stub = vault("forget-pages");
    await stub.compile("kelpie");
    await runDurableObjectAlarm(stub);
    await runInDurableObject(stub, (_instance, state) => {
      for (const page of [LIFECYCLE_REPORT_PATH, DREAM_PAGE_PATH]) {
        state.storage.sql.exec(
          "INSERT INTO queue (agent, path, content, summary, queued_at) VALUES ('context-store', ?, 'x', 'x', 1)",
          page,
        );
        state.storage.sql.exec(
          "INSERT INTO conflicts (agent, path, content, reason, at) VALUES ('context-store', ?, 'x', 'owner_won', 1)",
          page,
        );
        state.storage.sql.exec("INSERT INTO owner_merges (path, content) VALUES (?, 'x')", page);
        state.storage.sql.exec(
          "INSERT INTO held (path, content, previous, state, attempts, at) VALUES (?, 'x', 'y', 'held', 0, 1)",
          page,
        );
      }
    });
    expect(await stub.forget([ana])).toMatchObject({ ok: true });
    expect(
      await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec(
            `SELECT path FROM queue UNION ALL SELECT path FROM conflicts
             UNION ALL SELECT path FROM owner_merges UNION ALL SELECT path FROM held`,
          )
          .toArray(),
      ),
    ).toEqual([]);
    // The next alarm writes them again from what is left, and soon.
    const due = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    expect((due ?? Number.POSITIVE_INFINITY) - Date.now()).toBeLessThanOrEqual(5_000);
  });

  it("forgets a folder, and names what the vault still has", async () => {
    const backend = new FakeVaultBackend({
      "README.md": "# Vault",
      "memory/people/ana.md": "# Ana\n",
      "memory/people/bia.md": "# Bia\n",
      "memory/notes/caio.md": "# Caio\n",
    });
    replaceBackendForTesting(backend);
    replaceGatewayForTesting(null);
    const stub = vault("forget-folder");
    await stub.compile("kelpie");
    await stub.write(
      "kelpie",
      [
        { path: "memory/people/ana.md", content: "# Ana\n\nNova.\n" },
        { path: "memory/notes/caio.md", content: "# Caio\n\nNovo.\n" },
      ],
      "x",
    );
    // The rewrite dropped the people folder, but it wasn't pushed for Caio.
    backend.forcePush({ "README.md": "# Vault", "memory/notes/caio.md": "# Caio\n" });
    // A path names that file only, not every path it begins.
    expect(await stub.forget(["memory/notes/cai"])).toMatchObject({ forgotten: 0 });
    expect(await stub.forget(["memory/people/", "memory/notes/caio.md"])).toEqual({
      ok: true,
      forgotten: 2,
      stillInVault: ["memory/notes/caio.md"],
    });
    const left = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec("SELECT path FROM queue").toArray(),
    );
    expect(left).toEqual([]);
  });

  it("keeps the hold of a file the vault still has with markers", async () => {
    const base = "# Ana\n\nMora em Lisboa.\n";
    const backend = new FakeVaultBackend({ "README.md": "# Vault", "memory/people/ana.md": base });
    replaceBackendForTesting(backend);
    replaceGatewayForTesting(null);
    const stub = vault("forget-held");
    await stub.compile("kelpie");
    backend.push({
      "memory/people/ana.md":
        "# Ana\n\n<<<<<<< HEAD\nMora no Porto.\n=======\nMora em Braga.\n>>>>>>> main\n",
    });
    await runDurableObjectAlarm(stub);
    expect(await stub.forget(["memory/people/ana.md"])).toMatchObject({ ok: true });
    expect(await stub.read("memory/people/ana.md")).toBe(base);
    expect(await stub.held()).toHaveLength(1);
  });

  it("drops the hold of a page Kelpie writes, conflict and all: the next report writes it again", async () => {
    const backend = new FakeVaultBackend({ "README.md": "# Vault", [ana]: clean });
    replaceBackendForTesting(backend);
    replaceGatewayForTesting(null);
    const stub = vault("forget-held-page");
    await stub.compile("kelpie");
    backend.push({
      [LIFECYCLE_REPORT_PATH]:
        "# Memory report\n\n<<<<<<< HEAD\nUma.\n=======\nOutra.\n>>>>>>> main\n",
    });
    await runDurableObjectAlarm(stub);
    expect(await stub.held()).toHaveLength(1);
    expect(await stub.forget([ana])).toMatchObject({ ok: true });
    expect(await stub.held()).toEqual([]);
    // The next alarms write the page again from what is left: here, memory is clean, so it goes.
    await runDurableObjectAlarm(stub);
    await runDurableObjectAlarm(stub);
    expect(backend.files()[LIFECYCLE_REPORT_PATH]).toBeUndefined();
  });

  it("refuses paths it can't name, and does nothing with the vault off", async () => {
    replaceBackendForTesting(new FakeVaultBackend({ "README.md": "# Vault" }));
    const stub = vault("forget-input");
    for (const paths of [[], "memory/a.md", [42], ["x".repeat(301)], Array(1_001).fill("a.md")]) {
      expect(await stub.forget(paths as string[])).toEqual({ ok: false, reason: "invalid_input" });
    }
    // At the limits, it goes through.
    const edge = await stub.forget([
      ...Array(999).fill("memory/a.md"),
      `memory/${"a".repeat(290)}.md`,
    ]);
    expect(edge).toMatchObject({ ok: true });

    const failing = new FakeVaultBackend({ "README.md": "# Vault" });
    failing.branchHead = async () => {
      throw new Error("GitHub answered 502");
    };
    replaceBackendForTesting(failing);
    expect(await vault("forget-down").forget(["memory/a.md"])).toEqual({
      ok: false,
      reason: "unavailable",
    });

    replaceBackendForTesting(null);
    expect(await vault("forget-off").forget(["memory/a.md"])).toEqual({
      ok: false,
      reason: "vault_off",
    });
  });

  it("is reachable only through the admin entrypoint, which conversations don't bind", () => {
    const methods = (entrypoint: { prototype: object }) =>
      Object.getOwnPropertyNames(entrypoint.prototype);
    expect(methods(ContextStore)).not.toContain("forget");
    expect(methods(ContextStore)).not.toContain("held");
    expect(methods(ContextStore)).not.toContain("setDream");
    expect(methods(ContextStoreAdmin)).toEqual(["constructor", "held", "forget", "setDream"]);
  });
});
