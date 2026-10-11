import { describe, expect, it } from "vitest";
import { parseJsonc } from "../src/jsonc.ts";
import {
  type ClassMigration,
  classChanges,
  journalProblems,
  sqlAcknowledged,
  unsafeStatements,
} from "../src/migrations.ts";

describe("parseJsonc", () => {
  it("reads comments and trailing commas, and leaves strings alone", () => {
    const text = `{
      // a comment
      "url": "https://example.com/a,]", /* block */
      "list": [1, 2,],
      "nested": { "a": "\\"//\\"", },
    }`;
    expect(parseJsonc(text)).toEqual({
      url: "https://example.com/a,]",
      list: [1, 2],
      nested: { a: '"//"' },
    });
  });
});

describe("unsafeStatements", () => {
  it.each([
    ["ALTER TABLE `turns` DROP COLUMN `system_prompt`;", "drops a column"],
    ["DROP TABLE `old`;", "drops a table"],
    ["ALTER TABLE `a` RENAME TO `b`;", "renames a table or column"],
    ["ALTER TABLE `a` RENAME COLUMN `x` TO `y`;", "renames a table or column"],
    ["UPDATE `agents` SET `name` = 'x';", "rewrites rows"],
    ["DELETE FROM `agents`;", "deletes rows"],
  ])("flags %s", (sql, reason) => {
    expect(unsafeStatements(sql)).toEqual([reason]);
  });

  it("flags a table Drizzle rebuilds", () => {
    const sql = [
      "PRAGMA foreign_keys=OFF;--> statement-breakpoint",
      "CREATE TABLE `__new_turns` (`id` integer PRIMARY KEY NOT NULL);--> statement-breakpoint",
      "INSERT INTO `__new_turns`(`id`) SELECT `id` FROM `turns`;--> statement-breakpoint",
      "DROP TABLE `turns`;--> statement-breakpoint",
      "ALTER TABLE `__new_turns` RENAME TO `turns`;",
    ].join("\n");
    expect(unsafeStatements(sql)).toEqual(["drops a table", "renames a table or column"]);
  });

  it("passes additive changes, seeds and foreign key actions", () => {
    const sql = [
      "CREATE TABLE `a` (`id` integer, `b` integer REFERENCES `b`(`id`) ON UPDATE CASCADE ON DELETE SET NULL);--> statement-breakpoint",
      "ALTER TABLE `turns` ADD `prompt_key` text;--> statement-breakpoint",
      "CREATE INDEX `i` ON `a` (`b`);--> statement-breakpoint",
      "-- DELETE FROM in a comment",
      "INSERT OR IGNORE INTO `agents` (`id`) VALUES ('setup');",
    ].join("\n");
    expect(unsafeStatements(sql)).toEqual([]);
  });

  it("reads the acknowledgement on a line of its own", () => {
    expect(
      sqlAcknowledged("-- rollback-barrier: the old column is unused since #12\nDROP TABLE x;"),
    ).toBe(true);
    expect(sqlAcknowledged("-- rollback-barrier:\nDROP TABLE x;")).toBe(false);
    expect(sqlAcknowledged("DROP TABLE x;")).toBe(false);
  });
});

describe("classChanges", () => {
  const v1: ClassMigration = { tag: "v1", new_sqlite_classes: ["ConversationAgent"] };
  const before = { migrations: [v1], text: "{}" };

  it("treats a new class as a barrier Cloudflare enforces", () => {
    const after = {
      migrations: [v1, { tag: "v2", new_sqlite_classes: ["AgentHost", "Registry"] }],
      text: "{}",
    };
    expect(classChanges("app", "f", before, after)).toEqual({
      problems: [],
      findings: [
        {
          app: "app",
          file: "f",
          kind: "class-change",
          detail: 'class migration "v2" adds AgentHost, Registry',
          acknowledged: true,
        },
      ],
    });
  });

  it("needs a new marker for a class it deletes", () => {
    const after = {
      migrations: [v1, { tag: "v2", deleted_classes: ["ConversationAgent"] }],
      text: "{}",
    };
    const marked = { ...after, text: "// rollback-barrier: retired in #50\n{}" };
    expect(classChanges("app", "f", before, after).findings[0]).toMatchObject({
      kind: "destructive-class",
      acknowledged: false,
    });
    expect(classChanges("app", "f", before, marked).findings[0]?.acknowledged).toBe(true);
    // An older marker doesn't cover a new change.
    expect(
      classChanges("app", "f", { ...before, text: marked.text }, marked).findings[0]?.acknowledged,
    ).toBe(false);
  });

  it("refuses an applied migration changed or removed", () => {
    const changed = { migrations: [{ tag: "v1", new_sqlite_classes: ["Other"] }], text: "{}" };
    expect(classChanges("app", "f", before, changed).problems).toHaveLength(1);
    expect(classChanges("app", "f", before, { migrations: [], text: "{}" }).problems).toHaveLength(
      1,
    );
  });
});

describe("journalProblems", () => {
  const journal = {
    entries: [
      { idx: 0, when: 100, tag: "0000_init" },
      { idx: 1, when: 200, tag: "0001_more" },
    ],
  };
  const js = 'import m0000 from "./0000_init.sql";\nimport m0001 from "./0001_more.sql";';

  it("passes a consistent folder", () => {
    expect(journalProblems("d", journal, ["0000_init.sql", "0001_more.sql"], js)).toEqual([]);
  });

  it("finds an entry dated before the one it follows", () => {
    const late = {
      entries: [journal.entries[0], { idx: 1, when: 50, tag: "0001_more" }],
    } as typeof journal;
    expect(journalProblems("d", late, ["0000_init.sql", "0001_more.sql"], js)).toEqual([
      expect.stringContaining('"0001_more" is dated before "0000_init"'),
    ]);
  });

  it("finds missing files, imports and orphans", () => {
    const problems = journalProblems(
      "d",
      journal,
      ["0000_init.sql", "0002_orphan.sql"],
      'import m0000 from "./0000_init.sql";',
    );
    expect(problems).toEqual([
      'd: "0001_more" has no 0001_more.sql',
      "d: migrations.js doesn't import 0001_more.sql",
      "d: 0002_orphan.sql isn't in the journal",
    ]);
  });
});
