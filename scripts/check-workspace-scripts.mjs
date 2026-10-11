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
  return REQUIRED.filter((name) => !scripts[name]).map(
    (name) => `${dir}: missing "${name}" script`,
  );
});

if (missing.length > 0) {
  console.error(missing.join("\n"));
  process.exit(1);
}
console.log(`${workspaces.length} workspace(s) define ${REQUIRED.join(" and ")}.`);
