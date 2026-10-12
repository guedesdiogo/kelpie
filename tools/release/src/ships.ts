/**
 * What a deploy ships (ADR-0031): the Workers, the packages they bundle, and the files that build
 * or deploy them. Anything else, such as the docs, the CI gates or their scripts, ships nothing, so
 * a deploy that finds only those changed since the live builds skips.
 */
const SHIPPING_FOLDERS = ["apps/", "packages/", "tools/release/", ".github/actions/"];
const SHIPPING_FILES = new Set([
  "package.json",
  "bun.lock",
  "bunfig.toml",
  "tsconfig.base.json",
  ".github/workflows/deploy.yml",
]);

/** Whether any of these changed paths ships. */
export function ships(paths: readonly string[]): boolean {
  return paths.some(
    (path) =>
      SHIPPING_FILES.has(path) || SHIPPING_FOLDERS.some((folder) => path.startsWith(folder)),
  );
}
