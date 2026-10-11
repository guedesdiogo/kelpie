import { changedFiles, type Git, listFiles, show } from "./git.ts";
import { parseJsonc } from "./jsonc.ts";
import {
  classChanges,
  classMigrations,
  type Finding,
  type Journal,
  journalProblems,
  sqlAcknowledged,
  unsafeStatements,
} from "./migrations.ts";

const SQL_MIGRATION = /^apps\/([^/]+)\/src\/(?:.+\/)?migrations\/[^/]+\.sql$/;
const WRANGLER_CONFIG = /^apps\/([^/]+)\/wrangler\.jsonc$/;
const JOURNAL = /^(apps\/([^/]+)\/src\/(?:.+\/)?migrations)\/meta\/_journal\.json$/;

export interface MigrationReport {
  /** Changes that must not merge, whatever their comments say. */
  problems: string[];
  /** Rollback barriers, each acknowledged or not. */
  findings: Finding[];
}

/**
 * The migration changes from `from` to `to`, limited to the Workers in `apps` when given. Both
 * the CI gate (base to head) and deploys and rollbacks (one live commit to another) read it.
 */
export function migrationChanges(
  git: Git,
  from: string,
  to: string,
  apps?: readonly string[],
): MigrationReport {
  const inScope = (app: string) => apps === undefined || apps.includes(app);
  const problems: string[] = [];
  const findings: Finding[] = [];

  for (const { status, path } of changedFiles(git, from, to)) {
    const sql = SQL_MIGRATION.exec(path);
    if (sql) {
      const app = sql[1] as string;
      if (!inScope(app)) continue;
      if (status !== "A") {
        problems.push(
          `${path}: an applied migration was ${status === "D" ? "removed" : "edited"}. Migrations are append-only; add a new one instead.`,
        );
        continue;
      }
      const text = show(git, to, path) ?? "";
      const reasons = unsafeStatements(text);
      if (reasons.length > 0) {
        findings.push({
          app,
          file: path,
          kind: "destructive-sql",
          detail: reasons.join(", "),
          acknowledged: sqlAcknowledged(text),
        });
      }
      continue;
    }

    const config = WRANGLER_CONFIG.exec(path);
    if (config && status !== "D") {
      const app = config[1] as string;
      if (!inScope(app)) continue;
      const before = show(git, from, path) ?? "{}";
      const after = show(git, to, path) ?? "{}";
      const result = classChanges(
        app,
        path,
        { migrations: classMigrations(parseJsonc(before)), text: before },
        { migrations: classMigrations(parseJsonc(after)), text: after },
      );
      problems.push(...result.problems);
      findings.push(...result.findings);
    }
  }

  const files = listFiles(git, to);
  for (const path of files) {
    const journal = JOURNAL.exec(path);
    if (!journal || !inScope(journal[2] as string)) continue;
    const dir = journal[1] as string;
    const sqlFiles = files
      .filter((file) => file.startsWith(`${dir}/`) && file.endsWith(".sql"))
      .map((file) => file.slice(dir.length + 1))
      .filter((file) => !file.includes("/"));
    problems.push(
      ...journalProblems(
        dir,
        JSON.parse(show(git, to, path) ?? '{"entries":[]}') as Journal,
        sqlFiles,
        show(git, to, `${dir}/migrations.js`),
      ),
    );
  }

  return { problems, findings };
}
