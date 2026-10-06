import { describe, expect, it } from "vitest";
import { KELPIE_RELEASE, versionReport } from "../src/version.ts";

const metadata = (tag: string) => ({ id: "58caf3df-92aa", tag, timestamp: "2026-10-06T22:19:00Z" });

describe("versionReport", () => {
  it("adds the deploy's build to the release, and names its commit, version and time", () => {
    expect(KELPIE_RELEASE).toMatch(/^\d+\.\d+$/);
    expect(versionReport(metadata("66-0c620f4"))).toEqual({
      version: `${KELPIE_RELEASE}.66`,
      build: 66,
      commit: "0c620f4",
      deployment: "58caf3df-92aa",
      deployedAt: "2026-10-06T22:19:00Z",
    });
  });

  it("gives the release alone when the deploy's tag carries no build", () => {
    // Deploys before the build number were tagged with the commit only.
    expect(versionReport(metadata("6bf39de"))).toMatchObject({
      version: KELPIE_RELEASE,
      build: null,
      commit: "6bf39de",
    });
    expect(versionReport(metadata(""))).toMatchObject({
      version: KELPIE_RELEASE,
      build: null,
      commit: null,
    });
    expect(versionReport(undefined)).toEqual({
      version: KELPIE_RELEASE,
      build: null,
      commit: null,
      deployment: null,
      deployedAt: null,
    });
  });
});
