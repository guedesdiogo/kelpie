import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("admin-api Worker", () => {
  it("refuses every request until the Access application is configured", async () => {
    const response = await exports.default.fetch("https://admin.example/commands/listAgents", {
      method: "POST",
      headers: { "cf-access-jwt-assertion": "a.b.c" },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, reason: "unauthenticated" });
  });
});
