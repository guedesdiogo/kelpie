import { describe, expect, it } from "vitest";
import { planDeploy } from "../src/deploy.ts";
import { readLive } from "../src/live.ts";
import { deployReport, rollbackPlanReport, rollbackReport, statusReport } from "../src/report.ts";
import { planRollback } from "../src/rollback.ts";
import { fakeApi, fakeClock, ORIGIN, quietGit } from "./fakes.ts";

const live = { build: 95, commit: "25c5076" };
const previous = { build: 94, commit: "cc8e179" };

describe("reports", () => {
  it("show a deploy that rolled back, with what each Worker went back to", async () => {
    const api = fakeApi({ live });
    const plan = await planDeploy({ api, git: quietGit, ...fakeClock() });
    const text = deployReport({
      tag: plan.tag,
      outcome: "rolled-back",
      reason: "probes failed: telegram-webhook answered 503",
      workers: plan.live.map((worker) => ({
        script: worker.spec.script,
        previous: [
          { version_id: "aaaaaaaa-1", percentage: 90 },
          { version_id: "bbbbbbbb-2", percentage: 10 },
        ],
        previousTag: worker.tag,
        deployed: worker.spec.script === "kelpie-admin-api" ? null : "cccccccc-3",
      })),
      barriers: [
        { script: "kelpie-ingress", kind: "unknown", detail: "a version has no build tag" },
      ],
      probes: [{ probe: "health", outcome: "pass", detail: "answered 200" }],
      errors: { "kelpie-ingress": 2 },
      analytics: false,
      rollback: [
        { script: "kelpie-ingress", ok: true },
        { script: "kelpie-llm-gateway", ok: false, detail: "refused" },
      ],
    });
    expect(text).toContain("## Deploy of 96-abc1234: rolled back automatically");
    expect(text).toContain(
      "| kelpie-admin-api | 95-25c5076 (`aaaaaaaa` 90% + `bbbbbbbb` 10%) | no |",
    );
    expect(text).toContain("(analytics unavailable)");
    expect(text).toContain("- kelpie-ingress: 2");
    expect(text).toContain("- kelpie-llm-gateway: failed, refused");
    expect(text).toContain("- kelpie-ingress (unknown): a version has no build tag");
    expect(text).not.toContain(ORIGIN);
  });

  it("show a rollback plan, a rollback whose probes fail, and the status", async () => {
    const api = fakeApi({ live, versions: [previous] });
    const plan = await planRollback({ api, git: quietGit }, "previous");
    expect(rollbackPlanReport(plan)).toContain(
      "| kelpie-ingress | 95-25c5076 (`ingress-`) | `ingress-` |",
    );
    expect(rollbackPlanReport({ ...plan, moves: [] })).toContain("Every Worker already serves it.");

    const text = rollbackReport({
      target: previous,
      reason: "replies come out empty",
      moved: [
        {
          script: "kelpie-ingress",
          from: [{ version_id: "dddddddd-4", percentage: 100 }],
          to: "eeeeeeee-5",
        },
      ],
      barriers: [],
      probes: [],
      verdict: { status: "unhealthy", reason: "probes failed: health answered 500" },
    });
    expect(text).toContain("## Rollback to 94-cc8e179: done, but the probes don't pass");
    expect(text).toContain("Why: replies come out empty");
    expect(text).toContain("probes failed: health answered 500");
    expect(text).toContain("- not run");

    const status = statusReport(await readLive(api), [live, previous]);
    expect(status).toContain("| kelpie-ingress | 95-25c5076 | `ingress-` |");
    expect(status).toContain("newest first): 95-25c5076, 94-cc8e179");
    expect(status).not.toContain(ORIGIN);
  });
});
