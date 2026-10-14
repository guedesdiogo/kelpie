import { ships } from "./ships.ts";

/**
 * Which CI gates a pull request runs (ADR-0038), by their job ids in ci.yml. A gate runs when the
 * change can affect what it checks, and skips otherwise; `CI passed` accepts only those skips.
 * Pushes to `main`, and changes to this rule or to ci.yml, run every gate without asking it.
 */
export const GATES = {
  checks: "Lint, typecheck and test",
  build: "Build Workers",
  migrations: "Migrations",
  workflows: "Workflow lint",
  "dependency-review": "Dependency review",
} as const;

export type Gate = keyof typeof GATES;

const CI_WORKFLOW = ".github/workflows/ci.yml";

/**
 * The docs: Biome skips Markdown, and no test, bundle or migration reads these. Biome does check
 * the JSON results under docs/, so only Markdown counts.
 */
const isDocs = (path: string) => /^(docs\/.+|[^/]+)\.md$/.test(path) || path === "LICENSE";

/** Dependabot's config and the workflows other than CI, which only GitHub reads. */
const isGitHubOnly = (path: string) =>
  path.startsWith(".github/") && !path.startsWith(".github/actions/") && path !== CI_WORKFLOW;

const isManifest = (path: string) =>
  path === "bun.lock" || path === "package.json" || path.endsWith("/package.json");

const needs: Record<Gate, (path: string) => boolean> = {
  // Unknown paths land here, so a new kind of file runs lint and tests until a rule names it.
  checks: (path) => !isDocs(path) && !isGitHubOnly(path),
  build: (path) => path === CI_WORKFLOW || ships([path]),
  migrations: (path) => path === CI_WORKFLOW || ships([path]),
  workflows: (path) => path.startsWith(".github/"),
  // Dependency review covers the npm packages and the Actions the workflows use.
  "dependency-review": (path) => isManifest(path) || path.startsWith(".github/"),
};

export interface GatePlan {
  gate: Gate;
  job: string;
  runs: boolean;
  /** The changed paths that make it run; none when the rule can't judge the change. */
  because: string[];
}

export function planGates(paths: readonly string[]): GatePlan[] {
  // Nothing to judge, or a path git quotes for its unusual characters ("caf\303\251.ts"), which
  // no rule can read: every gate runs.
  const judged = paths.length > 0 && !paths.some((path) => path.startsWith('"'));
  return (Object.keys(GATES) as Gate[]).map((gate) => {
    const because = judged ? paths.filter(needs[gate]) : [];
    return { gate, job: GATES[gate], runs: !judged || because.length > 0, because };
  });
}

/** `<gate>=true|false` lines for `$GITHUB_OUTPUT`. */
export function gatesOutput(plans: readonly GatePlan[]): string {
  return plans.map(({ gate, runs }) => `${gate}=${runs}\n`).join("");
}

const SHOWN = 3;

/** The step summary: each gate, whether it runs, and the first paths that make it run. */
export function gatesReport(plans: readonly GatePlan[], changed: number): string {
  const rows = plans.map(({ job, runs, because }) => {
    const why =
      because.length > 0
        ? because
            .slice(0, SHOWN)
            .map((path) => `\`${path}\``)
            .join(", ") + (because.length > SHOWN ? ` and ${because.length - SHOWN} more` : "")
        : runs
          ? "the rule can't judge this change, so every gate runs"
          : "nothing it checks changed";
    return `| \`${job}\` | ${runs ? "runs" : "skips"} | ${why} |`;
  });
  return [
    `### CI gates for this change (${changed} changed ${changed === 1 ? "path" : "paths"})`,
    "",
    "| Gate | | Because of |",
    "|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}
