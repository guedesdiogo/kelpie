import { type Git, tagCommit } from "./git.ts";
import type { ClosedIssue, GitHub, MergedPull } from "./github.ts";

// Production ships from a published release (ADR-0066). A release that brings an issue labeled
// `critico` deploys only once the mentor accepted it, or once someone in PRUMO_DONOS forces it.
// The marks below are the prumo format other tools read, so they stay in Portuguese. Every
// question to GitHub that fails stops the gate: a failure never reads as "no critico".

export const CRITICAL_LABEL = "critico";
/** The mentor's acceptance comment starts with this: «**Aceite** · <environment> · <link>». */
export const ACCEPTANCE = "**Aceite** ·";
export const DEFAULT_MENTOR = "guedesdiogo";

/** A release's tag: `vX.Y.Z`, with no prerelease or build suffix. */
const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

export function parseRelease(tag: string): [number, number, number] | null {
  const match = RELEASE_TAG.exec(tag);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * The newest release tag on `ref`'s first-parent history, `ref` included; null before the first.
 * Prereleases (`v1.2.0-rc.1`) never deploy, so they never start a range.
 */
export function previousRelease(git: Git, ref: string): string | null {
  try {
    const tag = git([
      "describe",
      "--tags",
      "--abbrev=0",
      "--first-parent",
      "--match",
      "v[0-9]*.[0-9]*.[0-9]*",
      "--exclude",
      "*-*",
      "--exclude",
      "*+*",
      ref,
    ]).trim();
    return tag || null;
  } catch {
    // No tag behind ref, or ref has no parent: the first release.
    return null;
  }
}

/** The Deploy workflow. Its runs are named `Production vX.Y.Z` (deploy.yml's `run-name`). */
export const DEPLOY_WORKFLOW = "deploy.yml";
const PRODUCTION_RUN = /^Production (v\d+\.\d+\.\d+)$/;

/**
 * Where a release's critical gate starts. `deployed`: the release of the latest successful Deploy
 * run, whose gate passed or was forced. Without one, `history`: the gate reads everything, so a
 * release the gate stopped before anything shipped is read again by the next one.
 */
export type GateBase = { from: "deployed"; tag: string } | { from: "history"; tag: null };

/**
 * The gate's base for `commit`. A run counts only from `main` or from its own tag: a run from
 * another branch runs that branch's workflow, which proves nothing. When the latest run's tag
 * isn't in the checkout, nothing says what shipped, so the gate reads everything. A deployed
 * release newer than `commit`, as when an older one is deployed again, leaves it nothing to read.
 */
export async function gateBase(deps: { git: Git; github: GitHub }): Promise<GateBase> {
  for (const run of await deps.github.successfulRuns(DEPLOY_WORKFLOW)) {
    const tag = PRODUCTION_RUN.exec(run.title)?.[1];
    if (!tag || (run.branch !== "main" && run.branch !== tag)) continue;
    if (tagCommit(deps.git, tag)) return { from: "deployed", tag };
    break;
  }
  return { from: "history", tag: null };
}

export type Acceptance = { by: "pull"; pull: number } | { by: "comment"; url: string };

export interface CriticalIssue {
  issue: ClosedIssue;
  /** The pull requests in the release that close it. */
  pulls: number[];
  acceptance: Acceptance | null;
}

/** What a release brings: main's first-parent commits after `base`, up to its own. */
export interface ReleaseContents {
  commit: string;
  base: string | null;
  commits: number;
  pulls: MergedPull[];
  issues: ClosedIssue[];
  critical: CriticalIssue[];
  mentor: string;
}

const sameLogin = (login: string | null, other: string) =>
  login !== null && login.toLowerCase() === other.toLowerCase();
const issueKey = (issue: Pick<ClosedIssue, "repo" | "number">) =>
  `${issue.repo.toLowerCase()}#${issue.number}`;

/**
 * Reads what a release brings from git and from GitHub's record of merged pull requests, never
 * from the release's own text, which anyone who can edit it could change. A `critico` issue is
 * accepted when the mentor opened a pull request in the release that closes it, or commented
 * «**Aceite** · …» on it.
 */
export async function releaseContents(
  deps: { git: Git; github: GitHub },
  range: { commit: string; base: string | null },
  mentor: string,
): Promise<ReleaseContents> {
  const commits = deps
    .git([
      "rev-list",
      "--first-parent",
      range.base ? `${range.base}..${range.commit}` : range.commit,
    ])
    .split("\n")
    .filter(Boolean);
  const pulls = await deps.github.mergedPulls(commits);
  const issues = new Map<string, ClosedIssue>();
  const closers = new Map<string, MergedPull[]>();
  for (const pull of pulls) {
    for (const issue of pull.closes) {
      const key = issueKey(issue);
      if (!issues.has(key)) issues.set(key, issue);
      closers.set(key, [...(closers.get(key) ?? []), pull]);
    }
  }
  const sorted = [...issues.values()].sort(
    (a, b) => a.repo.localeCompare(b.repo) || a.number - b.number,
  );
  const critical: CriticalIssue[] = [];
  for (const issue of sorted) {
    if (!issue.labels.includes(CRITICAL_LABEL)) continue;
    const by = closers.get(issueKey(issue)) ?? [];
    const mentorPull = by.find((pull) => sameLogin(pull.author, mentor));
    let acceptance: Acceptance | null = mentorPull ? { by: "pull", pull: mentorPull.number } : null;
    if (!acceptance) {
      const comment = (await deps.github.comments(issue.repo, issue.number))
        .filter(
          (comment) => sameLogin(comment.author, mentor) && comment.body.startsWith(ACCEPTANCE),
        )
        .at(-1);
      if (comment) acceptance = { by: "comment", url: comment.url };
    }
    critical.push({ issue, pulls: by.map((pull) => pull.number), acceptance });
  }
  return {
    commit: range.commit,
    base: range.base,
    commits: commits.length,
    pulls,
    issues: sorted,
    critical,
    mentor,
  };
}

export function unaccepted(contents: Pick<ReleaseContents, "critical">): CriticalIssue[] {
  return contents.critical.filter((critical) => critical.acceptance === null);
}

const reference = (issue: ClosedIssue) => `${issue.repo}#${issue.number}`;
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** How a `critico` issue stands, for the gate's summary and the release notes. */
export function acceptanceLine({ issue, acceptance }: CriticalIssue): string {
  const state = !acceptance
    ? "missing, so the production deploy stops"
    : acceptance.by === "pull"
      ? `pull request #${acceptance.pull}, opened by the mentor`
      : `[«Aceite»](${acceptance.url})`;
  return `- [${reference(issue)}](${issue.url}) ${issue.title}: ${state}`;
}

/** Which commits the gate read, and why from there. */
export function gateRange(base: GateBase, tag: string): string {
  switch (base.from) {
    case "deployed":
      return `From ${base.tag}, the last release a Deploy run shipped, to ${tag}`;
    case "history":
      return `Everything up to ${tag}: no release a Deploy run shipped is here to start from`;
  }
}

/** The critical gate's step summary. */
export function gateReport(tag: string, contents: ReleaseContents, base: GateBase): string {
  const missing = unaccepted(contents);
  return [
    `### Critical gate · ${tag}`,
    "",
    `${gateRange(base, tag)}.`,
    "",
    `${plural(contents.commits, "commit", "commits")}, ${plural(contents.pulls.length, "pull request", "pull requests")}, ${plural(contents.issues.length, "issue", "issues")} closed, ${contents.critical.length} \`${CRITICAL_LABEL}\`.`,
    "",
    ...(contents.critical.length > 0
      ? [
          `Acceptance by the mentor (${contents.mentor}):`,
          ...contents.critical.map(acceptanceLine),
          "",
        ]
      : []),
    missing.length === 0
      ? `No \`${CRITICAL_LABEL}\` issue lacks the mentor's acceptance.`
      : `${plural(missing.length, `\`${CRITICAL_LABEL}\` issue lacks`, `\`${CRITICAL_LABEL}\` issues lack`)} the mentor's acceptance, so this release doesn't deploy. The mentor accepts an issue with a comment «**Aceite** · produção · <link>»; then re-run this run. Someone in \`PRUMO_DONOS\` can force it instead: Run workflow on Deploy, with \`force\` and a \`reason\` (docs/deploy.md).`,
    "",
  ].join("\n");
}

