import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  CloudflareApi,
  CloudflareError,
  InvocationCount,
  VersionTraffic,
  WorkerVersion,
} from "../src/cloudflare.ts";
import type { Git } from "../src/git.ts";
import type { BuildTag } from "../src/tags.ts";
import { formatTag } from "../src/tags.ts";
import { WORKERS } from "../src/workers.ts";

export const ORIGIN = "https://ingress.example.com";

/** A version of a Worker, tagged, with the instance vars it was deployed with. */
export function workerVersion(
  id: string,
  number: number,
  tag: BuildTag | null,
  vars: Record<string, string> = {},
): WorkerVersion {
  return {
    id,
    number,
    annotations: tag ? { "workers/tag": formatTag(tag) } : {},
    resources: {
      bindings: Object.entries(vars).map(([name, text]) => ({ type: "plain_text", name, text })),
    },
  };
}

export interface FakeApi extends CloudflareApi {
  /** Every deployment made through the API, as rollbacks make them. */
  deployments: Array<{
    script: string;
    traffic: VersionTraffic[];
    message: string;
    force: boolean;
  }>;
}

/**
 * Cloudflare with the six Workers live on one build. `failDeploy` makes the deployments API refuse
 * a Worker, with `force` or without.
 */
export function fakeApi(options: {
  live: BuildTag;
  versions?: BuildTag[];
  missing?: { script: string; tag: BuildTag };
  failDeploy?: (script: string, force: boolean) => CloudflareError | undefined;
  invocations?: () => InvocationCount[] | Promise<InvocationCount[]>;
}): FakeApi {
  const builds = [options.live, ...(options.versions ?? [])];
  const versions = new Map(
    WORKERS.map((worker) => [
      worker.script,
      builds
        .filter(
          (tag) =>
            !(
              options.missing?.script === worker.script &&
              formatTag(options.missing.tag) === formatTag(tag)
            ),
        )
        .map((tag, index) =>
          workerVersion(
            `${worker.app}-${formatTag(tag)}`,
            100 - index,
            tag,
            worker.script === "kelpie-channel-egress" ? { INGRESS_ORIGIN: ORIGIN } : {},
          ),
        ),
    ]),
  );
  const deployments: FakeApi["deployments"] = [];
  return {
    deployments,
    async activeDeployment(script) {
      return {
        id: `deployment-${script}`,
        created_on: "2026-10-10T00:00:00Z",
        versions: [
          {
            version_id: `${script.replace("kelpie-", "")}-${formatTag(options.live)}`,
            percentage: 100,
          },
        ],
      };
    },
    async version(script, versionId) {
      const found = versions.get(script)?.find((version) => version.id === versionId);
      if (!found) throw new Error(`no version ${versionId}`);
      return found;
    },
    async deployableVersions(script) {
      return versions.get(script) ?? [];
    },
    async deployVersions(script, traffic, message, force) {
      const error = options.failDeploy?.(script, force);
      if (error) throw error;
      deployments.push({ script, traffic: [...traffic], message, force });
    },
    async invocations() {
      return options.invocations ? options.invocations() : [];
    },
  };
}

/** Ingress as the probes see it, serving one build. */
export function fakeProduction(state: {
  serving: BuildTag | null;
  telegram?: number;
  down?: boolean;
  mitigated?: boolean;
}): typeof fetch {
  return (async (input: string | URL | Request) => {
    if (state.down) throw new TypeError("fetch failed");
    if (state.mitigated) {
      return new Response("", { status: 403, headers: { "cf-mitigated": "challenge" } });
    }
    switch (new URL(String(input)).pathname) {
      case "/health":
        return Response.json({ status: "ok" });
      case "/version":
        return Response.json({
          build: state.serving?.build ?? null,
          commit: state.serving?.commit ?? null,
        });
      case "/webhooks/telegram/kelpie-deploy-probe":
        return new Response(null, { status: state.telegram ?? 401 });
      case "/github/webhook":
        return new Response(null, { status: 401 });
      default:
        return new Response("Not found", { status: 404 });
    }
  }) as typeof fetch;
}

/** A git that knows every commit and sees no changes between them. */
export const quietGit: Git = (args) => {
  switch (args[0]) {
    case "rev-list":
      return "96\n";
    case "rev-parse":
      return "abc1234\n";
    case "log":
      return "Add a feature (#300)\n";
    default:
      return "";
  }
};

/** A throwaway repository; each call to `commit` writes files and commits them. */
export function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "kelpie-release-test-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  return {
    dir,
    commit(files: Record<string, string | null>, message = "change"): string {
      for (const [path, content] of Object.entries(files)) {
        if (content === null) {
          git("rm", "-q", path);
          continue;
        }
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), content);
        git("add", path);
      }
      git("commit", "-q", "--allow-empty", "-m", message);
      return git("rev-parse", "HEAD").trim();
    },
  };
}

export const noSleep = async () => {};

/** A clock that moves forward by each sleep. */
export function fakeClock(start = Date.parse("2026-10-11T00:00:00Z")) {
  let time = start;
  return {
    now: () => new Date(time),
    sleep: async (ms: number) => {
      time += ms;
    },
  };
}

export const silentLog = { info: () => {}, warn: () => {} };
