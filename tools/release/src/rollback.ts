import {
  type CloudflareApi,
  CloudflareError,
  SECRETS_CHANGED,
  type VersionTraffic,
} from "./cloudflare.ts";
import type { Git } from "./git.ts";
import {
  type Barrier,
  barriersBetween,
  type LiveWorker,
  liveOrigin,
  readLive,
  refusedByCloudflare,
} from "./live.ts";
import {
  type BuildTag,
  formatTag,
  parseTag,
  parseTarget,
  pickTag,
  previousTag,
  type TaggedVersion,
  versionWithTag,
} from "./tags.ts";
import {
  type ProbeResult,
  type SettleOptions,
  settle,
  type Verdict,
  type VerifyDeps,
  verdictOf,
} from "./verify.ts";
import { INGRESS, type WorkerSpec } from "./workers.ts";

export interface Restored {
  script: string;
  ok: boolean;
  detail?: string;
}

/**
 * Serves earlier versions again, in reverse deploy order; one failure doesn't stop the others.
 * `force` restores versions whose secrets differ from the live ones.
 */
export async function restore(
  api: CloudflareApi,
  moves: ReadonlyArray<{ script: string; traffic: readonly VersionTraffic[] }>,
  message: string,
  force = false,
): Promise<Restored[]> {
  const results: Restored[] = [];
  for (const move of [...moves].reverse()) {
    try {
      await api.deployVersions(move.script, move.traffic, message, force);
      results.unshift({ script: move.script, ok: true });
    } catch (error) {
      results.unshift({
        script: move.script,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

/** A rollback that can't go ahead as asked. `moved`: undoing it failed, so production changed. */
export class RollbackRefused extends Error {
  override name = "RollbackRefused";
  constructor(
    message: string,
    readonly moved = false,
  ) {
    super(message);
  }
}

export interface RollbackPlan {
  target: BuildTag;
  /** The Workers not on the target yet. */
  moves: Array<{ spec: WorkerSpec; from: VersionTraffic[]; fromTag: BuildTag | null; to: string }>;
  barriers: Barrier[];
  origin: string;
  live: LiveWorker[];
}

function tagged(
  versions: ReadonlyArray<{
    id: string;
    number: number;
    annotations?: Record<string, string | undefined>;
  }>,
): TaggedVersion[] {
  return versions.flatMap((version) => {
    const tag = parseTag(version.annotations?.["workers/tag"]);
    return tag ? [{ id: version.id, number: version.number, tag }] : [];
  });
}

/**
 * Resolves a rollback target to one version of each Worker, all with the same tag. Ingress picks
 * the tag, since it answers `/version`; every Worker must still have a deployable version with it.
 */
export async function planRollback(
  deps: { api: CloudflareApi; git: Git },
  input: string,
): Promise<RollbackPlan> {
  const target = parseTarget(input);
  if (!target) {
    throw new RollbackRefused(
      `"${input}" isn't a target. Use previous, a build number (96), a tag (96-0c620f4) or a commit.`,
    );
  }
  const live = await readLive(deps.api);
  const origin = liveOrigin(live);
  const versions = await Promise.all(
    live.map(async (worker) => tagged(await deps.api.deployableVersions(worker.spec.script))),
  );
  const ingress = live.findIndex((worker) => worker.spec.script === INGRESS);
  const chosen =
    target.kind === "previous"
      ? previousTag(
          await deps.api.deployments(INGRESS),
          versions[ingress] ?? [],
          live[ingress]?.tag ?? null,
        )
      : pickTag(versions[ingress] ?? [], target);
  if (!chosen && target.kind === "previous") {
    throw new RollbackRefused(
      `${INGRESS}'s recent deployments show no earlier build that a rollback can reach. Name a build instead.`,
    );
  }
  if (!chosen) {
    const recent = [...new Set((versions[ingress] ?? []).map((version) => formatTag(version.tag)))]
      .slice(0, 10)
      .join(", ");
    throw new RollbackRefused(
      `No deployable version of ${INGRESS} matches "${input}". Recent builds: ${recent || "none"}.`,
    );
  }

  const missing: string[] = [];
  const moves: RollbackPlan["moves"] = [];
  live.forEach((worker, index) => {
    const version = versionWithTag(versions[index] ?? [], chosen);
    if (!version) {
      missing.push(worker.spec.script);
      return;
    }
    const [only, ...rest] = worker.traffic;
    if (only?.version_id === version.id && rest.length === 0) return;
    moves.push({ spec: worker.spec, from: worker.traffic, fromTag: worker.tag, to: version.id });
  });
  if (missing.length > 0) {
    throw new RollbackRefused(
      `${missing.join(", ")} has no deployable version tagged ${formatTag(chosen)}: Cloudflare keeps the 100 most recent. Pick another build.`,
    );
  }

  const barriers = barriersBetween(
    deps.git,
    moves.map((move) => ({ spec: move.spec, from: move.fromTag, to: chosen })),
  );
  return { target: chosen, moves, barriers, origin, live };
}

export interface RollbackReport {
  target: BuildTag;
  reason: string;
  moved: Array<{ script: string; from: VersionTraffic[]; to: string }>;
  barriers: Barrier[];
  probes: ProbeResult[];
  verdict: Verdict;
}

/**
 * Rolls every Worker back to the plan's target. All of them move or none does: a Worker that
 * refuses undoes the ones moved before it, so production never mixes two builds.
 */
export async function rollback(
  deps: Pick<VerifyDeps, "api" | "fetch" | "sleep" | "log">,
  plan: RollbackPlan,
  options: { force: boolean; reason: string; settle: SettleOptions },
): Promise<RollbackReport> {
  const describe = (list: readonly Barrier[]) =>
    list.map((barrier) => `${barrier.script}: ${barrier.detail}`).join("; ");
  const refused = plan.barriers.filter(refusedByCloudflare);
  if (refused.length > 0) {
    throw new RollbackRefused(
      `Cloudflare refuses rollbacks across a Durable Object class migration (${describe(refused)}). Fix forward instead, or pick a build after it.`,
    );
  }
  if (plan.barriers.length > 0 && !options.force) {
    throw new RollbackRefused(
      `This rollback crosses changes the older code may not handle (${describe(plan.barriers)}). Run it with force once you've checked that build can run on today's data.`,
    );
  }

  const message = `Rollback to ${formatTag(plan.target)}: ${options.reason}`;
  const moved: RollbackPlan["moves"] = [];
  for (const move of [...plan.moves].reverse()) {
    const traffic = [{ version_id: move.to, percentage: 100 }];
    try {
      try {
        await deps.api.deployVersions(move.spec.script, traffic, message, false);
      } catch (error) {
        const secretsChanged =
          error instanceof CloudflareError && error.codes.includes(SECRETS_CHANGED);
        if (!secretsChanged) throw error;
        if (!options.force) {
          throw new RollbackRefused(
            `${move.spec.script}'s secrets changed since ${formatTag(plan.target)}, and rolling back restores the old values. Run it with force if that's intended.`,
          );
        }
        await deps.api.deployVersions(move.spec.script, traffic, message, true);
      }
      moved.push(move);
    } catch (error) {
      const undone = await restore(
        deps.api,
        moved.map((done) => ({ script: done.spec.script, traffic: done.from })),
        `Undo the partial rollback to ${formatTag(plan.target)}`,
        options.force,
      );
      const stuck = undone.filter((result) => !result.ok).map((result) => result.script);
      const reason = error instanceof Error ? error.message : String(error);
      throw stuck.length === 0
        ? new RollbackRefused(`${reason} Nothing was rolled back.`)
        : new RollbackRefused(
            `${reason} Undoing the Workers already rolled back failed for ${stuck.join(", ")}: production mixes two builds now.`,
            true,
          );
    }
  }

  const probes = await settle(deps, plan.origin, plan.target, options.settle);
  return {
    target: plan.target,
    reason: options.reason,
    moved: moved
      .reverse()
      .map((move) => ({ script: move.spec.script, from: move.from, to: move.to })),
    barriers: plan.barriers,
    probes,
    verdict: verdictOf(probes),
  };
}
