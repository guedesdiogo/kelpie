import type { VersionTraffic } from "./cloudflare.ts";
import type { ConfigAdditions } from "./config-additions.ts";
import {
  buildTagOf,
  changedFiles,
  type Git,
  hasCommit,
  isAncestor,
  isClean,
  show,
  subjectOf,
} from "./git.ts";
import { parseJsonc } from "./jsonc.ts";
import { type Barrier, barriersBetween, type LiveWorker, liveOrigin, readLive } from "./live.ts";
import { type Restored, restore } from "./rollback.ts";
import { withSecretsFile } from "./secrets-file.ts";
import { ships } from "./ships.ts";
import { type BuildTag, formatTag, sameTag } from "./tags.ts";
import {
  type ProbeResult,
  type SettleOptions,
  settle,
  type VerifyDeps,
  verdictOf,
  type WatchOptions,
  watch,
} from "./verify.ts";
import { CHANNEL_EGRESS, INGRESS, type WorkerSpec } from "./workers.ts";

export interface DeployDeps extends VerifyDeps {
  git: Git;
  /**
   * Runs `wrangler deploy` with these arguments for one Worker, on its committed config with
   * `additions` merged in when given; returns the version it made.
   */
  wranglerDeploy(spec: WorkerSpec, args: string[], additions?: ConfigAdditions): Promise<string>;
  /** Keeps a value out of CI logs. */
  mask(value: string): void;
}

/** The version id in wrangler's output file (`WRANGLER_OUTPUT_FILE_PATH`), one JSON object a line. */
export function deployedVersion(ndjson: string): string | undefined {
  return ndjson
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type?: string; version_id?: string })
    .find((entry) => entry.type === "deploy")?.version_id;
}

export interface DeployPlan {
  tag: BuildTag;
  message: string;
  live: LiveWorker[];
  /** What an automatic rollback of this release would cross; any of them prevents one. */
  barriers: Barrier[];
  origin: string;
  /** Why nothing deploys, when nothing that ships changed since the live builds. */
  skip?: string;
}

/**
 * Why HEAD needn't deploy (ADR-0031): every build production serves already contains it, or
 * differs from it in nothing that ships. A build that contains HEAD, as when an older run is
 * re-run, would only go back by deploying it. Undefined when it must deploy: a change that ships,
 * or a live version without a tag or with a commit this checkout lacks, since nothing can be
 * compared then.
 */
function nothingShips(git: Git, live: readonly LiveWorker[]): string | undefined {
  const builds: BuildTag[] = [];
  for (const { tag } of live) {
    if (!tag || !hasCommit(git, tag.commit)) return undefined;
    if (!builds.some((known) => sameTag(known, tag))) builds.push(tag);
  }
  const behind = builds.filter((build) => !isAncestor(git, "HEAD", build.commit));
  for (const build of behind) {
    if (ships(changedFiles(git, build.commit, "HEAD").map(({ path }) => path))) return undefined;
  }
  return behind.length === 0
    ? `Production serves ${builds.map(formatTag).join(", ")}, which already contains this commit.`
    : `Nothing that ships changed since ${behind.map(formatTag).join(", ")}, which production serves.`;
}

/**
 * The instance vars the owner set. A live value equal to the repository's default at the live
 * commit is no setting: carrying it would pin that default after the repository changes it.
 */
function ownerSet(git: Git, worker: LiveWorker): Record<string, string> {
  const ref = worker.tag && hasCommit(git, worker.tag.commit) ? worker.tag.commit : "HEAD";
  const config = parseJsonc(show(git, ref, `apps/${worker.spec.app}/wrangler.jsonc`) || "{}") as {
    vars?: Record<string, unknown>;
  };
  return Object.fromEntries(
    Object.entries(worker.vars).filter(([name, value]) => value !== config.vars?.[name]),
  );
}

/**
 * Reads production and plans the release of HEAD. Unless `always` is set, it plans to skip when
 * nothing that ships changed since the live builds.
 */
