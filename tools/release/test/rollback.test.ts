import { describe, expect, it } from "vitest";
import { CloudflareError, SECRETS_CHANGED } from "../src/cloudflare.ts";
import { planRollback, RollbackRefused, rollback } from "../src/rollback.ts";
import { WORKERS } from "../src/workers.ts";
import { fakeApi, fakeProduction, noSleep, quietGit, silentLog } from "./fakes.ts";

const live = { build: 95, commit: "25c5076" };
const previous = { build: 94, commit: "cc8e179" };
const older = { build: 93, commit: "37c5f21" };
const settleOptions = { attempts: 2, intervalMs: 10 };

function deps(api: ReturnType<typeof fakeApi>, serving = previous) {
  return { api, fetch: fakeProduction({ serving }), sleep: noSleep, log: silentLog };
}

describe("planRollback", () => {
  it("resolves previous to the build before the live one, on every Worker", async () => {
    const api = fakeApi({ live, versions: [previous, older] });
    const plan = await planRollback({ api, git: quietGit }, "previous");
    expect(plan.target).toEqual(previous);
    expect(plan.moves.map((move) => [move.spec.script, move.to])).toEqual(
      WORKERS.map((worker) => [worker.script, `${worker.app}-94-cc8e179`]),
    );
    expect(plan.barriers).toEqual([]);
  });

  it("refuses a target one Worker no longer has", async () => {
    const api = fakeApi({
      live,
      versions: [previous],
      missing: { script: "kelpie-admin-api", tag: previous },
    });
    await expect(planRollback({ api, git: quietGit }, "94")).rejects.toThrow(
      "kelpie-admin-api has no deployable version tagged 94-cc8e179",
    );
  });

  it("names the recent builds when nothing matches", async () => {
    const api = fakeApi({ live, versions: [previous] });
    await expect(planRollback({ api, git: quietGit }, "50")).rejects.toThrow(
      "Recent builds: 95-25c5076, 94-cc8e179",
    );
    await expect(planRollback({ api, git: quietGit }, "latest")).rejects.toThrow(RollbackRefused);
  });

  it("goes back to the commit a release's tag names", async () => {
    const api = fakeApi({ live, versions: [previous, older] });
    const git = (args: readonly string[]) => {
      if (args.at(-1) === "refs/tags/v1.2.0^{commit}")
        return "cc8e1791d2a6b0e9f1c3a5b7d9e1f3a5b7c9d1e3\n";
      if (args[0] === "rev-parse" && args.includes("--verify")) throw new Error("unknown revision");
      return quietGit(args);
    };
    expect((await planRollback({ api, git }, "v1.2.0")).target).toEqual(previous);
    await expect(planRollback({ api, git }, "v9.9.9")).rejects.toThrow(
      "There's no release tag v9.9.9.",
    );
  });

  it("says when a release shipped nothing, rather than only that nothing matches", async () => {
    const api = fakeApi({ live, versions: [previous] });
    // v1.3.0 changed only docs: its deploy skipped, so no version carries its commit.
    const git = (args: readonly string[]) =>
      args.at(-1) === "refs/tags/v1.3.0^{commit}"
        ? "d0c5d0c5d0c5d0c5d0c5d0c5d0c5d0c5d0c5d0c5\n"
        : quietGit(args);
    await expect(planRollback({ api, git }, "v1.3.0")).rejects.toThrow(
      "v1.3.0 names d0c5d0c, which no version of kelpie-ingress carries: that release shipped nothing",
    );
  });

  it("moves nothing when production already serves the target", async () => {
    const api = fakeApi({ live, versions: [previous] });
    expect((await planRollback({ api, git: quietGit }, "95-25c5076")).moves).toEqual([]);
  });
});

