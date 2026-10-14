import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { depsFor } from "../src/index.ts";

afterEach(() => vi.restoreAllMocks());

describe("admin-api Worker", () => {
  it("reads and sets the instance's model settings through llm-gateway (#289)", async () => {
    const { commands } = depsFor(env);
    const owner = { userId: "u-owner", role: "owner", via: "admin-api" } as const;

    expect(await commands.getModels(owner)).toEqual({
      ok: true,
      value: { settings: {}, pinned: "anthropic", providers: ["anthropic"] },
    });
    expect(await commands.configureModels(owner, { settings: { provider: "anthropic" } })).toEqual({
      ok: true,
      value: {},
    });
  });

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
