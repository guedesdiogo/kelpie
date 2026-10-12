import { existsSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CloudflareError } from "../src/cloudflare.ts";
import {
  type DeployDeps,
  deepProbeToken,
  deploy,
  deployedVersion,
  planDeploy,
} from "../src/deploy.ts";
import { deployPlanReport, deployReport } from "../src/report.ts";
import type { BuildTag } from "../src/tags.ts";
import { WORKERS, type WorkerSpec } from "../src/workers.ts";
import {
  type FakeDeepProbe,
  fakeApi,
  fakeClock,
  fakeProduction,
  ORIGIN,
  quietGit,
} from "./fakes.ts";

const live = { build: 95, commit: "25c5076" };
const next = { build: 96, commit: "abc1234" };
const options = {
  settle: { attempts: 3, intervalMs: 10_000 },
  watch: { minutes: 2, intervalMs: 60_000, errorThreshold: 3, failuresInARow: 3 },
};

/**
 * Production as deploys change it: ingress serves whichever build was deployed or restored last.
 * The new build has the deploy probe's route, with the token its deploy uploaded; the live one
 * doesn't.
 */
function harness(setup: {
  failWrangler?: string;
  /** The failing Worker's new version went live before wrangler failed. */
  liveBeforeFailing?: boolean;
  brokenAfterDeploy?: boolean;
  /** What the new build's deploy probe answers for each part, `ok` by default. */
  deepParts?: Record<string, string>;
  failRestore?: string;
  invocations?: Parameters<typeof fakeApi>[0]["invocations"];
}) {
  const production: { serving: BuildTag | null; telegram: number; deep?: FakeDeepProbe } = {
    serving: live,
    telegram: 401,
  };
  const api = fakeApi({
    live,
    ...(setup.invocations ? { invocations: setup.invocations } : {}),
    failDeploy: (script) =>
      script === setup.failRestore ? new CloudflareError("refused", [10000]) : undefined,
  });
  const restore = api.deployVersions.bind(api);
  api.deployVersions = async (script, traffic, message, force) => {
    await restore(script, traffic, message, force);
    if (script === "kelpie-ingress") {
      production.serving = live;
      delete production.deep;
    }
    production.telegram = 401;
  };
  const wranglerCalls: Array<{
    spec: WorkerSpec;
    args: string[];
    /** The secrets file wrangler was given: where it was, what it held, and its permissions. */
    secrets?: { path: string; content: Record<string, string>; mode: number };
  }> = [];
  const masked: string[] = [];
  const warnings: string[] = [];
  const deps: DeployDeps = {
    api,
    git: quietGit,
    fetch: fakeProduction(production),
    ...fakeClock(),
    log: { info: () => {}, warn: (message) => warnings.push(message) },
    mask: (value) => masked.push(value),
    async wranglerDeploy(spec, args) {
      // Wrangler reads the secrets file while it runs; the test keeps what it found there.
      const file = args.includes("--secrets-file")
        ? args[args.indexOf("--secrets-file") + 1]
        : undefined;
      const secrets = file
        ? {
            path: file,
            content: JSON.parse(readFileSync(file, "utf8")) as Record<string, string>,
            mode: statSync(file).mode & 0o777,
          }
        : undefined;
      wranglerCalls.push({ spec, args, ...(secrets ? { secrets } : {}) });
      if (spec.script === setup.failWrangler) {
        if (setup.liveBeforeFailing) {
          api.active.set(spec.script, [{ version_id: `${spec.app}-new`, percentage: 100 }]);
        }
        throw new Error("wrangler exited with 1");
      }
      if (spec.script === "kelpie-ingress") {
        production.serving = next;
        if (secrets?.content.DEPLOY_PROBE_TOKEN) {
          production.deep = {
            token: secrets.content.DEPLOY_PROBE_TOKEN,
            ...(setup.deepParts ? { parts: setup.deepParts } : {}),
          };
        }
      }
      if (setup.brokenAfterDeploy) production.telegram = 503;
      return `${spec.app}-new`;
    },
  };
  return { api, deps, wranglerCalls, masked, production, warnings };
}

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef";
const withToken = { ...options, deepProbeToken: TOKEN };

