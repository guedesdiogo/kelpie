import { isDeepStrictEqual } from "node:util";

/**
 * A change production can't roll back past safely (ADR-0029):
 * - `class-change`: a Durable Object class migration. Cloudflare refuses any rollback across it.
 * - `destructive-class`: one that deletes, renames or transfers a class, which also loses data.
 * - `destructive-sql`: a SQL migration whose data the code from before it can't use, such as a
 *   dropped column. Cloudflare allows the rollback; the old code then fails.
 */
export type FindingKind = "class-change" | "destructive-class" | "destructive-sql";

export interface Finding {
  /** The Worker's directory under `apps/`. */
  app: string;
  file: string;
  kind: FindingKind;
  detail: string;
  /** The change carries a `rollback-barrier: <reason>` comment, so a reviewer accepted it. */
  acknowledged: boolean;
}

const SQL_MARKER = /^[ \t]*--[ \t]*rollback-barrier:[ \t]*\S/m;
const JSONC_MARKER = /\/\/[ \t]*rollback-barrier:[ \t]*\S/g;

const UNSAFE_STATEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^DROP\s+(TABLE|VIEW)\b/i, "drops a table"],
  [/^ALTER\s+TABLE\s+\S+\s+DROP\b/i, "drops a column"],
  [/^ALTER\s+TABLE\s+\S+\s+RENAME\b/i, "renames a table or column"],
  [/^UPDATE\b/i, "rewrites rows"],
  [/^DELETE\b/i, "deletes rows"],
];

/**
 * What a SQL migration does that the code from before it can't live with. Drizzle's migrator
 * applies only migrations newer than the last one applied, so code that was rolled back skips
 * newer ones instead of failing; their data stays. Added tables, columns with defaults and indexes
 * are safe. A table Drizzle rebuilds to change a column shows up as a dropped table.
 */
export function unsafeStatements(sql: string): string[] {
  const statements = sql
    .replaceAll("--> statement-breakpoint", "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((statement) => statement.replace(/\s+/g, " ").trim());
  const reasons = new Set<string>();
  for (const statement of statements) {
    for (const [pattern, reason] of UNSAFE_STATEMENTS) {
      if (pattern.test(statement)) reasons.add(reason);
    }
  }
  return [...reasons];
}

export function sqlAcknowledged(sql: string): boolean {
  return SQL_MARKER.test(sql);
}

function jsoncMarkers(text: string): number {
  return text.match(JSONC_MARKER)?.length ?? 0;
}

/** One entry of a Worker's `migrations` list in `wrangler.jsonc`. */
export interface ClassMigration {
  tag: string;
  new_classes?: string[];
  new_sqlite_classes?: string[];
  deleted_classes?: string[];
  renamed_classes?: Array<{ from: string; to: string }>;
  transferred_classes?: Array<{ from: string; from_script: string; to: string }>;
}

export function classMigrations(config: unknown): ClassMigration[] {
  const migrations = (config as { migrations?: unknown } | null)?.migrations;
  return Array.isArray(migrations) ? (migrations as ClassMigration[]) : [];
}

/**
 * Compares a Worker's class migrations before and after a change. Applied ones must stay as they
 * are: Cloudflare records the last tag and applies only the entries after it.
 */
export function classChanges(
  app: string,
  file: string,
  before: { migrations: ClassMigration[]; text: string },
  after: { migrations: ClassMigration[]; text: string },
): { problems: string[]; findings: Finding[] } {
  const changed = before.migrations.findIndex(
    (migration, index) => !isDeepStrictEqual(migration, after.migrations[index]),
  );
  if (changed !== -1) {
    const tag = before.migrations[changed]?.tag ?? `#${changed}`;
    return {
      problems: [
        `${file}: class migration "${tag}" was changed or removed. Applied migrations are append-only; add a new entry instead.`,
      ],
      findings: [],
    };
  }
  const acknowledged = jsoncMarkers(after.text) > jsoncMarkers(before.text);
  const findings = after.migrations.slice(before.migrations.length).map((migration): Finding => {
    const removes = [
      ...(migration.deleted_classes ?? []).map((name) => `deletes ${name}`),
      ...(migration.renamed_classes ?? []).map(({ from, to }) => `renames ${from} to ${to}`),
      ...(migration.transferred_classes ?? []).map(({ from }) => `transfers ${from}`),
    ];
    if (removes.length > 0) {
      return {
        app,
        file,
        kind: "destructive-class",
        detail: `class migration "${migration.tag}" ${removes.join(", ")}`,
        acknowledged,
      };
    }
    const added = [...(migration.new_classes ?? []), ...(migration.new_sqlite_classes ?? [])];
    return {
      app,
      file,
      kind: "class-change",
      detail: `class migration "${migration.tag}" adds ${added.join(", ") || "nothing"}`,
      acknowledged: true,
    };
  });
  return { problems: [], findings };
}

/** Drizzle's `meta/_journal.json`. */
export interface Journal {
  entries: Array<{ idx: number; when: number; tag: string }>;
}

/**
 * Checks one Drizzle migrations folder. The migrator applies an entry only when its `when` is
 * newer than the last one applied, so an entry merged out of order would never run on objects
 * that already applied a later one.
 */
export function journalProblems(
  dir: string,
  journal: Journal,
  sqlFiles: readonly string[],
  migrationsJs: string | null,
): string[] {
  const problems: string[] = [];
  journal.entries.forEach((entry, index) => {
    if (entry.idx !== index) {
      problems.push(`${dir}: journal entry "${entry.tag}" has idx ${entry.idx}, expected ${index}`);
    }
    const previous = journal.entries[index - 1];
    if (previous && entry.when <= previous.when) {
      problems.push(
        `${dir}: "${entry.tag}" is dated before "${previous.tag}", so objects that applied "${previous.tag}" would skip it. Generate it again on top of main.`,
      );
    }
    if (!sqlFiles.includes(`${entry.tag}.sql`)) {
      problems.push(`${dir}: "${entry.tag}" has no ${entry.tag}.sql`);
    }
    if (migrationsJs !== null && !migrationsJs.includes(`./${entry.tag}.sql`)) {
      problems.push(`${dir}: migrations.js doesn't import ${entry.tag}.sql`);
    }
  });
  const tags = new Set(journal.entries.map((entry) => `${entry.tag}.sql`));
  for (const file of sqlFiles) {
    if (!tags.has(file)) problems.push(`${dir}: ${file} isn't in the journal`);
  }
  return problems;
}