export async function planDeploy(
  deps: Pick<DeployDeps, "api" | "git" | "now">,
  options: { message?: string; always?: boolean } = {},
): Promise<DeployPlan> {
  if (!isClean(deps.git)) {
    throw new Error(
      "The working tree has changes. Deploy from a clean checkout of a commit on main.",
    );
  }
  const tag = buildTagOf(deps.git, "HEAD");
  const live = (await readLive(deps.api)).map((worker) => ({
    ...worker,
    vars: ownerSet(deps.git, worker),
  }));
  const skip = options.always ? undefined : nothingShips(deps.git, live);
  // Without analytics the watch would judge by the probes alone, so a token without them stops here.
  // A skipped release watches nothing.
  if (!skip) {
    const now = deps.now();
    try {
      await deps.api.invocations(
        live.map((worker) => worker.version.id),
        new Date(now.getTime() - 60 * 60_000),
        now,
      );
    } catch (error) {
      throw new Error(
        `The Cloudflare token can't read analytics, which the watch needs: give it Account Analytics Read (docs/deploy.md). ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {
    tag,
    message: (options.message ?? `${tag.commit} ${subjectOf(deps.git, "HEAD")}`).slice(0, 100),
    live,
    barriers: barriersBetween(
      deps.git,
      live.map((worker) => ({ spec: worker.spec, from: worker.tag, to: tag })),
    ),
    origin: liveOrigin(live),
    ...(skip ? { skip } : {}),
  };
}

export interface DeployReport {
  tag: BuildTag;
  outcome: "deployed" | "skipped" | "rolled-back" | "failed";
  reason?: string;
  workers: Array<{
    script: string;
    previous: VersionTraffic[];
    previousTag: BuildTag | null;
    deployed: string | null;
  }>;
  barriers: Barrier[];
  probes: ProbeResult[];
  errors: Record<string, number>;
  analytics: boolean;
  rollback: Restored[];
  /** What the owner should know that isn't a failure, such as a token the rollback restored. */
  warnings: string[];
}

export interface DeployOptions {
  settle: SettleOptions;
  watch: WatchOptions;
  /**
   * `DEPLOY_PROBE_TOKEN` (#234): the deep probe signs its requests with it. Ingress gets it as a
   * secret when the live ingress has none, or on a rotation. Without it, neither happens.
   */
  deepProbeToken?: string;
  /** Uploads the token even though ingress holds one: the Deploy workflow's rotate-probe-token. */
  rotateProbeToken?: boolean;
  /**
   * `RUNNER_VPC_SERVICE_ID` (#294): the VPC Service that reaches the owner's runner. `channel-egress`
   * gets it as its `RUNNER` binding; without it, it has none, and the runner is off.
   */
  runnerVpcService?: string;
}

/**
 * `DEPLOY_PROBE_TOKEN` from the environment, trimmed, or undefined when it's empty. Anything
 * shorter than 32 printable characters, or with spaces, is skipped with a warning: ingress would
 * refuse it, and the masks in the logs skip short values. A bad token never stops a deploy.
 */
export function deepProbeToken(
  value: string | undefined,
  warn: (message: string) => void,
): string | undefined {
  const token = value?.trim();
  if (!token) return undefined;
  if (!/^[\x21-\x7e]{32,}$/.test(token)) {
    warn(
      "DEPLOY_PROBE_TOKEN isn't at least 32 printable characters without spaces, as `openssl rand -hex 32` makes, so it isn't uploaded and the deep probe is skipped (docs/deploy.md).",
    );
    return undefined;
  }
  return token;
}

/**
 * `RUNNER_VPC_SERVICE_ID` from the environment, trimmed, or undefined when it's empty. Anything but
 * a VPC Service's id is skipped with a warning: the deploy goes on without the runner's binding.
 */
export function runnerVpcService(
  value: string | undefined,
  warn: (message: string) => void,
): string | undefined {
  const id = value?.trim();
  if (!id) return undefined;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    warn(
      "RUNNER_VPC_SERVICE_ID isn't a VPC Service id, so channel-egress deploys without the runner's binding (docs/runner.md).",
    );
    return undefined;
  }
  return id;
}

/** The secret only ingress gets, for its deploy probe. */
const DEEP_PROBE_SECRET = "DEPLOY_PROBE_TOKEN";

/** Whether a live Worker's version holds the probe's token, as Cloudflare lists its secrets. */
function holdsProbeToken(worker: LiveWorker | undefined): boolean {
  return (worker?.version.resources?.bindings ?? []).some(
    (binding) => binding.type === "secret_text" && binding.name === DEEP_PROBE_SECRET,
  );
}

/**
 * Deploys every Worker in order, checks production, and rolls the release back when the checks
 * fail. Each Worker carries its instance vars from the live version. `wrangler deploy` applies the
 * Durable Object class migrations; each object applies its SQL migrations when it first wakes on
 * the new code. A plan that skips deploys nothing.
 */
export async function deploy(
  deps: DeployDeps,
  plan: DeployPlan,
  options: DeployOptions,
): Promise<DeployReport> {
  const report: DeployReport = {
    tag: plan.tag,
    outcome: "deployed",
    workers: plan.live.map((worker) => ({
      script: worker.spec.script,
      previous: worker.traffic,
      previousTag: worker.tag,
      deployed: null,
    })),
    barriers: plan.barriers,
    probes: [],
    errors: {},
    analytics: true,
    rollback: [],
    warnings: [],
  };
  if (plan.skip) return { ...report, outcome: "skipped", reason: plan.skip };
  deps.mask(plan.origin);
  for (const worker of plan.live) for (const value of Object.values(worker.vars)) deps.mask(value);
  let token = options.deepProbeToken;
  if (token) deps.mask(token);
  if (options.runnerVpcService) deps.mask(options.runnerVpcService);
  const runnerBinding: ConfigAdditions | undefined = options.runnerVpcService
    ? { vpc_services: [{ binding: "RUNNER", service_id: options.runnerVpcService }] }
    : undefined;
  if (token && new URL(plan.origin).protocol !== "https:") {
    deps.log.warn(
      "The probes' origin isn't https, so the deep probe is skipped and DEPLOY_PROBE_TOKEN isn't uploaded.",
    );
    token = undefined;
  }
  if (options.rotateProbeToken && !token) {
    deps.log.warn("rotate-probe-token needs DEPLOY_PROBE_TOKEN, so nothing is uploaded.");
  }
  // Once is enough: each upload is a secret change, which a later rollback must force past.
  const holdsToken = holdsProbeToken(plan.live.find((worker) => worker.spec.script === INGRESS));
  const upload = token !== undefined && (options.rotateProbeToken === true || !holdsToken);
  /** Ingress's deploy carried the token, so restoring the version it replaced needs force. */
  let uploaded = false;

  const since = deps.now();
  for (const [index, worker] of plan.live.entries()) {
    const args = [
      "deploy",
      "--tag",
      formatTag(plan.tag),
      "--message",
      plan.message,
      ...Object.entries(worker.vars).flatMap(([name, value]) => ["--var", `${name}:${value}`]),
    ];
    deps.log.info(`Deploying ${worker.spec.script} as ${formatTag(plan.tag)}`);
    const entry = report.workers[index] as DeployReport["workers"][number];
    try {
      // The token goes to ingress alone, in a file rather than an argument, which logs could show.
      if (token && upload && worker.spec.script === INGRESS) {
        deps.log.info(
          `Uploading DEPLOY_PROBE_TOKEN to ${INGRESS}: ${holdsToken ? "a rotation" : "it has none yet"}`,
        );
        entry.deployed = await withSecretsFile({ [DEEP_PROBE_SECRET]: token }, (file) => {
          uploaded = true;
          return deps.wranglerDeploy(worker.spec, [...args, "--secrets-file", file]);
        });
      } else if (runnerBinding && worker.spec.script === CHANNEL_EGRESS) {
        deps.log.info(`${CHANNEL_EGRESS} gets the runner's VPC Service as its RUNNER binding`);
        entry.deployed = await deps.wranglerDeploy(worker.spec, args, runnerBinding);
      } else {
        entry.deployed = await deps.wranglerDeploy(worker.spec, args);
      }
    } catch (error) {
      // Wrangler can fail in a step after the new version went live, so the live one decides.
      const active = await deps.api.activeDeployment(worker.spec.script).catch(() => null);
      const fresh = active?.versions.find(
        (traffic) => !worker.traffic.some((before) => before.version_id === traffic.version_id),
      );
      if (fresh) entry.deployed = fresh.version_id;
      const reason = `${worker.spec.script} didn't deploy: ${error instanceof Error ? error.message : String(error)}`;
      return rollBack(deps, plan, report, reason, options, uploaded);
    }
  }

  if (!token) {
    deps.log.warn(
      "DEPLOY_PROBE_TOKEN isn't set, so the deep probe is skipped: the Directory, the Registry, the AgentHosts and llm-gateway aren't checked (docs/deploy.md).",
    );
  }
  deps.log.info("Probing production");
  report.probes = await settle(deps, plan.origin, plan.tag, options.settle, token);
  let verdict = verdictOf(report.probes);
  if (verdict.status === "healthy") {
    deps.log.info(`Watching the new versions for ${options.watch.minutes} minutes`);
    const deployed = report.workers.flatMap((worker) => (worker.deployed ? [worker.deployed] : []));
    const watched = await watch(deps, plan.origin, plan.tag, deployed, since, options.watch, token);
    report.probes = watched.probes;
    report.errors = watched.errors;
    report.analytics = watched.analytics;
    verdict = watched.verdict;
  }
  switch (verdict.status) {
    case "healthy":
      return report;
    case "inconclusive":
      return {
        ...report,
        outcome: "failed",
        reason: `${verdict.reason}. Nothing was rolled back: check production, and roll back by request if it's broken.`,
      };
    case "unhealthy":
      return rollBack(deps, plan, report, verdict.reason, options, uploaded);
  }
}

