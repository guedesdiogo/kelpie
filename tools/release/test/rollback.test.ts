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

    expect(api.deployments.map((deployment) => deployment.script)).toEqual(
      WORKERS.map((worker) => worker.script).reverse(),
    );
    expect(api.deployments[0]).toMatchObject({
      traffic: [{ version_id: "admin-api-94-cc8e179", percentage: 100 }],
      message: "Rollback to 94-cc8e179: a bad reply",
      force: false,
    });
    expect(report.verdict).toEqual({ status: "healthy" });
    expect(report.moved.map((move) => move.script)).toEqual(WORKERS.map((worker) => worker.script));
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
    expect(api.deployments).toEqual([]);
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
    expect(api.deployments).toEqual([]);
    await rollback(deps(api), plan, { force: true, reason: "r", settle: settleOptions });
    expect(api.deployments).toHaveLength(6);
  });

  it("asks for force when a Worker's secrets changed, and undoes the Workers already moved", async () => {
    const api = fakeApi({
      live,
      versions: [previous],
      failDeploy: (script, force) =>
        script === "kelpie-llm-gateway" && !force
          ? new CloudflareError("secrets changed", [SECRETS_CHANGED])
          : undefined,
    });
    const plan = await planRollback({ api, git: quietGit }, "previous");
    await expect(
      rollback(deps(api), plan, { force: false, reason: "r", settle: settleOptions }),
    ).rejects.toThrow("kelpie-llm-gateway's secrets changed since 94-cc8e179");
    // Five Workers moved; the undo puts them back on 95, in deploy order.
    const undone = api.deployments.slice(5);
    expect(undone.map((deployment) => deployment.traffic[0]?.version_id)).toEqual(
      [
        "admin-api-95-25c5076",
        "ingress-95-25c5076",
        "conversation-runtime-95-25c5076",
        "context-store-95-25c5076",
        "channel-egress-95-25c5076",
      ].reverse(),
    );

    const forced = fakeApi({
      live,
      versions: [previous],
      failDeploy: (script, force) =>
        script === "kelpie-llm-gateway" && !force
          ? new CloudflareError("secrets changed", [SECRETS_CHANGED])
          : undefined,
    });
    const forcedPlan = await planRollback({ api: forced, git: quietGit }, "previous");
    await rollback(deps(forced), forcedPlan, { force: true, reason: "r", settle: settleOptions });
    expect(forced.deployments.at(-1)).toMatchObject({ script: "kelpie-llm-gateway", force: true });
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
});
