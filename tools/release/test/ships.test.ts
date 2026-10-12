import { describe, expect, it } from "vitest";
import { ships, shipsVerdict } from "../src/ships.ts";

describe("ships", () => {
  it.each([
    "apps/ingress/src/index.ts",
    "apps/context-store/wrangler.jsonc",
    "packages/config/src/defaults.ts",
    "tools/release/src/deploy.ts",
    "package.json",
    "bun.lock",
    "bunfig.toml",
    "tsconfig.base.json",
    ".github/workflows/deploy.yml",
    ".github/actions/setup/action.yml",
  ])("ships a change to %s", (path) => {
    expect(ships([path])).toBe(true);
  });

  it.each([
    ["docs only", ["docs/deploy.md", "docs/adr/0031-deploy-only-what-ships.md"]],
    ["a README", ["README.md"]],
    ["the CI workflow alone", [".github/workflows/ci.yml"]],
    [
      "the rollback workflow and the CI scripts",
      [".github/workflows/rollback.yml", "scripts/coverage-summary.mjs"],
    ],
    ["a package.json other than the root one", ["docs/package.json"]],
    ["a name that only starts like a shipping folder", ["apps.md", "tools/releases/notes.md"]],
  ])("ships nothing for %s", (_, paths) => {
    expect(ships(paths)).toBe(false);
  });

  it("ships nothing for an empty change", () => {
    expect(ships([])).toBe(false);
  });

  it("ships when any one path ships", () => {
    expect(ships(["docs/deploy.md", "apps/ingress/src/index.ts", "README.md"])).toBe(true);
  });
});

describe("shipsVerdict", () => {
  it("deploys, and counts the paths that ship", () => {
    expect(
      shipsVerdict(["docs/deploy.md", "apps/ingress/src/index.ts", "bun.lock"], "HEAD^1"),
    ).toEqual({
      output: "deploy=true",
      summary: "Changed paths from HEAD^1 to HEAD: 3, of which 2 ship. Deploying.",
    });
  });

  it("skips the deploy when nothing ships", () => {
    expect(shipsVerdict(["docs/deploy.md"], "HEAD^1")).toEqual({
      output: "deploy=false",
      summary: "Changed paths from HEAD^1 to HEAD: 1, of which 0 ship. Skipping the deploy.",
    });
    expect(shipsVerdict([], "abc1234").output).toBe("deploy=false");
  });
});