export interface ForceRecord {
  retro: string;
  comments: string[];
}

/**
 * Records a forced release: a retroactive review assigned to the mentor, and a comment on each
 * `critico` issue that lacks the mentor's acceptance, pointing to it. Null when none lacks it.
 */
export async function forceRelease(
  github: GitHub,
  tag: string,
  missing: readonly CriticalIssue[],
  options: { actor: string; reason: string; runUrl: string; mentor: string },
): Promise<ForceRecord | null> {
  // One line each: the marks are read line by line.
  const reason = options.reason.replace(/\s+/g, " ").trim();
  if (!reason) throw new Error("Forcing a release needs a reason.");
  if (missing.length === 0) return null;
  const retro = await github.openIssue({
    title: `Revisão retroativa · ${tag} · aceite forçado`,
    body: [
      `${options.actor} forced ${tag} to production without the mentor's «**Aceite**» on the issues below.`,
      "",
      `Dono: ${options.actor}`,
      `Motivo: ${reason}`,
      `Run: ${options.runUrl}`,
      "",
      "Issues:",
      ...missing.map(({ issue }) => `- ${reference(issue)} ${issue.title}`),
      "",
      "Review each one in production, then comment «**Aceite** · produção · <link>» on it, or open the fix.",
    ].join("\n"),
    assignees: [options.mentor],
    labels: [CRITICAL_LABEL],
  });
  const comments: string[] = [];
  for (const { issue } of missing) {
    comments.push(
      await github.comment(
        issue.repo,
        issue.number,
        [
          `**Aceite forçado** · produção · ${tag} · ${options.runUrl}`,
          "",
          `Dono: ${options.actor}`,
          `Motivo: ${reason}`,
          `Revisão retroativa: ${retro}`,
        ].join("\n"),
      ),
    );
  }
  return { retro, comments };
}

export function forceReport(tag: string, record: ForceRecord | null): string {
  return record
    ? [
        `### ${tag} forced past the critical gate`,
        "",
        `- Retroactive review: ${record.retro}`,
        ...record.comments.map((url) => `- Recorded on ${url}`),
        "",
      ].join("\n")
    : `Nothing to force: every \`${CRITICAL_LABEL}\` issue in ${tag} has the mentor's acceptance.\n`;
}
