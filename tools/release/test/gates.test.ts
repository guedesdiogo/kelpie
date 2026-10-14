import { describe, expect, it } from "vitest";
import { type Gate, gatesOutput, gatesReport, planGates } from "../src/gates.ts";

const running = (paths: readonly string[]): Gate[] =>
  planGates(paths)
    .filter((plan) => plan.runs)
    .map((plan) => plan.gate);

describe("planGates", () => {
  it.each([
    ["docs", ["docs/deploy.md", "docs/adr/0038-pull-requests-run-affected-gates.md"]],
    ["the root Markdown files", ["README.md", "CLAUDE.md"]],
    ["the license", ["LICENSE"]],
  ])("skips every gate for %s", (_, paths) => {
    expect(running(paths)).toEqual([]);
  });

  it.each([
    ["a Worker's code", ["apps/ingress/src/index.ts"], ["checks", "build", "migrations"]],
    ["a Worker's README", ["apps/ingress/README.md"], ["checks", "build", "migrations"]],
    ["a package", ["packages/config/src/defaults.ts"], ["checks", "build", "migrations"]],
    ["the CI scripts", ["scripts/coverage-summary.mjs"], ["checks"]],
    ["Biome's configuration", ["biome.json"], ["checks"]],
    ["a path no rule names", [".editorconfig"], ["checks"]],
    [
      "the rollback workflow",
      [".github/workflows/rollback.yml"],
      ["workflows", "dependency-review"],
    ],
    [
      "the deploy workflow, which ships",
      [".github/workflows/deploy.yml"],
      ["build", "migrations", "workflows", "dependency-review"],
    ],
    ["Dependabot's configuration", [".github/dependabot.yml"], ["workflows", "dependency-review"]],
    [
      "a workspace's dependencies",
      ["apps/ingress/package.json"],
      ["checks", "build", "migrations", "dependency-review"],
    ],
    ["the lockfile", ["bun.lock"], ["checks", "build", "migrations", "dependency-review"]],
  ])("runs only the gates %s can affect", (_, paths, gates) => {
    expect(running(paths)).toEqual(gates);
  });

  it.each([
    ["the CI workflow", [".github/workflows/ci.yml"]],
    ["the setup action", [".github/actions/setup/action.yml"]],
  ])("runs every gate for %s", (_, paths) => {
    expect(running(paths)).toEqual([
      "checks",
      "build",
      "migrations",
      "workflows",
      "dependency-review",
    ]);
  });

  it("runs every gate for an empty change, which it can't judge", () => {
    expect(running([])).toEqual([
      "checks",
      "build",
      "migrations",
      "workflows",
      "dependency-review",
    ]);
  });

  it("runs a gate when any one path needs it", () => {
    expect(running(["docs/deploy.md", "scripts/check-workspace-scripts.mjs", "README.md"])).toEqual(
      ["checks"],
    );
  });

  it("doesn't take a name that only starts like a docs path for docs", () => {
    expect(running(["docs.ts", "documentation/x.ts", "LICENSE.txt"])).toEqual(["checks"]);
  });

  it("names the paths that make each gate run", () => {
    const [checks, build] = planGates(["docs/deploy.md", "apps/a/src/x.ts", "apps/b/src/y.ts"]);
    expect(checks).toEqual({
      gate: "checks",
      job: "Lint, typecheck and test",
      runs: true,
      because: ["apps/a/src/x.ts", "apps/b/src/y.ts"],
    });
    expect(build?.because).toEqual(["apps/a/src/x.ts", "apps/b/src/y.ts"]);
  });
});

describe("gatesOutput", () => {
  it("writes one output per gate, as ci.yml reads them", () => {
    expect(gatesOutput(planGates(["scripts/coverage-summary.mjs"]))).toBe(
      "checks=true\nbuild=false\nmigrations=false\nworkflows=false\ndependency-review=false\n",
    );
  });
});

describe("gatesReport", () => {
  it("lists each gate, whether it runs and the paths behind it", () => {
    const paths = ["apps/a/1.ts", "apps/a/2.ts", "apps/a/3.ts", "apps/a/4.ts", "docs/x.md"];
    const report = gatesReport(planGates(paths), paths.length);
    expect(report).toContain("5 changed paths");
    expect(report).toContain(
      "| `Lint, typecheck and test` | runs | `apps/a/1.ts`, `apps/a/2.ts`, `apps/a/3.ts` and 1 more |",
    );
    expect(report).toContain("| `Workflow lint` | skips | nothing it checks changed |");
  });

  it("counts one changed path as one", () => {
    expect(gatesReport(planGates(["biome.json"]), 1)).toContain("(1 changed path)");
  });

  it("says why an empty change runs everything", () => {
    expect(gatesReport(planGates([]), 0)).toContain(
      "| `Build Workers` | runs | no changed paths, so every gate runs |",
    );
  });
});
