import { env, exports } from "cloudflare:workers";
import { KELPIE_RELEASE } from "@kelpie/config";
import { describe, expect, it } from "vitest";
import ingress from "../src/index.ts";

describe("ingress", () => {
  it("answers GET /health with 200 and prumo's OBS-05 fields", async () => {
    const response = await exports.default.fetch("https://ingress.test/health");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    // Tests deploy nothing, so there is no tag and no commit, as on /version.
    expect(await response.json()).toEqual({
      status: "ok",
      environment: "production",
      commit: null,
    });
  });

  it("names on /health the commit /version names for a tagged deploy", async () => {
    const tagged = {
      ...env,
      CF_VERSION_METADATA: { id: "v-1", tag: "512-abc1234", timestamp: "2026-10-22T00:00:00Z" },
    };
    const get = (path: string) =>
      ingress.fetch(new Request(`https://ingress.test${path}`), tagged) as Promise<Response>;

    const health = (await (await get("/health")).json()) as Record<string, unknown>;
    const version = (await (await get("/version")).json()) as Record<string, unknown>;

    expect(health).toEqual({ status: "ok", environment: "production", commit: "abc1234" });
    expect(health.commit).toBe(version.commit);
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
