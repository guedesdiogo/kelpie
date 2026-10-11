import type { DeployReport } from "./deploy.ts";
import { RollbackRefused, type RollbackReport } from "./rollback.ts";

/**
 * A numeric option, from 0 to `max`. The watch's cap matters: the deploy job has 45 minutes, and
 * a watch the job kills leaves no rollback behind.
 */
export function bounded(
  value: string | undefined,
  fallback: number,
  name: string,
  max: number,
): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > max) {
    throw new Error(`--${name} takes a number from 0 to ${max}.`);
  }
  return number;
}

/**
 * Each command's exit code. Only a passing guard, a kept release or a rollback whose probes pass
 * is 0: a release rolled back automatically fails its job, so it opens an issue.
 */
export const exitCode = {
  guard: (blocking: number) => (blocking === 0 ? 0 : 1),
  deploy: (report: Pick<DeployReport, "outcome">) => (report.outcome === "deployed" ? 0 : 1),
  rollback: (report: Pick<RollbackReport, "verdict">) =>
    report.verdict.status === "healthy" ? 0 : 1,
};

/** Whether a run that stopped on an error leaves a report for an issue. */
export function reportsFailure(error: unknown): boolean {
  // A rollback refused before anything moved changed nothing; the run's error says why.
  return !(error instanceof RollbackRefused && !error.moved);
}
