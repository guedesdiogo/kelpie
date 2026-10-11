// `bun run --filter '*' <script>` silently skips workspaces that lack the script
// (ADR-0010), so CI fails here instead when a workspace forgets one. `test:coverage` is the
// run CI makes, with each workspace's coverage thresholds (docs/testing.md).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REQUIRED = ["typecheck", "test", "test:coverage"];
const root = JSON.parse(readFileSync("package.json", "utf8"));

const workspaces = root.workspaces.flatMap((pattern) => {
  const base = pattern.replace(/\/\*$/, "");
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(base, entry.name, "package.json")))
    .map((entry) => join(base, entry.name));
});

const missing = workspaces.flatMap((dir) => {
  const { scripts = {} } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const problems = REQUIRED.filter((name) => !scripts[name]).map(
    (name) => `${dir}: missing "${name}" script`,
  );
  // A coverage run without thresholds would gate nothing.
  const config = join(dir, "vitest.config.ts");
  if (scripts["test:coverage"] && !scripts["test:coverage"].includes("--coverage")) {
    problems.push(`${dir}: "test:coverage" doesn't pass --coverage`);
  }
  if (!existsSync(config) || !readFileSync(config, "utf8").includes("thresholds:")) {
    problems.push(`${dir}: vitest.config.ts sets no coverage thresholds`);
  }
  return problems;
});

if (missing.length > 0) {
  console.error(missing.join("\n"));
  process.exit(1);
}
console.log(
  `${workspaces.length} workspace(s) define ${REQUIRED.join(", ")}, and coverage thresholds.`,
);