describe("rollback", () => {
  it("moves every Worker in reverse order and checks the target answers", async () => {
    const api = fakeApi({ live, versions: [previous] });
    const plan = await planRollback({ api, git: quietGit }, "previous");
    const report = await rollback(deps(api), plan, {
      force: false,
      reason: "a bad reply",
      settle: settleOptions,
    });

    expect(api.made.map((deployment) => deployment.script)).toEqual(
      WORKERS.map((worker) => worker.script).reverse(),
    );
    expect(api.made[0]).toMatchObject({
      traffic: [{ version_id: "admin-api-94-cc8e179", percentage: 100 }],
      message: "Rollback to 94-cc8e179: a bad reply",
      force: false,
    });
    expect(report.verdict).toEqual({ status: "healthy" });
    expect(report.moved.map((move) => move.script)).toEqual(WORKERS.map((worker) => worker.script));
    // No deep probe: an older build may have no route for it (#234).
    expect(report.probes.map((probe) => probe.probe)).toEqual([
      "health",
      "version",
      "telegram-webhook",
      "github-webhook",
    ]);
  });

  it("refuses to cross a class migration, even with force", async () => {
    const api = fakeApi({ live, versions: [previous] });
    const plan = await planRollback({ api, git: quietGit }, "previous");
    plan.barriers = [
      { script: "kelpie-ingress", kind: "class-change", detail: 'class migration "v2" adds X' },
    ];
    await expect(
      rollback(deps(api), plan, { force: true, reason: "r", settle: settleOptions }),
    ).rejects.toThrow("Cloudflare refuses rollbacks across a Durable Object class migration");
    expect(api.made).toEqual([]);
  });

  it("crosses a destructive SQL migration only with force", async () => {
    const api = fakeApi({ live, versions: [previous] });
    const plan = await planRollback({ api, git: quietGit }, "previous");
    plan.barriers = [
      { script: "kelpie-ingress", kind: "destructive-sql", detail: "x.sql: drops a column" },
    ];
    await expect(
      rollback(deps(api), plan, { force: false, reason: "r", settle: settleOptions }),
    ).rejects.toThrow("Run it with force");
    expect(api.made).toEqual([]);
    await rollback(deps(api), plan, { force: true, reason: "r", settle: settleOptions });
    expect(api.made).toHaveLength(6);
  });

  it("asks for force when a Worker's secrets changed, and undoes the Workers already moved", async () => {
    const api = fakeApi({
      live,
      versions: [previous],
      failDeploy: (script, force) =>
        script === "kelpie-channel-egress" && !force
          ? new CloudflareError("secrets changed", [SECRETS_CHANGED])
          : undefined,
    });
    const plan = await planRollback({ api, git: quietGit }, "previous");
    await expect(
      rollback(deps(api), plan, { force: false, reason: "r", settle: settleOptions }),
    ).rejects.toThrow("kelpie-channel-egress's secrets changed since 94-cc8e179");
    // Five Workers moved; the undo puts them back on 95, in deploy order.
    const undone = api.made.slice(5);
    expect(undone.map((deployment) => deployment.traffic[0]?.version_id)).toEqual(
      [
        "admin-api-95-25c5076",
        "ingress-95-25c5076",
        "conversation-runtime-95-25c5076",
        "context-store-95-25c5076",
        "llm-gateway-95-25c5076",
      ].reverse(),
    );

    const forced = fakeApi({
      live,
      versions: [previous],
      failDeploy: (script, force) =>
        script === "kelpie-channel-egress" && !force
          ? new CloudflareError("secrets changed", [SECRETS_CHANGED])
          : undefined,
    });
    const forcedPlan = await planRollback({ api: forced, git: quietGit }, "previous");
    const report = await rollback(deps(forced), forcedPlan, {
      force: true,
      reason: "r",
      settle: settleOptions,
    });
    expect(forced.made.at(-1)).toMatchObject({ script: "kelpie-channel-egress", force: true });
    expect(report.warnings).toEqual([]);
  });

  it("warns that forcing ingress back restored that build's deploy probe token", async () => {
    const api = fakeApi({ live, versions: [previous], secretsChanged: ["kelpie-ingress"] });
    const plan = await planRollback({ api, git: quietGit }, "previous");
    await expect(
      rollback(deps(api), plan, { force: false, reason: "r", settle: settleOptions }),
    ).rejects.toThrow("kelpie-ingress's secrets changed since 94-cc8e179");

    const forced = fakeApi({ live, versions: [previous], secretsChanged: ["kelpie-ingress"] });
    const forcedPlan = await planRollback({ api: forced, git: quietGit }, "previous");
    const report = await rollback(deps(forced), forcedPlan, {
      force: true,
      reason: "r",
      settle: settleOptions,
    });
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain(
      "kelpie-ingress now holds its secrets from 94-cc8e179, DEPLOY_PROBE_TOKEN included",
    );
  });

  it("reports probes that still fail after the rollback", async () => {
    const api = fakeApi({ live, versions: [previous] });
    const plan = await planRollback({ api, git: quietGit }, "previous");
    const report = await rollback(deps(api, live), plan, {
      force: false,
      reason: "r",
      settle: settleOptions,
    });
    expect(report.verdict).toMatchObject({ status: "unhealthy" });
  });

  it("undoes a forced partial rollback with force too", async () => {
    const api = fakeApi({
      live,
      versions: [previous],
      failDeploy: (script, force) => {
        if (script === "kelpie-channel-egress") return new CloudflareError("internal", [10000]);
        return force ? undefined : new CloudflareError("secrets changed", [SECRETS_CHANGED]);
      },
    });
    const plan = await planRollback({ api, git: quietGit }, "previous");
    await expect(
      rollback(deps(api), plan, { force: true, reason: "r", settle: settleOptions }),
    ).rejects.toThrow("Nothing was rolled back");
    expect(api.made.slice(5).every((deployment) => deployment.force)).toBe(true);
    expect(api.active.get("kelpie-ingress")?.[0]?.version_id).toBe("ingress-95-25c5076");
  });
});

describe("previous", () => {
  it("is the build served before the live one, even when a higher one was rolled back", async () => {
    // 100 deployed and was rolled back to 99; then 101 went out.
    const v101 = { build: 101, commit: "aaaaaaa" };
    const v100 = { build: 100, commit: "bbbbbbb" };
    const v99 = { build: 99, commit: "ccccccc" };
    const api = fakeApi({ live: v101, versions: [v100, v99], history: [v99, v100, v99] });
    expect((await planRollback({ api, git: quietGit }, "previous")).target).toEqual(v99);
  });

  it("asks for a build when the history has none before the live one", async () => {
    const api = fakeApi({ live, versions: [previous], history: [] });
    await expect(planRollback({ api, git: quietGit }, "previous")).rejects.toThrow(
      "Name a build instead",
    );
  });
});
