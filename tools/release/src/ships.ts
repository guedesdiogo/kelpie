/**
 * What a push to main ships (ADR-0031): the Workers, the packages they bundle, and the files that
 * build or deploy them. Anything else, such as the docs, the CI gates or their scripts, ships
 * nothing, so a push that changes only those skips the deploy.
 */
const SHIPPING_FOLDERS = ["apps/", "packages/", "tools/release/", ".github/actions/"];
const SHIPPING_FILES = new Set([
  "package.json",
  "bun.lock",
  "bunfig.toml",
  "tsconfig.base.json",
  ".github/workflows/deploy.yml",
]);

function shipsPath(path: string): boolean {
  return SHIPPING_FILES.has(path) || SHIPPING_FOLDERS.some((folder) => path.startsWith(folder));
}

/** Whether a push that changed these paths ships anything, so it deploys. */
export function ships(paths: readonly string[]): boolean {
  return paths.some(shipsPath);
}

/**
 * The line CI appends to `$GITHUB_OUTPUT`, and a one-line summary for the run's log, for the paths
 * changed from `base` to HEAD.
 */
export function shipsVerdict(
  paths: readonly string[],
  base: string,
): { output: string; summary: string } {
  const shipping = paths.filter(shipsPath).length;
  return {
    output: `deploy=${shipping > 0}`,
    summary: `Changed paths from ${base} to HEAD: ${paths.length}, of which ${shipping} ship. ${shipping > 0 ? "Deploying." : "Skipping the deploy."}`,
  };
}
