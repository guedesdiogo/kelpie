import { exports } from "cloudflare:workers";
import { KELPIE_RELEASE } from "@kelpie/config";
import { describe, expect, it } from "vitest";

describe("ingress", () => {
  it("answers GET /health with 200 and a JSON status", async () => {
    const response = await exports.default.fetch("https://ingress.test/health");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("answers GET /version with Kelpie's version and what the deploy says about itself", async () => {
    const response = await exports.default.fetch("https://ingress.test/version");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown>;
    // Tests deploy nothing, so there is no tag and no build: the release alone.
    expect(body.version).toBe(KELPIE_RELEASE);
    expect(Object.keys(body).sort()).toEqual([
      "build",
      "commit",
      "deployedAt",
      "deployment",
      "version",
    ]);
  });

  it("answers any other route with 404", async () => {
    const response = await exports.default.fetch("https://ingress.test/unknown");

    expect(response.status).toBe(404);
  });
});