describe("planDeploy", () => {
  it("tags HEAD, reads the live versions and finds the probes' origin", async () => {
    const { deps } = harness({});
    const plan = await planDeploy(deps);
    expect(plan.tag).toEqual(next);
    expect(plan.message).toBe("abc1234 Add a feature (#300)");
    expect(plan.origin).toBe(ORIGIN);
    expect(plan.live.map((worker) => worker.tag)).toEqual(WORKERS.map(() => live));
    expect(plan.barriers).toEqual([]);
  });

  it("carries only the vars the owner set, not the repository's defaults", async () => {
    const { deps } = harness({});
    const gateway = "https://gateway.ai.cloudflare.com/v1/account/kelpie/openai";
    deps.api = fakeApi({
      live,
      vars: {
        "kelpie-llm-gateway": {
          ANTHROPIC_BASE_URL: "https://api.anthropic.com",
          OPENAI_BASE_URL: gateway,
        },
      },
    });
    const config = JSON.stringify({
      vars: {
        ANTHROPIC_BASE_URL: "https://api.anthropic.com",
        OPENAI_BASE_URL: "https://api.openai.com/v1",
      },
    });
    deps.git = (args) => (args[0] === "show" ? config : quietGit(args));
    const plan = await planDeploy(deps);
    expect(plan.live[0]?.vars).toEqual({ OPENAI_BASE_URL: gateway });
  });

  it("stops when the token can't read analytics", async () => {
    const { deps } = harness({
      invocations: () => {
        throw new CloudflareError("Cloudflare GraphQL query failed (403)", []);
      },
    });
    await expect(planDeploy(deps)).rejects.toThrow("Account Analytics Read");
  });

  it("refuses a working tree with changes", async () => {
    const { deps } = harness({});
    const dirty = {
      ...deps,
      git: (args: readonly string[]) => (args[0] === "status" ? " M x\n" : deps.git(args)),
    };
    await expect(planDeploy(dirty)).rejects.toThrow("clean checkout");
  });
});

