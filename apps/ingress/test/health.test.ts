import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("ingress", () => {
  it("answers GET /health with 200 and a JSON status", async () => {
    const response = await exports.default.fetch("https://ingress.test/health");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("answers any other route with 404", async () => {
    const response = await exports.default.fetch("https://ingress.test/unknown");

    expect(response.status).toBe(404);
  });
});
