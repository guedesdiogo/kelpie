import { describe, expect, it } from "vitest";
import { CloudflareError } from "../src/cloudflare.ts";
import { type DeployDeps, deploy, deployedVersion, planDeploy } from "../src/deploy.ts";
import { buildTagOf, type Git, gitAt } from "../src/git.ts";
import { deployPlanReport, deployReport } from "../src/report.ts";
import { type BuildTag, formatTag } from "../src/tags.ts";
import { WORKERS, type WorkerSpec } from "../src/workers.ts";
import {
  type FakeApi,
  fakeApi,
  fakeClock,
  fakeProduction,
  ORIGIN,
  quietGit,
  silentLog,
  tempRepo,
} from "./fakes.ts";

const live = { build: 95, commit: "25c5076" };
const next = { build: 96, commit: "abc1234" };
const options = {
  settle: { attempts: 3, intervalMs: 10_000 },
  watch: { minutes: 2, intervalMs: 60_000, errorThreshold: 3, failuresInARow: 3 },
};

/** quietGit, with a change that ships between the live build and HEAD. */
const shippingGit: Git = (args) =>
  args[0] === "diff" ? "M\tapps/ingress/src/index.ts\n" : quietGit(args);

/** Production as deploys change it: ingress serves whichever build was deployed or restored last. */
function harness(setup: {
  failWrangler?: string;
  /** The failing Worker's new version went live before wrangler failed. */
  liveBeforeFailing?: boolean;
  brokenAfterDeploy?: boolean;
  failRestore?: string;
  invocations?: Parameters<typeof fakeApi>[0]["invocations"];
}) {
  const production: { serving: BuildTag | null; telegram: number } = {
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
    if (script === "kelpie-ingress") production.serving = live;
    production.telegram = 401;
  };
  const wranglerCalls: Array<{ spec: WorkerSpec; args: string[] }> = [];
  const masked: string[] = [];
  const deps: DeployDeps = {
    api,
    git: shippingGit,
    fetch: fakeProduction(production),
    ...fakeClock(),
    log: silentLog,
    mask: (value) => masked.push(value),
    async wranglerDeploy(spec, args) {
      wranglerCalls.push({ spec, args });
      if (spec.script === setup.failWrangler) {
        if (setup.liveBeforeFailing) {
          api.active.set(spec.script, [{ version_id: `${spec.app}-new`, percentage: 100 }]);
        }
        throw new Error("wrangler exited with 1");
      }
      if (spec.script === "kelpie-ingress") production.serving = next;
      if (setup.brokenAfterDeploy) production.telegram = 503;
      return `${spec.app}-new`;
    },
  };
  return { api, deps, wranglerCalls, masked, production };
}

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
    deps.git = (args) => (args[0] === "show" ? config : shippingGit(args));
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

/** Makes one Worker's live version carry another tag, or none. */
function serve(api: FakeApi, script: string, tag: BuildTag | null) {
  const version = api.version.bind(api);
  api.version = async (name, id) => {
    const found = await version(name, id);
    if (name !== script) return found;
    return { ...found, annotations: tag ? { "workers/tag": formatTag(tag) } : {} };
  };
}

