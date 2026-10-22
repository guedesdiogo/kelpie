import {
  acceptanceLine,
  CRITICAL_LABEL,
  type GateBase,
  gateBase,
  gateRange,
  isCritical,
  parseRelease,
  previousRelease,
  type ReleaseContents,
  releaseContents,
  unaccepted,
} from "./critical.ts";
import { type Git, tagCommit } from "./git.ts";
import type { GitHub, Release } from "./github.ts";

/** The check a release's commit needs green: the one `main`'s ruleset requires. */
export const CI_CHECK = "CI passed";

/** The tag after `previous`: a bump of it, or a version named outright, which must come after it. */
export function nextTag(previous: string | null, version: string): string {
  const before = previous ? parseRelease(previous) : null;
  const named = parseRelease(version);
  if (named) {
    const [x, y, z] = named;
    const comesAfter =
      !before ||
      x > before[0] ||
      (x === before[0] && (y > before[1] || (y === before[1] && z > before[2])));
    if (!comesAfter) throw new Error(`${version} doesn't come after ${previous}.`);
    return version;
  }
  if (version !== "patch" && version !== "minor" && version !== "major") {
    throw new Error(`"${version}" isn't a version: use patch, minor, major or vX.Y.Z.`);
  }
  if (!before) throw new Error("There's no release yet: name the first version, such as v0.2.0.");
  const [major, minor, patch] = before;
  return version === "major"
    ? `v${major + 1}.0.0`
    : version === "minor"
      ? `v${major}.${minor + 1}.0`
      : `v${major}.${minor}.${patch + 1}`;
}

/** What the critical gate reads for a release, and from where. */
export interface GateView {
  base: GateBase;
  contents: ReleaseContents;
}

/**
 * A release's notes: the pull requests since the previous release and the issues they close, from
 * GitHub's record, and how each `critico` issue the critical gate reads stands. The gate reads
 * from the last release deployed, so it can hold more than the notes. The deploy never reads the
 * notes back.
 */
export function releaseNotes(tag: string, contents: ReleaseContents, gate: GateView): string {
  const since = contents.base ? `since ${contents.base}` : "the first release";
  return [
    `Commit \`${contents.commit.slice(0, 7)}\` · ${since}`,
    "",
    "## Pull requests",
    "",
    ...(contents.pulls.length > 0
      ? contents.pulls.map((pull) => `- #${pull.number} ${pull.title}`)
      : ["None."]),
    "",
    "## Issues",
    "",
    ...(contents.issues.length > 0
      ? contents.issues.map(
          (issue) =>
            `- [${issue.repo}#${issue.number}](${issue.url}) ${issue.title}${isCritical(issue) ? ` · \`${CRITICAL_LABEL}\`` : ""}`,
        )
      : ["None."]),
    ...(gate.contents.critical.length > 0
      ? [
          "",
          `## Mentor's acceptance (${gate.contents.mentor})`,
          "",
          `The critical gate reads ${gateRange(gate.base, tag).replace(/^\w/, (first) => first.toLowerCase())}.`,
          "",
          ...gate.contents.critical.map(acceptanceLine),
        ]
      : []),
    "",
  ].join("\n");
}

export type CutMode = "preview" | "draft" | "publish";

export interface Cut {
  tag: string;
  commit: string;
  /** How `CI passed` ended on the commit, or null when it never ran there. */
  ci: string | null;
  /** What it brings since the previous release, for the notes. */
  contents: ReleaseContents;
  gate: GateView;
  notes: string;
  /** The draft or published release; none for a preview. */
  release?: Release;
}

/**
 * Prepares the next release of a commit on main's first-parent history, `main`'s tip by default.
 * A preview changes nothing. A draft creates or updates the release as a draft, which deploys
 * nothing. Publishing it deploys production, so it runs only on the owner's order, and never
 * while a `critico` issue lacks the mentor's acceptance.
 */
export async function cutRelease(
  deps: { git: Git; github: GitHub },
  options: {
    version: string;
    target?: string | undefined;
    main: string;
    mode: CutMode;
    mentor: string;
  },
): Promise<Cut> {
  const ref = options.target ?? options.main;
  if (ref.startsWith("-")) throw new Error("--target takes a commit.");
  let commit: string;
  try {
    commit = deps.git(["rev-parse", "--verify", `${ref}^{commit}`]).trim();
  } catch {
    throw new Error(`${ref} isn't a commit here. Fetch it first.`);
  }
  const short = commit.slice(0, 7);
  if (!deps.git(["rev-list", "--first-parent", options.main]).split("\n").includes(commit)) {
    throw new Error(`${short} isn't on ${options.main}'s first-parent history.`);
  }
  const previous = previousRelease(deps.git, commit);
  if (previous && tagCommit(deps.git, previous) === commit) {
    throw new Error(`${short} is ${previous} already.`);
  }
  const tag = nextTag(previous, options.version);
  if (tagCommit(deps.git, tag)) throw new Error(`The tag ${tag} exists already.`);

  const ci = await deps.github.checkState(commit, CI_CHECK);
  const contents = await releaseContents(deps, { commit, base: previous }, options.mentor);
  const base = await gateBase(deps);
  const gate = {
    base,
    contents:
      base.tag === previous
        ? contents
        : await releaseContents(deps, { commit, base: base.tag }, options.mentor),
  };
  const notes = releaseNotes(tag, contents, gate);
  const cut: Cut = { tag, commit, ci, contents, gate, notes };
  if (options.mode === "preview") return cut;

  if (ci !== "success") {
    throw new Error(
      `\`${CI_CHECK}\` isn't green on ${short} (${ci ?? "never ran"}): wait for it, or pick another --target.`,
    );
  }
  const missing = unaccepted(gate.contents);
  if (options.mode === "publish" && missing.length > 0) {
    throw new Error(
      `${missing.map(({ issue }) => `${issue.repo}#${issue.number}`).join(", ")} ${missing.length === 1 ? "lacks" : "lack"} the mentor's acceptance, so the deploy would stop. Keep it a draft; the owner can force it from the Deploy workflow, with a reason.`,
    );
  }
  const existing = (await deps.github.releases()).find((release) => release.tag === tag);
  if (existing && !existing.draft) throw new Error(`${tag} is published already.`);
  if (existing && options.mode === "publish" && existing.target !== commit) {
    throw new Error(
      `The draft ${tag} is for ${existing.target.slice(0, 7)}, not ${short}. Publish what it shows with --target ${existing.target}, or run --draft again to move it.`,
    );
  }
  const fields = { tag, target: commit, name: tag, body: notes, draft: options.mode === "draft" };
  return {
    ...cut,
    release: existing
      ? await deps.github.updateRelease(existing.id, fields)
      : await deps.github.createRelease(fields),
  };
}

/** What `release cut` prints. */
export function cutReport(cut: Cut, mode: CutMode): string {
  const outcome = {
    preview:
      "A preview: nothing was created. `--draft` creates the draft; `--publish` deploys production, only on the owner's order.",
    draft: `Draft saved: ${cut.release?.url}. It deploys nothing until it's published.`,
    publish: `Published: ${cut.release?.url}. The Deploy workflow deploys it now.`,
  }[mode];
  return [
    `# ${cut.tag}`,
    "",
    `\`${CI_CHECK}\` on ${cut.commit.slice(0, 7)}: ${cut.ci ?? "never ran"}`,
    "",
    cut.notes,
    outcome,
    "",
  ].join("\n");
}