async function rollBack(
  deps: DeployDeps,
  plan: DeployPlan,
  report: DeployReport,
  reason: string,
  options: DeployOptions,
  uploaded: boolean,
): Promise<DeployReport> {
  const deployed = report.workers.filter((worker) => worker.deployed !== null);
  if (deployed.length === 0) return { ...report, outcome: "failed", reason };
  const crossing = plan.barriers.filter((barrier) =>
    deployed.some((worker) => worker.script === barrier.script),
  );
  if (crossing.length > 0) {
    return {
      ...report,
      outcome: "failed",
      reason: `${reason}. Not rolled back automatically: the release crosses rollback barriers (below). Fix forward, or roll back by request (docs/deploy.md).`,
    };
  }

  deps.log.warn(`Rolling back ${formatTag(plan.tag)}: ${reason}`);
  report.rollback = await restore(
    deps.api,
    deployed.map((worker) => ({
      script: worker.script,
      traffic: worker.previous,
      // This deploy gave ingress its DEPLOY_PROBE_TOKEN, and Cloudflare refuses to roll back past a
      // secret change without force. The version restored is the one this deploy replaced, so the
      // only secret change it undoes is this deploy's own.
      ...(uploaded && worker.script === INGRESS ? { force: true } : {}),
    })),
    `Automatic rollback of ${formatTag(plan.tag)}`,
  );
  if (uploaded && report.rollback.some((result) => result.ok && result.script === INGRESS)) {
    report.warnings.push(
      holdsProbeToken(plan.live.find((worker) => worker.spec.script === INGRESS))
        ? "The rollback put ingress back on the previous DEPLOY_PROBE_TOKEN. Once main is fixed, deploy with rotate-probe-token: until then the deep probe fails (docs/deploy.md)."
        : "The rollback put ingress back on a version without DEPLOY_PROBE_TOKEN. The next deploy uploads it again.",
    );
  }
  const stuck = report.rollback.filter((result) => !result.ok).map((result) => result.script);
  if (stuck.length > 0) {
    return {
      ...report,
      outcome: "failed",
      reason: `${reason}. The automatic rollback failed for ${stuck.join(", ")}.`,
    };
  }

  // Without the deep probe: the build rolled back to may have no probe route.
  const previous = plan.live.find((worker) => worker.spec.script === INGRESS)?.tag ?? null;
  report.probes = await settle(deps, plan.origin, previous, options.settle);
  const after = verdictOf(report.probes);
  return {
    ...report,
    outcome: "rolled-back",
    reason:
      after.status === "healthy"
        ? reason
        : `${reason}. After the rollback the probes still don't pass: ${after.reason}`,
  };
}
