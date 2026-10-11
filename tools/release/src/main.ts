import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { migrationChanges } from "./changes.ts";
import { cloudflareApi } from "./cloudflare.ts";
import { type DeployDeps, deploy, planDeploy } from "./deploy.ts";
import { gitAt, repoRoot } from "./git.ts";
import { readLive } from "./live.ts";
import { maskCommands, redactor } from "./redact.ts";
import {
  deployPlanReport,
  deployReport,
  rollbackPlanReport,
  rollbackReport,
  statusReport,
} from "./report.ts";
import { planRollback, RollbackRefused, rollback } from "./rollback.ts";
import { type BuildTag, parseTag, sameTag } from "./tags.ts";
import type { Log } from "./verify.ts";
import { INGRESS, type WorkerSpec } from "./workers.ts";

const USAGE = `Usage, from tools/release: bun run release <command> [options]

  guard [--base <ref>]     Migration checks for CI, from <ref> (default HEAD^1) to HEAD.
  status                   What production serves, and the builds a rollback can reach.
  deploy [--plan] [--watch-minutes 10] [--error-threshold 3] [--report <file>]
                           Deploys HEAD, verifies it and rolls it back if it's unhealthy.
  rollback --target <previous|build|tag|commit> [--reason <text>] [--force] [--plan] [--report <file>]
                           Rolls every Worker back to one earlier build.

deploy, status and rollback need CLOUDFLARE_ACCOUNT_ID, and CLOUDFLARE_API_TOKEN or a
wrangler login. See docs/deploy.md.`;

const inActions = process.env.GITHUB_ACTIONS === "true";

const secrets = redactor((value) => {
  if (inActions) for (const command of maskCommands(value)) console.log(command);
});
const hide = secrets.hide;
const redact = secrets.redact;

const log: Log = {
  info: (message) => console.log(redact(message)),
  warn: (message) =>
    console.log(inActions ? `::warning::${redact(message)}` : `Warning: ${redact(message)}`),
};

function annotate(level: "error" | "warning", message: string, file?: string): void {
  const text = redact(message);
  if (inActions) console.log(`::${level}${file ? ` file=${file}` : ""}::${text}`);
  else console.log(`${level === "error" ? "Error" : "Warning"}: ${file ? `${file}: ` : ""}${text}`);
}

function publish(markdown: string, file: string | undefined): void {
  const text = redact(markdown);
  console.log(text);
  if (file) writeFileSync(file, text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
}

function wranglerBin(root: string, spec: Pick<WorkerSpec, "app">): string {
  return join(root, "apps", spec.app, "node_modules", ".bin", "wrangler");
}

function api(root: string) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) throw new Error("Set CLOUDFLARE_ACCOUNT_ID to the account Kelpie runs in.");
  hide(accountId);
  if (inActions && !process.env.CLOUDFLARE_API_TOKEN) {
    throw new Error(
      "The production environment has no CLOUDFLARE_API_TOKEN secret (docs/deploy.md, One-time setup).",
    );
  }
  // Without a token, borrow wrangler's own login, as a local run has.
  const token =
    process.env.CLOUDFLARE_API_TOKEN ||
    (
      JSON.parse(
        execFileSync(wranglerBin(root, { app: "ingress" }), ["auth", "token", "--json"], {
          encoding: "utf8",
        }),
      ) as { token: string }
    ).token;
  return cloudflareApi(token, accountId);
}