describe("deploy", () => {
  it("deploys every Worker in order with the tag and its carried vars, then keeps a healthy release", async () => {
    const { deps, wranglerCalls, masked, api } = harness({});
    const plan = await planDeploy(deps);
    const report = await deploy(deps, plan, options);

    expect(report.outcome).toBe("deployed");
    expect(wranglerCalls.map((call) => call.spec.script)).toEqual(
      WORKERS.map((worker) => worker.script),
    );
    expect(wranglerCalls[1]?.args).toEqual([
      "deploy",
      "--tag",
      "96-abc1234",
      "--message",
      "abc1234 Add a feature (#300)",
      "--var",
      `INGRESS_ORIGIN:${ORIGIN}`,
    ]);
    expect(masked).toContain(ORIGIN);
    expect(report.workers.every((worker) => worker.deployed?.endsWith("-new"))).toBe(true);
    expect(api.made).toEqual([]);
  });

  it("rolls back the Workers already deployed when one fails to deploy, in reverse order", async () => {
    const { deps, api } = harness({ failWrangler: "kelpie-context-store" });
    const report = await deploy(deps, await planDeploy(deps), options);

    expect(report.outcome).toBe("rolled-back");
    expect(report.reason).toBe("kelpie-context-store didn't deploy: wrangler exited with 1");
    expect(api.made.map((deployment) => deployment.script)).toEqual([
      "kelpie-channel-egress",
      "kelpie-llm-gateway",
    ]);
    expect(api.made[0]).toMatchObject({
      traffic: [{ version_id: "channel-egress-95-25c5076", percentage: 100 }],
      message: "Automatic rollback of 96-abc1234",
      force: false,
    });
  });

  it("rolls back a Worker that went live although wrangler failed", async () => {
    const { deps, api } = harness({
      failWrangler: "kelpie-context-store",
      liveBeforeFailing: true,
    });
    const report = await deploy(deps, await planDeploy(deps), options);

    expect(report.workers[2]?.deployed).toBe("context-store-new");
    expect(api.made.map((deployment) => deployment.script)).toEqual([
      "kelpie-context-store",
      "kelpie-channel-egress",
      "kelpie-llm-gateway",
    ]);
  });

  it("rolls the whole release back when the probes fail, and checks the old build answers", async () => {
    const { deps, api, production } = harness({ brokenAfterDeploy: true });
    const report = await deploy(deps, await planDeploy(deps), options);

    expect(report.outcome).toBe("rolled-back");
    expect(report.reason).toContain("telegram-webhook answered 503");
    expect(api.made).toHaveLength(6);
    expect(production.serving).toEqual(live);
    expect(report.probes.every((probe) => probe.outcome === "pass")).toBe(true);
  });

  it("rolls back when the new versions fail invocations during the watch", async () => {
    const { deps, api } = harness({
      invocations: () => [
        {
          dataset: "workers",
          script: "kelpie-llm-gateway",
          status: "exceededResources",
          requests: 5,
        },
      ],
    });
    const report = await deploy(deps, await planDeploy(deps), options);
    expect(report.outcome).toBe("rolled-back");
    expect(report.errors).toEqual({ "kelpie-llm-gateway": 5 });
    expect(api.made).toHaveLength(6);
  });

  it("doesn't roll back across a barrier", async () => {
    const { deps, api } = harness({ brokenAfterDeploy: true });
    const plan = await planDeploy(deps);
    plan.barriers = [
      { script: "kelpie-ingress", kind: "destructive-sql", detail: "x.sql: drops a column" },
    ];
    const report = await deploy(deps, plan, options);

    expect(report.outcome).toBe("failed");
    expect(report.reason).toContain("Not rolled back automatically");
    expect(api.made).toEqual([]);
  });

  it("reports the Workers a rollback couldn't restore", async () => {
    const { deps } = harness({ brokenAfterDeploy: true, failRestore: "kelpie-admin-api" });
    const report = await deploy(deps, await planDeploy(deps), options);
    expect(report.outcome).toBe("failed");
    expect(report.reason).toContain("The automatic rollback failed for kelpie-admin-api");
    expect(report.rollback.filter((result) => result.ok)).toHaveLength(5);
  });

  it("leaves the release alone when the zone's security blocks the probes", async () => {
    const { deps, api, production } = harness({});
    const plan = await planDeploy(deps);
    const blocked = {
      ...deps,
      fetch: fakeProduction({ serving: production.serving, mitigated: true }),
    };
    const report = await deploy(blocked, plan, options);
    expect(report.outcome).toBe("failed");
    expect(report.reason).toContain("Nothing was rolled back");
    expect(api.made).toEqual([]);
  });
});

