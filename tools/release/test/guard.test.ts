import { describe, expect, it } from "vitest";
import { guardVerdict } from "../src/guard.ts";
import type { Finding } from "../src/migrations.ts";

const finding = (kind: Finding["kind"], acknowledged: boolean): Finding => ({
  app: "conversation-runtime",
  file: "apps/conversation-runtime/src/migrations/0014_x.sql",
  kind,
  detail: "drops a column",
  acknowledged,
});

describe("guardVerdict", () => {
  it("passes a change with no migrations", () => {
    expect(guardVerdict({ problems: [], findings: [] })).toEqual({ annotations: [], blocking: 0 });
  });

  it("blocks problems and unacknowledged barriers, and names the marker to add", () => {
    const { annotations, blocking } = guardVerdict({
      problems: ["d: journal out of order"],
      findings: [finding("destructive-sql", false), finding("destructive-class", false)],
    });
    expect(blocking).toBe(3);
    expect(annotations.map((annotation) => annotation.level)).toEqual(["error", "error", "error"]);
    expect(annotations[1]?.message).toContain('"-- rollback-barrier: <reason>"');
    expect(annotations[2]?.message).toContain('"// rollback-barrier: <reason>"');
  });

  it("only warns on acknowledged barriers and new classes", () => {
    const { annotations, blocking } = guardVerdict({
      problems: [],
      findings: [finding("destructive-sql", true), finding("class-change", true)],
    });
    expect(blocking).toBe(0);
    expect(annotations.map((annotation) => annotation.level)).toEqual(["warning", "warning"]);
    expect(annotations[1]?.message).toContain("Cloudflare can't roll production back");
  });
});
