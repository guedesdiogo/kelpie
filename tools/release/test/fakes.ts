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
  made: Array<{ script: string; traffic: VersionTraffic[]; message: string; force: boolean }>;
  /** What each Worker serves now; deployments through the API change it. */
  active: Map<string, VersionTraffic[]>;
}

const versionId = (script: string, tag: BuildTag) =>
  `${script.replace("kelpie-", "")}-${formatTag(tag)}`;

/**
 * Cloudflare with the six Workers live on one build. `versions` are earlier builds still
 * deployable, and by default each was deployed in turn, newest first; `history` replaces that
 * order. `failDeploy` makes the deployments API refuse a Worker, with `force` or without.
 */
export function fakeApi(options: {
  live: BuildTag;
  versions?: BuildTag[];
  history?: BuildTag[];
  vars?: Record<string, Record<string, string>>;
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
          workerVersion(versionId(worker.script, tag), 100 - index, tag, {
            ...(worker.script === "kelpie-channel-egress" ? { INGRESS_ORIGIN: ORIGIN } : {}),
            ...options.vars?.[worker.script],
          }),
        ),
    ]),
  );
  const active = new Map(
    WORKERS.map((worker) => [
      worker.script,
      [{ version_id: versionId(worker.script, options.live), percentage: 100 }],
    ]),
  );
  const made: FakeApi["made"] = [];
  const deployments = async (script: string) =>
    [
      active.get(script) ?? [],
      ...(options.history ?? options.versions ?? []).map((tag) => [
        { version_id: versionId(script, tag), percentage: 100 },
      ]),
    ].map((traffic, index) => ({
      id: `deployment-${index}`,
      created_on: "2026-10-10T00:00:00Z",
      versions: traffic,
    }));
  return {
    made,
    active,
    deployments,
    async activeDeployment(script) {
      return (await deployments(script))[0] ?? null;
    },
    async version(script, id) {
      const found = versions.get(script)?.find((version) => version.id === id);
      if (!found) throw new Error(`no version ${id}`);
      return found;
    },
    async deployableVersions(script) {
      return versions.get(script) ?? [];
    },
    async deployVersions(script, traffic, message, force) {
      const error = options.failDeploy?.(script, force);
      if (error) throw error;
      made.push({ script, traffic: [...traffic], message, force });
      active.set(script, [...traffic]);
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
