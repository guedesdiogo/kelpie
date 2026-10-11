/**
 * A deploy's tag: `<build>-<short commit>`, where the build is main's first-parent commit count
 * (docs/admin-api.md, "Versions"). `@kelpie/config`'s `versionReport` reads the same format.
 */
export interface BuildTag {
  build: number;
  commit: string;
}

const BUILD_TAG = /^(\d+)-([0-9a-f]{7,40})$/;
const COMMIT = /^[0-9a-f]{7,40}$/;

export function parseTag(tag: string | undefined): BuildTag | null {
  const match = BUILD_TAG.exec(tag ?? "");
  return match ? { build: Number(match[1]), commit: match[2] as string } : null;
}

export function formatTag(tag: BuildTag): string {
  return `${tag.build}-${tag.commit}`;
}

/** Two commit ids name the same commit when one is a prefix of the other. */
export function sameCommit(a: string, b: string): boolean {
  return a.startsWith(b) || b.startsWith(a);
}

export function sameTag(a: BuildTag | null, b: BuildTag | null): boolean {
  return a !== null && b !== null && a.build === b.build && sameCommit(a.commit, b.commit);
}

/** What a rollback goes back to: the build before the live one, a build, a tag or a commit. */
export type Target =
  | { kind: "previous" }
  | { kind: "build"; build: number }
  | { kind: "tag"; tag: BuildTag }
  | { kind: "commit"; commit: string };

export function parseTarget(input: string): Target | null {
  const value = input.trim().toLowerCase();
  if (value === "previous") return { kind: "previous" };
  if (/^\d+$/.test(value)) return { kind: "build", build: Number(value) };
  const tag = parseTag(value);
  if (tag) return { kind: "tag", tag };
  if (COMMIT.test(value)) return { kind: "commit", commit: value };
  return null;
}

/** A deployable version of a Worker that carries a build tag. */
export interface TaggedVersion {
  id: string;
  /** Cloudflare's version number: it grows with every upload. */
  number: number;
  tag: BuildTag;
}

/**
 * The tag a target names among a Worker's deployable versions. `previous` comes from the
 * deployment history instead (`previousTag`).
 */
export function pickTag(
  versions: readonly TaggedVersion[],
  target: Exclude<Target, { kind: "previous" }>,
): BuildTag | null {
  let candidates: TaggedVersion[];
  switch (target.kind) {
    case "build":
      candidates = versions.filter((version) => version.tag.build === target.build);
      break;
    case "tag":
      candidates = versions.filter((version) => sameTag(version.tag, target.tag));
      break;
    case "commit":
      candidates = versions.filter((version) => sameCommit(version.tag.commit, target.commit));
      break;
  }
  const best = candidates.reduce<TaggedVersion | null>(
    (found, version) =>
      found === null ||
      version.tag.build > found.tag.build ||
      (version.tag.build === found.tag.build && version.number > found.number)
        ? version
        : found,
    null,
  );
  return best?.tag ?? null;
}

/**
 * The build production served before the live one, from a Worker's deployments, newest first. The
 * history decides, not the build numbers: a build rolled back as unhealthy never came before.
 */
export function previousTag(
  deployments: ReadonlyArray<{
    versions: ReadonlyArray<{ version_id: string; percentage: number }>;
  }>,
  versions: readonly TaggedVersion[],
  live: BuildTag | null,
): BuildTag | null {
  for (const deployment of deployments.slice(1)) {
    const main = deployment.versions.reduce<{ version_id: string; percentage: number } | null>(
      (best, traffic) => (best === null || traffic.percentage > best.percentage ? traffic : best),
      null,
    );
    const tag = versions.find((version) => version.id === main?.version_id)?.tag ?? null;
    if (tag && !sameTag(tag, live)) return tag;
  }
  return null;
}

/** The newest deployable version with exactly this tag. */
export function versionWithTag(
  versions: readonly TaggedVersion[],
  tag: BuildTag,
): TaggedVersion | null {
  return versions
    .filter((version) => sameTag(version.tag, tag))
    .reduce<TaggedVersion | null>(
      (found, version) => (found === null || version.number > found.number ? version : found),
      null,
    );
}
