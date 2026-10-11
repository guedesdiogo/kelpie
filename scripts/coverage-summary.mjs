// Tabulates each workspace's coverage, as `bun run test:coverage` left it in
// `<workspace>/coverage/coverage-summary.json`, for CI's step summary (docs/testing.md).
// The thresholds themselves are enforced by Vitest, per workspace.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const METRICS = ["statements", "branches", "functions", "lines"];
const root = JSON.parse(readFileSync("package.json", "utf8"));

const workspaces = root.workspaces.flatMap((pattern) => {
  const base = pattern.replace(/\/\*$/, "");
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(base, entry.name, "package.json")))
    .map((entry) => join(base, entry.name));
});

const rows = workspaces.map((dir) => {
  const file = join(dir, "coverage", "coverage-summary.json");
  if (!existsSync(file)) return `| ${dir} | ${METRICS.map(() => "no report").join(" | ")} |`;
  const { total } = JSON.parse(readFileSync(file, "utf8"));
  return `| ${dir} | ${METRICS.map((metric) => `${total[metric].pct}%`).join(" | ")} |`;
});

console.log(
  [
    "## Test coverage",
    "",
    "| Workspace | Statements | Branches | Functions | Lines |",
    "|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n"),
);
