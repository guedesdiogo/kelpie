/**
 * Kelpie's release (#148): the delivery phase, changed by decision with a phase or a notable
 * release. The version adds the deploy's build (#153): main's first-parent commit count at the
 * deployed commit, so every merged PR moves it by one and nobody edits a file to bump it.
 */
export const KELPIE_RELEASE = "0.2";

/** What Cloudflare's `version_metadata` binding tells a Worker about its own version. */
export interface WorkerVersionMetadata {
  id: string;
  tag: string;
  timestamp: string;
}

export interface VersionReport {
  /** `<release>.<build>`, or the release alone for a deploy whose tag carries no build. */
  version: string;
  build: number | null;
  /** The deployed commit, or null for a deploy without a tag. */
  commit: string | null;
  /** The Worker's Cloudflare version id. */
  deployment: string | null;
  deployedAt: string | null;
}

/** A deploy's tag: `<build>-<short commit>` (docs/admin-api.md, "Versions"). */
const BUILD_TAG = /^(\d+)-([0-9a-f]{7,40})$/;

export function versionReport(metadata: WorkerVersionMetadata | undefined): VersionReport {
  const tag = metadata?.tag ?? "";
  const tagged = BUILD_TAG.exec(tag);
  const build = tagged ? Number(tagged[1]) : null;
  return {
    version: build === null ? KELPIE_RELEASE : `${KELPIE_RELEASE}.${build}`,
    build,
    // Deploys before the build number were tagged with the commit alone.
    commit: tagged?.[2] ?? (tag || null),
    deployment: metadata?.id || null,
    deployedAt: metadata?.timestamp || null,
  };
}