/** Runs `wrangler deploy` in the Worker's directory and returns the version it made. */
function wranglerDeploy(root: string) {
  return (spec: WorkerSpec, args: string[]) =>
    new Promise<string>((resolve, reject) => {
      const dir = mkdtempSync(join(tmpdir(), "kelpie-release-"));
      const output = join(dir, "wrangler.ndjson");
      const child = spawn(wranglerBin(root, spec), args, {
        cwd: join(root, "apps", spec.app),
        // Errors only: wrangler's other output lists each var with its value cut short, which the
        // runner's masks miss, and can print the remote config with the custom domains.
        env: {
          ...process.env,
          WRANGLER_OUTPUT_FILE_PATH: output,
          WRANGLER_LOG: "error",
          FORCE_COLOR: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      for (const stream of [child.stdout, child.stderr]) {
        createInterface({ input: stream }).on("line", (line) => {
          if (!line.includes("Environment Variable")) console.log(redact(line));
        });
      }
      child.on("error", reject);
      child.on("close", (code) => {
        let versionId: string | undefined;
        try {
          versionId = readFileSync(output, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { type?: string; version_id?: string })
            .find((entry) => entry.type === "deploy")?.version_id;
        } catch {
          // No output file: wrangler failed before deploying.
        }
        rmSync(dir, { recursive: true, force: true });
        if (code !== 0) reject(new Error(`wrangler exited with ${code}`));
        else if (!versionId) reject(new Error("wrangler reported no version id"));
        else resolve(versionId);
      });
    });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const now = () => new Date();
const settleOptions = { attempts: 18, intervalMs: 10_000 };

function bounded(value: string | undefined, fallback: number, name: string, max: number): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > max) {
    throw new Error(`--${name} takes a number from 0 to ${max}.`);
  }
  return number;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      base: { type: "string" },
      plan: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      target: { type: "string" },
      reason: { type: "string" },
      report: { type: "string" },
      "watch-minutes": { type: "string" },
      "error-threshold": { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  const [command] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return command ? 0 : 1;
  }
  const root = repoRoot(process.cwd());
  const git = gitAt(root);

  switch (command) {
    case "guard": {
      const base = values.base ?? "HEAD^1";
      if (base.startsWith("-")) throw new Error("--base takes a git ref.");
      const { problems, findings } = migrationChanges(git, base, "HEAD");
      for (const problem of problems) annotate("error", problem);
      let blocking = problems.length;
      for (const finding of findings) {
        if (finding.kind === "class-change") {
          annotate(
            "warning",
            `${finding.detail}. Cloudflare can't roll production back past the deploy that applies it (ADR-0029).`,
            finding.file,
          );
        } else if (finding.acknowledged) {
          annotate("warning", `Rollback barrier, acknowledged: ${finding.detail}.`, finding.file);
        } else {
          blocking++;
          const marker =
            finding.kind === "destructive-sql"
              ? "-- rollback-barrier: <reason>"
              : "// rollback-barrier: <reason>";
          annotate(
            "error",
            `This migration ${finding.detail}, so code from before it can't run on the migrated data and production can't roll back past it. Prefer an add-only change (ADR-0029). If it's intended, add the line "${marker}" to the file.`,
            finding.file,
          );
        }
      }
      console.log(
        `Migrations from ${base} to HEAD: ${problems.length} problem(s), ${findings.length} rollback barrier(s), ${blocking} blocking.`,
      );
      return blocking === 0 ? 0 : 1;
    }

    case "status": {
      const cloudflare = api(root);
      const live = await readLive(cloudflare);
      const builds: BuildTag[] = [];
      for (const version of await cloudflare.deployableVersions(INGRESS)) {
        const tag = parseTag(version.annotations?.["workers/tag"]);
        if (tag && !builds.some((known) => sameTag(known, tag))) builds.push(tag);
      }
      publish(
        statusReport(
          live,
          builds.sort((a, b) => b.build - a.build),
        ),
        values.report,
      );
      return 0;
    }

    case "deploy": {
      const cloudflare = api(root);
      const deps: DeployDeps = {
        api: cloudflare,
        git,
        fetch,
        sleep,
        now,
        log,
        wranglerDeploy: wranglerDeploy(root),
        mask: hide,
      };
      const plan = await planDeploy(deps);
      hide(plan.origin);
      for (const worker of plan.live) for (const value of Object.values(worker.vars)) hide(value);
      if (values.plan) {
        publish(deployPlanReport(plan), values.report);
        return 0;
      }
      const report = await deploy(deps, plan, {
        settle: settleOptions,
        watch: {
          // The deploy job has 45 minutes, and a killed watch leaves no rollback behind.
          minutes: bounded(values["watch-minutes"], 10, "watch-minutes", 30),
          intervalMs: 60_000,
          errorThreshold: bounded(values["error-threshold"], 3, "error-threshold", 1000),
          failuresInARow: 3,
        },
      });
      publish(deployReport(report), values.report);
      return report.outcome === "deployed" ? 0 : 1;
    }

    case "rollback": {
      if (!values.target) throw new RollbackRefused("rollback needs --target.");
      const cloudflare = api(root);
      const plan = await planRollback({ api: cloudflare, git }, values.target);
      hide(plan.origin);
      for (const worker of plan.live) for (const value of Object.values(worker.vars)) hide(value);
      if (values.plan) {
        publish(rollbackPlanReport(plan), values.report);
        return 0;
      }
      const report = await rollback({ api: cloudflare, fetch, sleep, log }, plan, {
        force: values.force,
        reason: values.reason ?? "requested by the owner",
        settle: settleOptions,
      });
      publish(rollbackReport(report), values.report);
      return report.verdict.status === "healthy" ? 0 : 1;
    }

    default:
      console.log(USAGE);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    const message = redact(error instanceof Error ? error.message : String(error));
    annotate("error", message);
    const file = process.argv.includes("--report")
      ? process.argv[process.argv.indexOf("--report") + 1]
      : undefined;
    if (file) writeFileSync(file, `## Release tooling stopped\n\n${message}\n`);
    process.exit(1);
  },
);
