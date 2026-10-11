import type { VersionTraffic } from "./cloudflare.ts";
import type { DeployPlan, DeployReport } from "./deploy.ts";
import type { Barrier, LiveWorker } from "./live.ts";
import type { RollbackPlan, RollbackReport } from "./rollback.ts";
import { type BuildTag, formatTag } from "./tags.ts";
import type { ProbeResult } from "./verify.ts";

// Reports go to public CI logs and issues: they name Workers, builds and version ids, never the
// instance's hostnames or vars.

const short = (id: string) => `\`${id.slice(0, 8)}\``;
const tagOf = (tag: BuildTag | null) => (tag ? formatTag(tag) : "untagged");
const traffic = (list: readonly VersionTraffic[]) =>
  list
    .map(
      (entry) =>
        `${short(entry.version_id)}${entry.percentage === 100 ? "" : ` ${entry.percentage}%`}`,
    )
    .join(" + ");

function probes(list: readonly ProbeResult[]): string {
  if (list.length === 0) return "- not run";
  return list.map((probe) => `- \`${probe.probe}\`: ${probe.outcome}, ${probe.detail}`).join("\n");
}

function barriers(list: readonly Barrier[]): string {
  if (list.length === 0) return "- none";
  return list
    .map((barrier) => `- ${barrier.script} (${barrier.kind}): ${barrier.detail}`)
    .join("\n");
}

export function deployReport(report: DeployReport): string {
  const title = {
    deployed: "deployed",
    "rolled-back": "rolled back automatically",
    failed: "failed",
  }[report.outcome];
  const errors = Object.entries(report.errors);
  return [
    `## Deploy of ${formatTag(report.tag)}: ${title}`,
    report.reason ? `\n${report.reason}\n` : "",
    "| Worker | Before | Deployed |",
    "|---|---|---|",
    ...report.workers.map(
      (worker) =>
        `| ${worker.script} | ${tagOf(worker.previousTag)} (${traffic(worker.previous)}) | ${worker.deployed ? short(worker.deployed) : "no"} |`,
    ),
    "",
    "**Probes**",
    probes(report.probes),
    "",
    `**Failed invocations of the new versions**${report.analytics ? "" : " (analytics unavailable)"}`,
    errors.length === 0
      ? "- none"
      : errors.map(([name, count]) => `- ${name}: ${count}`).join("\n"),
    "",
    "**Rollback barriers in this release**",
    barriers(report.barriers),
    ...(report.rollback.length === 0
      ? []
      : [
          "",
          "**Automatic rollback**",
          report.rollback
            .map(
              (result) =>
                `- ${result.script}: ${result.ok ? "restored" : `failed, ${result.detail}`}`,
            )
            .join("\n"),
        ]),
    "",
  ].join("\n");
}

export function deployPlanReport(plan: DeployPlan): string {
  return [
    `## Deploy plan for ${formatTag(plan.tag)}`,
    "",
    `Message: ${plan.message}`,
    "",
    "| Worker | Live | Carried vars |",
    "|---|---|---|",
    ...plan.live.map(
      (worker) =>
        `| ${worker.spec.script} | ${tagOf(worker.tag)} (${traffic(worker.traffic)}) | ${Object.keys(worker.vars).join(", ") || "none"} |`,
    ),
    "",
    "**Rollback barriers in this release**",
    barriers(plan.barriers),
    "",
  ].join("\n");
}

export function rollbackPlanReport(plan: RollbackPlan): string {
  return [
    `## Rollback plan to ${formatTag(plan.target)}`,
    "",
    "| Worker | From | To |",
    "|---|---|---|",
    ...plan.moves.map(
      (move) =>
        `| ${move.spec.script} | ${tagOf(move.fromTag)} (${traffic(move.from)}) | ${short(move.to)} |`,
    ),
    plan.moves.length === 0 ? "\nEvery Worker already serves it." : "",
    "",
    "**Changes the rollback crosses**",
    barriers(plan.barriers),
    "",
  ].join("\n");
}

export function rollbackReport(report: RollbackReport): string {
  return [
    `## Rollback to ${formatTag(report.target)}: ${report.verdict.status === "healthy" ? "done" : "done, but the probes don't pass"}`,
    `\nWhy: ${report.reason}\n`,
    report.verdict.status === "healthy" ? "" : `${report.verdict.reason}\n`,
    "| Worker | From | To |",
    "|---|---|---|",
    ...report.moved.map((move) => `| ${move.script} | ${traffic(move.from)} | ${short(move.to)} |`),
    "",
    "**Probes**",
    probes(report.probes),
    "",
    "**Changes crossed**",
    barriers(report.barriers),
    "",
  ].join("\n");
}

export function statusReport(live: readonly LiveWorker[], builds: readonly BuildTag[]): string {
  return [
    "## Production",
    "",
    "| Worker | Build | Versions |",
    "|---|---|---|",
    ...live.map(
      (worker) => `| ${worker.spec.script} | ${tagOf(worker.tag)} | ${traffic(worker.traffic)} |`,
    ),
    "",
    `Builds a rollback can reach (newest first): ${builds.map(formatTag).join(", ") || "none"}`,
    "",
  ].join("\n");
}
