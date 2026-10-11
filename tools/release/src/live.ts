import { migrationChanges } from "./changes.ts";
import type { CloudflareApi, VersionTraffic, WorkerVersion } from "./cloudflare.ts";
import { type Git, hasCommit } from "./git.ts";
import type { FindingKind } from "./migrations.ts";
import { type BuildTag, parseTag, sameTag } from "./tags.ts";
import { INGRESS_ORIGIN, WORKERS, type WorkerSpec } from "./workers.ts";

/** A Worker as production serves it now. */
export interface LiveWorker {
  spec: WorkerSpec;
  /** The versions serving traffic: what an automatic rollback restores. */
  traffic: VersionTraffic[];
  /** The version with the most traffic. */
  version: WorkerVersion;
  tag: BuildTag | null;
  /** Its instance vars that have a value. */
  vars: Record<string, string>;
}

export async function readLive(
  api: CloudflareApi,
  workers: readonly WorkerSpec[] = WORKERS,
): Promise<LiveWorker[]> {
  return Promise.all(
    workers.map(async (spec) => {
      const deployment = await api.activeDeployment(spec.script);
      const main = deployment?.versions.reduce((best, traffic) =>
        traffic.percentage > best.percentage ? traffic : best,
      );
      if (!deployment || !main) {
        throw new Error(
          `${spec.script} has never been deployed. A new instance's first deploy is by hand (docs/admin-api.md, "Setting it up").`,
        );
      }
      const version = await api.version(spec.script, main.version_id);
      const vars: Record<string, string> = {};
      for (const binding of version.resources?.bindings ?? []) {
        if (
          binding.type === "plain_text" &&
          spec.instanceVars.includes(binding.name) &&
          binding.text
        ) {
          vars[binding.name] = binding.text;
        }
      }
      return {
        spec,
        traffic: deployment.versions,
        version,
        tag: parseTag(version.annotations?.["workers/tag"]),
        vars,
      };
    }),
  );
}

/** Ingress's public origin, from the live channel-egress: where the probes go. */
export function liveOrigin(live: readonly LiveWorker[]): string {
  const origin = live.find((worker) => worker.spec.script === INGRESS_ORIGIN.script)?.vars[
    INGRESS_ORIGIN.name
  ];
  if (!origin) {
    throw new Error(
      `The live ${INGRESS_ORIGIN.script} has no ${INGRESS_ORIGIN.name}, which the probes need. Deploy it once by hand with --var ${INGRESS_ORIGIN.name}:https://<ingress hostname> (docs/secrets.md).`,
    );
  }
  return origin;
}

/**
 * A change between two builds of a Worker that a rollback can't cross safely (ADR-0029).
 * `unknown`: a build without a tag, or a commit this checkout lacks, so nothing can be checked.
 */
export interface Barrier {
  script: string;
  kind: FindingKind | "unknown";
  detail: string;
}

/** Cloudflare refuses these outright; the others a rollback crosses only with `force`. */
export function refusedByCloudflare(barrier: Barrier): boolean {
  return barrier.kind === "class-change" || barrier.kind === "destructive-class";
}

/** The barriers between two builds of each Worker, in either direction. */
export function barriersBetween(
  git: Git,
  moves: ReadonlyArray<{ spec: WorkerSpec; from: BuildTag | null; to: BuildTag | null }>,
): Barrier[] {
  return moves.flatMap(({ spec, from, to }): Barrier[] => {
    if (sameTag(from, to)) return [];
    if (!from || !to) {
      return [{ script: spec.script, kind: "unknown", detail: "a version has no build tag" }];
    }
    const missing = [from, to].find((tag) => !hasCommit(git, tag.commit));
    if (missing) {
      return [
        {
          script: spec.script,
          kind: "unknown",
          detail: `commit ${missing.commit} isn't in this checkout's history`,
        },
      ];
    }
    const [older, newer] = from.build <= to.build ? [from, to] : [to, from];
    return migrationChanges(git, older.commit, newer.commit, [spec.app]).findings.map(
      (finding) => ({
        script: spec.script,
        kind: finding.kind,
        detail: `${finding.file}: ${finding.detail}`,
      }),
    );
  });
}
