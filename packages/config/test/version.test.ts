import { describe, expect, it } from "vitest";
import { KELPIE_VERSION, versionReport } from "../src/version.ts";

describe("versionReport", () => {
  it("names the version, and the deploy's commit, version and time from the Worker's metadata", () => {
    expect(KELPIE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(
      versionReport({ id: "58caf3df-92aa", tag: "6bf39de", timestamp: "2026-10-06T22:19:00Z" }),
    ).toEqual({
      version: KELPIE_VERSION,
      commit: "6bf39de",
      deployment: "58caf3df-92aa",
      deployedAt: "2026-10-06T22:19:00Z",
    });
  });

  it("leaves out what a deploy didn't give: no tag, or no metadata at all", () => {
    expect(versionReport({ id: "58caf3df", tag: "", timestamp: "2026-10-06T22:19:00Z" })).toEqual({
      version: KELPIE_VERSION,
      commit: null,
      deployment: "58caf3df",
      deployedAt: "2026-10-06T22:19:00Z",
    });
    expect(versionReport(undefined)).toEqual({
      version: KELPIE_VERSION,
      commit: null,
      deployment: null,
      deployedAt: null,
    });
  });
});