describe("the deep probe", () => {
  it("gives ingress alone the token, through a private file deleted after its deploy", async () => {
    const { deps, wranglerCalls, masked } = harness({});
    const report = await deploy(deps, await planDeploy(deps), withToken);

    expect(report.outcome).toBe("deployed");
    const withSecrets = wranglerCalls.filter((call) => call.secrets);
    expect(withSecrets.map((call) => call.spec.script)).toEqual(["kelpie-ingress"]);
    const secrets = withSecrets[0]?.secrets;
    expect(secrets).toMatchObject({ content: { DEPLOY_PROBE_TOKEN: TOKEN }, mode: 0o600 });
    expect(withSecrets[0]?.args).toEqual([
      "deploy",
      "--tag",
      "96-abc1234",
      "--message",
      "abc1234 Add a feature (#300)",
      "--secrets-file",
      secrets?.path,
    ]);
    expect(existsSync(secrets?.path ?? "")).toBe(false);
    expect(masked).toContain(TOKEN);
    expect(report.probes.find((probe) => probe.probe === "deep")?.outcome).toBe("pass");
  });

  it("deletes the file when wrangler fails too", async () => {
    const { deps, wranglerCalls } = harness({ failWrangler: "kelpie-ingress" });
    await deploy(deps, await planDeploy(deps), withToken);
    const ingress = wranglerCalls.find((call) => call.spec.script === "kelpie-ingress");
    expect(ingress?.secrets?.content).toEqual({ DEPLOY_PROBE_TOKEN: TOKEN });
    expect(existsSync(ingress?.secrets?.path ?? "")).toBe(false);
  });

  it("rolls the release back when a part fails, then checks the old build without it", async () => {
    const { deps, api, production } = harness({ deepParts: { agentHosts: "failed" } });
    const report = await deploy(deps, await planDeploy(deps), withToken);

    expect(report.outcome).toBe("rolled-back");
    expect(report.reason).toContain("deep failed: agentHosts");
    expect(production.serving).toEqual(live);
    // The old build has no probe route: its check is the four probes it can answer.
    expect(report.probes.map((probe) => probe.probe)).toEqual([
      "health",
      "version",
      "telegram-webhook",
      "github-webhook",
    ]);
    expect(report.probes.every((probe) => probe.outcome === "pass")).toBe(true);
    // Ingress's secret changed with this deploy, so only its rollback is forced.
    expect(api.made.filter((made) => made.force).map((made) => made.script)).toEqual([
      "kelpie-ingress",
    ]);
    expect(api.made).toHaveLength(6);
  });

  it("is skipped with one warning when the token isn't set, and uploads nothing", async () => {
    const { deps, wranglerCalls, warnings, api } = harness({ brokenAfterDeploy: true });
    const report = await deploy(deps, await planDeploy(deps), options);

    expect(wranglerCalls.some((call) => call.args.includes("--secrets-file"))).toBe(false);
    expect(warnings.filter((warning) => warning.includes("deep probe is skipped"))).toHaveLength(1);
    expect(report.probes.map((probe) => probe.probe)).not.toContain("deep");
    expect(api.made.some((made) => made.force)).toBe(false);
  });
});

describe("deepProbeToken", () => {
  it("is optional, and trimmed", () => {
    expect(deepProbeToken(undefined)).toBeUndefined();
    expect(deepProbeToken("")).toBeUndefined();
    expect(deepProbeToken(" \n")).toBeUndefined();
    expect(deepProbeToken(`${TOKEN}\n`)).toBe(TOKEN);
  });

  it("refuses a short token, or one with spaces, before anything deploys", () => {
    expect(() => deepProbeToken("short")).toThrow("at least 32 printable characters");
    expect(() => deepProbeToken(`${TOKEN} ${TOKEN}`)).toThrow("without spaces");
  });
});

describe("reports", () => {
  it("name builds and versions, never the instance's hostnames or vars", async () => {
    const { deps } = harness({ brokenAfterDeploy: true });
    const plan = await planDeploy(deps);
    const text = deployPlanReport(plan) + deployReport(await deploy(deps, plan, options));
    expect(text).toContain("96-abc1234");
    expect(text).not.toContain("example.com");
  });
});

describe("deployedVersion", () => {
  it("reads the version id from wrangler's output file", () => {
    const ndjson = [
      '{"type":"wrangler-session","version":1,"wrangler_version":"4.147.0"}',
      '{"type":"deploy","version":1,"worker_name":"kelpie-ingress","version_id":"a1b2"}',
      "",
    ].join("\n");
    expect(deployedVersion(ndjson)).toBe("a1b2");
    expect(deployedVersion('{"type":"command-failed"}\n')).toBeUndefined();
  });
});