// A real repository: each plan runs a few dozen git commands, which take seconds on a busy machine.
describe("planDeploy's skip, against the builds production serves (ADR-0031)", {
  timeout: 20_000,
}, () => {
  /** A repository whose first commit changes something that ships and something that doesn't. */
  function history() {
    const repo = tempRepo();
    return {
      repo,
      base: repo.commit({ "apps/ingress/src/index.ts": "v1", "docs/deploy.md": "a" }),
    };
  }

  /** HEAD as checked out in `dir`, with every Worker live on `liveCommit`'s build. */
  function setup(
    dir: string,
    liveCommit: string,
    overrides: Partial<Parameters<typeof fakeApi>[0]> = {},
  ) {
    const git = gitAt(dir);
    const liveTag = buildTagOf(git, liveCommit);
    const api = fakeApi({ live: liveTag, ...overrides });
    const production: { serving: BuildTag | null } = { serving: liveTag };
    const wranglerCalls: string[] = [];
    const deps: DeployDeps = {
      api,
      git,
      fetch: fakeProduction(production),
      ...fakeClock(),
      log: silentLog,
      mask: () => {},
      async wranglerDeploy(spec) {
        wranglerCalls.push(spec.script);
        if (spec.script === "kelpie-ingress") production.serving = buildTagOf(git, "HEAD");
        return `${spec.app}-new`;
      },
    };
    return { api, deps, liveTag, wranglerCalls };
  }

  it("skips when production already serves HEAD, and doesn't read the analytics", async () => {
    const { repo, base } = history();
    const { deps, liveTag } = setup(repo.dir, base, {
      invocations: () => {
        throw new CloudflareError("Cloudflare GraphQL query failed (403)", []);
      },
    });
    const plan = await planDeploy(deps);
    expect(plan.skip).toBe(
      `Nothing that ships changed since ${formatTag(liveTag)}, which production serves.`,
    );
  });

  it("skips when only docs, the README or ci.yml changed since the live build", async () => {
    const { repo, base } = history();
    repo.commit({ "docs/deploy.md": "b" });
    repo.commit({ "README.md": "x", ".github/workflows/ci.yml": "on: push" });
    const { deps, wranglerCalls, api } = setup(repo.dir, base);
    const plan = await planDeploy(deps);
    expect(plan.skip).toContain("Nothing that ships changed since");
    expect(deployPlanReport(plan)).toContain(`Skips: ${plan.skip}`);

    const report = await deploy(deps, plan, options);
    expect(report.outcome).toBe("skipped");
    expect(report.reason).toBe(plan.skip);
    expect(wranglerCalls).toEqual([]);
    expect(api.made).toEqual([]);
    expect(deployReport(report)).toContain(`## Deploy of ${formatTag(plan.tag)}: skipped`);
  });

  it("deploys a change that ships since the live build, even under later docs-only commits", async () => {
    const { repo, base } = history();
    repo.commit({ "apps/ingress/src/index.ts": "v2" }, "A: ships");
    repo.commit({ "docs/deploy.md": "b" }, "B: docs only");
    const { deps, wranglerCalls } = setup(repo.dir, base);
    const plan = await planDeploy(deps);
    expect(plan.skip).toBeUndefined();
    expect((await deploy(deps, plan, options)).outcome).toBe("deployed");
    expect(wranglerCalls).toEqual(WORKERS.map((worker) => worker.script));
  });

  it("deploys when any Worker serves an older build with a change that ships since", async () => {
    const { repo, base } = history();
    const shipped = repo.commit({ "packages/config/src/index.ts": "x" });
    repo.commit({ "docs/deploy.md": "b" });
    const { deps, api } = setup(repo.dir, shipped);
    serve(api, "kelpie-admin-api", buildTagOf(deps.git, base));
    expect((await planDeploy(deps)).skip).toBeUndefined();
  });

  it("deploys when a live version has no tag, or names a commit this checkout lacks", async () => {
    const { repo, base } = history();
    const untagged = setup(repo.dir, base);
    serve(untagged.api, "kelpie-llm-gateway", null);
    expect((await planDeploy(untagged.deps)).skip).toBeUndefined();

    const unknown = setup(repo.dir, base);
    serve(unknown.api, "kelpie-llm-gateway", { build: 1, commit: "1234567" });
    expect((await planDeploy(unknown.deps)).skip).toBeUndefined();
  });

  it("deploys regardless with always, as deploy.yml by hand does", async () => {
    const { repo, base } = history();
    const { deps } = setup(repo.dir, base);
    expect((await planDeploy(deps, { always: true })).skip).toBeUndefined();
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
