import type { VersionTraffic } from "./cloudflare.ts";
import { buildTagOf, type Git, isClean, subjectOf } from "./git.ts";
import { type Barrier, barriersBetween, type LiveWorker, liveOrigin, readLive } from "./live.ts";
import { type Restored, restore } from "./rollback.ts";
import { type BuildTag, formatTag } from "./tags.ts";
import {
  type ProbeResult,
  type SettleOptions,
  settle,
  type VerifyDeps,
  verdictOf,
  type WatchOptions,
  watch,
} from "./verify.ts";
import { INGRESS, type WorkerSpec } from "./workers.ts";

export interface DeployDeps extends VerifyDeps {
  git: Git;
  /** Runs `wrangler deploy` with these arguments for one Worker; returns the version it made. */
  wranglerDeploy(spec: WorkerSpec, args: string[]): Promise<string>;
  /** Keeps a value out of CI logs. */
  mask(value: string): void;
}

export interface DeployPlan {
  tag: BuildTag;
  message: string;
  live: LiveWorker[];
  /** What an automatic rollback of this release would cross; any of them prevents one. */
  barriers: Barrier[];
  origin: string;
}

export async function planDeploy(
  deps: Pick<DeployDeps, "api" | "git">,
  message?: string,
): Promise<DeployPlan> {
  if (!isClean(deps.git)) {
    throw new Error(
      "The working tree has changes. Deploy from a clean checkout of a commit on main.",
    );
  }
  const tag = buildTagOf(deps.git, "HEAD");
  const live = await readLive(deps.api);
  return {
    tag,
    message: (message ?? `${tag.commit} ${subjectOf(deps.git, "HEAD")}`).slice(0, 100),
    live,
    barriers: barriersBetween(
      deps.git,
      live.map((worker) => ({ spec: worker.spec, from: worker.tag, to: tag })),
    ),
    origin: liveOrigin(live),
  };
}

export interface DeployReport {
  tag: BuildTag;
  outcome: "deployed" | "rolled-back" | "failed";
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
}

export interface DeployOptions {
  settle: SettleOptions;
  watch: WatchOptions;
}

/**
 * Deploys every Worker in order, checks production, and rolls the release back when the checks
 * fail. Each Worker carries its instance vars from the live version. `wrangler deploy` applies the
 * Durable Object class migrations; each object applies its SQL migrations when it first wakes on
 * the new code.
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
  };
  deps.mask(plan.origin);
  for (const worker of plan.live) for (const value of Object.values(worker.vars)) deps.mask(value);

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
    try {
      (report.workers[index] as DeployReport["workers"][number]).deployed =
        await deps.wranglerDeploy(worker.spec, args);
    } catch (error) {
      const reason = `${worker.spec.script} didn't deploy: ${error instanceof Error ? error.message : String(error)}`;
      return rollBack(deps, plan, report, reason, options);
    }
  }

  deps.log.info("Probing production");
  report.probes = await settle(deps, plan.origin, plan.tag, options.settle);
  let verdict = verdictOf(report.probes);
  if (verdict.status === "healthy") {
    deps.log.info(`Watching the new versions for ${options.watch.minutes} minutes`);
    const deployed = report.workers.flatMap((worker) => (worker.deployed ? [worker.deployed] : []));
    const watched = await watch(deps, plan.origin, plan.tag, deployed, since, options.watch);
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
      return rollBack(deps, plan, report, verdict.reason, options);
  }
}

async function rollBack(
  deps: DeployDeps,
  plan: DeployPlan,
  report: DeployReport,
  reason: string,
  options: DeployOptions,
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
    deployed.map((worker) => ({ script: worker.script, traffic: worker.previous })),
    `Automatic rollback of ${formatTag(plan.tag)}`,
  );
  const stuck = report.rollback.filter((result) => !result.ok).map((result) => result.script);
  if (stuck.length > 0) {
    return {
      ...report,
      outcome: "failed",
      reason: `${reason}. The automatic rollback failed for ${stuck.join(", ")}.`,
    };
  }

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
