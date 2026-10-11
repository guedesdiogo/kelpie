import type { MigrationReport } from "./changes.ts";

export interface Annotation {
  level: "error" | "warning";
  message: string;
  file?: string;
}

/**
 * CI's verdict on a pull request's migration changes (ADR-0029). Problems always block. A rollback
 * barrier blocks until a `rollback-barrier: <reason>` comment acknowledges it; a new Durable Object
 * class only warns, since Cloudflare already refuses rollbacks across it.
 */
export function guardVerdict(report: MigrationReport): {
  annotations: Annotation[];
  blocking: number;
} {
  const annotations: Annotation[] = report.problems.map((message) => ({ level: "error", message }));
  let blocking = report.problems.length;
  for (const finding of report.findings) {
    if (finding.kind === "class-change") {
      annotations.push({
        level: "warning",
        message: `${finding.detail}. Cloudflare can't roll production back past the deploy that applies it (ADR-0029).`,
        file: finding.file,
      });
    } else if (finding.acknowledged) {
      annotations.push({
        level: "warning",
        message: `Rollback barrier, acknowledged: ${finding.detail}.`,
        file: finding.file,
      });
    } else {
      blocking++;
      const marker =
        finding.kind === "destructive-sql"
          ? "-- rollback-barrier: <reason>"
          : "// rollback-barrier: <reason>";
      annotations.push({
        level: "error",
        message: `This migration ${finding.detail}, so code from before it can't run on the migrated data and production can't roll back past it. Prefer an add-only change (ADR-0029). If it's intended, add the line "${marker}" to the file.`,
        file: finding.file,
      });
    }
  }
  return { annotations, blocking };
}
