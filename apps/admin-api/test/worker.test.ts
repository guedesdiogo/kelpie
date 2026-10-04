import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.restoreAllMocks());

describe("admin-api Worker", () => {
  it("refuses every request while the Access application isn't configured", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await exports.default.fetch("https://admin.example/commands/listAgents", {
      method: "POST",
      headers: { "cf-access-jwt-assertion": "a.b.c" },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, reason: "unauthenticated" });
    expect(warn).toHaveBeenCalledWith("admin-api: request refused", { reason: "not_configured" });
  });
});
