import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type CloudflareApi,
  CloudflareError,
  type InvocationCount,
  SECRETS_CHANGED,
  type VersionTraffic,
  type WorkerVersion,
} from "../src/cloudflare.ts";
import type { Git } from "../src/git.ts";
import type {
  ClosedIssue,
  GitHub,
  IssueComment,
  MergedPull,
  Release,
  ReleaseFields,
  WorkflowRun,
} from "../src/github.ts";
import type { BuildTag } from "../src/tags.ts";
import { formatTag } from "../src/tags.ts";
import { WORKERS } from "../src/workers.ts";

export const ORIGIN = "https://ingress.example.com";

/** A version of a Worker, tagged, with the instance vars it was deployed with, and its secrets. */
export function workerVersion(
  id: string,
  number: number,
  tag: BuildTag | null,
  vars: Record<string, string> = {},
  secrets: readonly string[] = [],
): WorkerVersion {
  return {
    id,
    number,
    annotations: tag ? { "workers/tag": formatTag(tag) } : {},
    resources: {
      bindings: [
        ...Object.entries(vars).map(([name, text]) => ({ type: "plain_text", name, text })),
        // Cloudflare lists a secret by its name only.
        ...secrets.map((name) => ({ type: "secret_text", name })),
      ],
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
 * `secrets` names each Worker's secrets. `secretsChanged` lists Workers whose secrets changed since
 * their other versions, which Cloudflare restores only with `force`, as it answers 10220.
 */
export function fakeApi(options: {
  live: BuildTag;
  versions?: BuildTag[];
  history?: BuildTag[];
  vars?: Record<string, Record<string, string>>;
  missing?: { script: string; tag: BuildTag };
  failDeploy?: (script: string, force: boolean) => CloudflareError | undefined;
  secrets?: Record<string, string[]>;
  secretsChanged?: string[];
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
            versionId(worker.script, tag),
            100 - index,
            tag,
            {
              ...(worker.script === "kelpie-channel-egress" ? { INGRESS_ORIGIN: ORIGIN } : {}),
              ...options.vars?.[worker.script],
            },
            options.secrets?.[worker.script],
          ),
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
      if (!force && options.secretsChanged?.includes(script)) {
        throw new CloudflareError("The following secrets have changed: DEPLOY_PROBE_TOKEN", [
          SECRETS_CHANGED,
        ]);
      }
      made.push({ script, traffic: [...traffic], message, force });
      active.set(script, [...traffic]);
    },
    async invocations() {
      return options.invocations ? options.invocations() : [];
    },
  };
}

/**
 * Ingress's deploy probe (#234): the token the Worker holds, and what each part answers, `ok` by
 * default. Without it the build has no probe route.
 */
export interface FakeDeepProbe {
  token: string;
  parts?: Record<string, unknown>;
  status?: number;
}

/**
 * Whether a deploy probe header signs the current time with `token`, as ingress checks it: an
 * HMAC-SHA256 of the unix seconds, in hex, within two minutes.
 */
async function signedWith(header: string, token: string): Promise<boolean> {
  const [seconds = "", mac = ""] = header.split(".");
  if (!/^\d+$/.test(seconds) || Math.abs(Date.now() / 1_000 - Number(seconds)) > 120) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const bytes = mac.match(/^[0-9a-f]{64}$/)
    ? mac.match(/../g)?.map((pair) => parseInt(pair, 16))
    : [];
  return crypto.subtle.verify(
    "HMAC",
    key,
    new Uint8Array(bytes ?? []),
    new TextEncoder().encode(seconds),
  );
}

/** Ingress as the probes see it, serving one build. */
export function fakeProduction(state: {
  serving: BuildTag | null;
  telegram?: number;
  down?: boolean;
  mitigated?: boolean;
  deep?: FakeDeepProbe | undefined;
}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    if (state.down) throw new TypeError("fetch failed");
    if (state.mitigated) {
      return new Response("", { status: 403, headers: { "cf-mitigated": "challenge" } });
    }
    switch (new URL(String(input)).pathname) {
      case "/deploy/probe": {
        const presented = new Headers(init?.headers).get("x-kelpie-deploy-probe") ?? "";
        if (!state.deep || !(await signedWith(presented, state.deep.token))) {
          return new Response("Not found", { status: 404 });
        }
        return Response.json(
          { directory: "ok", registry: "ok", agentHosts: "ok", gateway: "ok", ...state.deep.parts },
          { status: state.deep.status ?? 200 },
        );
      }
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

/** An issue that a pull request closes, in guedesdiogo/kelpie unless named otherwise. */
export function closedIssue(number: number, labels: string[] = [], repo = "guedesdiogo/kelpie") {
  return {
    repo,
    number,
    title: `Issue ${number}`,
    url: `https://github.com/${repo}/issues/${number}`,
    labels,
  } satisfies ClosedIssue;
}

export function mergedPull(number: number, author: string | null, closes: ClosedIssue[] = []) {
  return {
    number,
    title: `Pull request ${number}`,
    url: `https://github.com/guedesdiogo/kelpie/pull/${number}`,
    author,
    closes,
  } satisfies MergedPull;
}

export function comment(author: string | null, body: string, id = 1): IssueComment {
  return { author, body, url: `https://github.com/guedesdiogo/kelpie/issues/1#issuecomment-${id}` };
}

export interface FakeGitHub extends GitHub {
  /** The commits each mergedPulls call asked about. */
  asked: string[][];
  /** The issues whose comments were read, as `repo#number`. */
  read: string[];
  opened: Array<{ title: string; body: string; assignees: string[]; labels: string[] }>;
  commented: Array<{ repo: string; issue: number; body: string }>;
  saved: Array<{ id: number | null; fields: ReleaseFields }>;
}

/**
 * A successful Deploy run of a release: by hand from main unless told otherwise. A release event
 * runs from its tag, at the commit the tag names.
 */
export function productionRun(
  tag: string,
  how: Partial<Omit<WorkflowRun, "title">> = {},
): WorkflowRun {
  return {
    title: `Production ${tag}`,
    event: "workflow_dispatch",
    branch: "main",
    commit: "f".repeat(40),
    ...how,
  };
}

/**
 * GitHub with merged pull requests by the commit that brought them, comments by `repo#number`,
 * `CI passed`'s state by commit, the Deploy workflow's successful runs, and releases. Writes are
 * recorded, and answer made-up URLs.
 */
export function fakeGitHub(
  options: {
    pulls?: Record<string, MergedPull[]>;
    comments?: Record<string, IssueComment[]>;
    checks?: Record<string, string>;
    /** The Deploy workflow's successful runs, newest first. */
    runs?: WorkflowRun[];
    /** The repository's labels; `critico` by default. */
    labels?: string[];
    releases?: Release[];
  } = {},
): FakeGitHub {
  const fake: FakeGitHub = {
    asked: [],
    read: [],
    opened: [],
    commented: [],
    saved: [],
    async mergedPulls(commits) {
      fake.asked.push([...commits]);
      const pulls = new Map<number, MergedPull>();
      for (const commit of commits) {
        for (const pull of options.pulls?.[commit] ?? []) pulls.set(pull.number, pull);
      }
      return [...pulls.values()].sort((a, b) => a.number - b.number);
    },
    async comments(repo, issue) {
      fake.read.push(`${repo}#${issue}`);
      return options.comments?.[`${repo}#${issue}`] ?? [];
    },
    async comment(repo, issue, body) {
      fake.commented.push({ repo, issue, body });
      return `https://github.com/${repo}/issues/${issue}#issuecomment-${fake.commented.length}`;
    },
    async openIssue(issue) {
      fake.opened.push(issue);
      return `https://github.com/guedesdiogo/kelpie/issues/${900 + fake.opened.length}`;
    },
    async checkState(commit) {
      return options.checks?.[commit] ?? null;
    },
    async hasLabel(name) {
      return (options.labels ?? ["critico"]).some(
        (label) => label.toLowerCase() === name.toLowerCase(),
      );
    },
    async successfulRuns() {
      return options.runs ?? [];
    },
    async releases() {
      return options.releases ?? [];
    },
    async createRelease(fields) {
      fake.saved.push({ id: null, fields });
      return {
        id: 7,
        tag: fields.tag,
        target: fields.target,
        draft: fields.draft,
        prerelease: false,
        url: `https://github.com/guedesdiogo/kelpie/releases/tag/${fields.tag}`,
      };
    },
    async updateRelease(id, fields) {
      fake.saved.push({ id, fields });
      return {
        id,
        tag: fields.tag,
        target: fields.target,
        draft: fields.draft,
        prerelease: false,
        url: `https://github.com/guedesdiogo/kelpie/releases/tag/${fields.tag}`,
      };
    },
  };
  return fake;
}
