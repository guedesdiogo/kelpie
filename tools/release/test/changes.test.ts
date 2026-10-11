import { describe, expect, it } from "vitest";
import { migrationChanges } from "../src/changes.ts";
import { gitAt } from "../src/git.ts";
import { barriersBetween } from "../src/live.ts";
import { WORKERS } from "../src/workers.ts";
import { tempRepo } from "./fakes.ts";

const DIR = "apps/conversation-runtime/src/migrations";
const journal = (...entries: Array<[string, number]>) =>
  JSON.stringify({
    entries: entries.map(([tag, when], idx) => ({
      idx,
      version: "6",
      when,
      tag,
      breakpoints: true,
    })),
  });
const imports = (...tags: string[]) =>
  tags.map((tag) => `import m from "./${tag}.sql";`).join("\n");
const wrangler = (migrations: string) => `{
  "name": "kelpie-conversation-runtime",
  // Durable Objects
  "migrations": ${migrations},
}`;

function baseRepo() {
  const repo = tempRepo();
  const base = repo.commit({
    [`${DIR}/0000_init.sql`]: "CREATE TABLE `turns` (`id` integer);",
    [`${DIR}/meta/_journal.json`]: journal(["0000_init", 100]),
    [`${DIR}/migrations.js`]: imports("0000_init"),
    "apps/conversation-runtime/wrangler.jsonc": wrangler(
      '[{ "tag": "v1", "new_sqlite_classes": ["ConversationAgent"] }]',
    ),
  });
  return { repo, base, git: gitAt(repo.dir) };
}

describe("migrationChanges", () => {
  it("passes an added column", () => {
    const { repo, base, git } = baseRepo();
    const head = repo.commit({
      [`${DIR}/0001_add.sql`]: "ALTER TABLE `turns` ADD `key` text;",
      [`${DIR}/meta/_journal.json`]: journal(["0000_init", 100], ["0001_add", 200]),
      [`${DIR}/migrations.js`]: imports("0000_init", "0001_add"),
    });
    expect(migrationChanges(git, base, head)).toEqual({ problems: [], findings: [] });
  });

  it("finds a dropped column, and whether it's acknowledged", () => {
    const { repo, base, git } = baseRepo();
    const files = (sql: string) => ({
      [`${DIR}/0001_drop.sql`]: sql,
      [`${DIR}/meta/_journal.json`]: journal(["0000_init", 100], ["0001_drop", 200]),
      [`${DIR}/migrations.js`]: imports("0000_init", "0001_drop"),
    });
    const bare = repo.commit(files("ALTER TABLE `turns` DROP COLUMN `id`;"));
    expect(migrationChanges(git, base, bare).findings).toEqual([
      {
        app: "conversation-runtime",
        file: `${DIR}/0001_drop.sql`,
        kind: "destructive-sql",
        detail: "drops a column",
        acknowledged: false,
      },
    ]);
    const marked = repo.commit(
      files(
        "-- rollback-barrier: nothing reads it since #100\nALTER TABLE `turns` DROP COLUMN `id`;",
      ),
    );
    expect(migrationChanges(git, base, marked).findings[0]?.acknowledged).toBe(true);
  });

  it("refuses an edited migration and an out-of-order journal", () => {
    const { repo, base, git } = baseRepo();
    const head = repo.commit({
      [`${DIR}/0000_init.sql`]: "CREATE TABLE `turns` (`id` integer, `x` text);",
      [`${DIR}/0001_late.sql`]: "CREATE TABLE `late` (`id` integer);",
      [`${DIR}/meta/_journal.json`]: journal(["0000_init", 100], ["0001_late", 50]),
      [`${DIR}/migrations.js`]: imports("0000_init", "0001_late"),
    });
    const { problems } = migrationChanges(git, base, head);
    expect(problems).toEqual([
      `${DIR}/0000_init.sql: an applied migration was edited. Migrations are append-only; add a new one instead.`,
      expect.stringContaining('"0001_late" is dated before "0000_init"'),
    ]);
  });

  it("reads class migrations from wrangler.jsonc", () => {
    const { repo, base, git } = baseRepo();
    const added = repo.commit({
      "apps/conversation-runtime/wrangler.jsonc": wrangler(
        '[{ "tag": "v1", "new_sqlite_classes": ["ConversationAgent"] }, { "tag": "v2", "new_sqlite_classes": ["AgentHost"] }]',
      ),
    });
    expect(migrationChanges(git, base, added).findings).toMatchObject([
      { kind: "class-change", detail: 'class migration "v2" adds AgentHost' },
    ]);
    const edited = repo.commit({
      "apps/conversation-runtime/wrangler.jsonc": wrangler(
        '[{ "tag": "v1", "new_sqlite_classes": ["Other"] }]',
      ),
    });
    expect(migrationChanges(git, base, edited).problems).toHaveLength(1);
  });

  it("keeps to the Workers asked for", () => {
    const { repo, base, git } = baseRepo();
    const head = repo.commit({
      "apps/channel-egress/src/secrets/migrations/0003_drop.sql": "DROP TABLE `forms`;",
    });
    expect(migrationChanges(git, base, head, ["conversation-runtime"]).findings).toEqual([]);
    expect(migrationChanges(git, base, head, ["channel-egress"]).findings).toHaveLength(1);
  });
});

describe("barriersBetween", () => {
  const runtime = WORKERS.find((worker) => worker.app === "conversation-runtime");

  it("finds the barriers between two builds, in either direction", () => {
    const { repo, base, git } = baseRepo();
    const head = repo.commit({ [`${DIR}/0001_drop.sql`]: "DROP TABLE `turns`;" });
    if (!runtime) throw new Error("no conversation-runtime");
    const older = { build: 1, commit: base.slice(0, 7) };
    const newer = { build: 2, commit: head.slice(0, 7) };
    const forward = barriersBetween(git, [{ spec: runtime, from: older, to: newer }]);
    expect(forward).toEqual([
      {
        script: "kelpie-conversation-runtime",
        kind: "destructive-sql",
        detail: `${DIR}/0001_drop.sql: drops a table`,
      },
    ]);
    expect(barriersBetween(git, [{ spec: runtime, from: newer, to: older }])).toEqual(forward);
    expect(barriersBetween(git, [{ spec: runtime, from: newer, to: newer }])).toEqual([]);
  });

  it("can't vouch for an untagged build or an unknown commit", () => {
    const { git } = baseRepo();
    if (!runtime) throw new Error("no conversation-runtime");
    expect(
      barriersBetween(git, [{ spec: runtime, from: null, to: { build: 2, commit: "abcdef0" } }])[0]
        ?.kind,
    ).toBe("unknown");
    expect(
      barriersBetween(git, [
        {
          spec: runtime,
          from: { build: 1, commit: "0000000" },
          to: { build: 2, commit: "abcdef0" },
        },
      ])[0],
    ).toMatchObject({ kind: "unknown", detail: "commit 0000000 isn't in this checkout's history" });
  });
});
