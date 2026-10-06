/**
 * Kelpie's version (#148). The minor number is the delivery phase, and the version changes by
 * decision, with a phase or a notable release, not with each PR. A deploy is told apart by its
 * commit, which deploys pass as `--tag`, and by its Worker version and time.
 */
export const KELPIE_VERSION = "0.2.0";

/** What Cloudflare's `version_metadata` binding tells a Worker about its own version. */
export interface WorkerVersionMetadata {
  id: string;
  tag: string;
  timestamp: string;
}

export interface VersionReport {
  version: string;
  /** The commit the deploy was tagged with, or null for a deploy without a tag. */
  commit: string | null;
  /** The Worker's Cloudflare version id. */
  deployment: string | null;
  deployedAt: string | null;
}

export function versionReport(metadata: WorkerVersionMetadata | undefined): VersionReport {
  return {
    version: KELPIE_VERSION,
    commit: metadata?.tag || null,
    deployment: metadata?.id || null,
    deployedAt: metadata?.timestamp || null,
  };
}
