import { listDurableObjectIds } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { REGISTRY_NAME, SETUP_AGENT_ID } from "@kelpie/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ProbeTargets, probeRuntime } from "../src/deploy-probe.ts";

// The deploy's probe (#234): ingress calls the DeployProbe entrypoint, which wakes the Registry,
// every agent's AgentHost and llm-gateway (a stub in vitest.config.ts), and reports a status each.

const owner = { userId: "u-owner", role: "owner", via: "admin-api" } as const;

afterEach(() => {
  vi.restoreAllMocks();
});

/** Targets that answer, with the AgentHosts they were asked for. */
function targets(overrides: Partial<ProbeTargets> = {}) {
  const pinged: string[] = [];
  const fake: ProbeTargets = {
    registry: {
      ping: async () => ({ ok: true }),
      list: async () => [
        { id: "sales", name: "Sales" },
        { id: SETUP_AGENT_ID, name: "Setup" },
      ],
    },
    agentHost: (id) => ({
      ping: async () => {
        pinged.push(id);
        return { ok: true };
      },
    }),
    gateway: { ping: async () => ({ ok: true }) },
    ...overrides,
  };
  return { fake, pinged };
}

describe("DeployProbe", () => {
  it("wakes the Registry, every agent's AgentHost and llm-gateway", async () => {
    await env.REGISTRY.getByName(REGISTRY_NAME).add("sales", "Sales", owner);
    expect(await listDurableObjectIds(env.AGENT_HOST)).toEqual([]);

    expect(await exports.DeployProbe.probe()).toEqual({
      registry: "ok",
      agentHosts: "ok",
      gateway: "ok",
    });
    const woken = (await listDurableObjectIds(env.AGENT_HOST)).map((id) => id.toString()).sort();
    expect(woken).toEqual(
      ["sales", SETUP_AGENT_ID].map((name) => env.AGENT_HOST.idFromName(name).toString()).sort(),
    );
  });
});

describe("probeRuntime", () => {
  it("pings each AgentHost the Registry lists", async () => {
    const { fake, pinged } = targets();
    expect(await probeRuntime(fake)).toEqual({ registry: "ok", agentHosts: "ok", gateway: "ok" });
    expect(pinged.sort()).toEqual(["sales", SETUP_AGENT_ID]);
  });

  it("fails agentHosts when any one of them fails, and logs the part without the message", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { fake } = targets({
      agentHost: (id) => ({
        ping: async () => {
          if (id === "sales") throw new TypeError("migration 0014 failed for sales");
          return { ok: true };
        },
      }),
    });
    expect(await probeRuntime(fake)).toEqual({
      registry: "ok",
      agentHosts: "failed",
      gateway: "ok",
    });
    expect(logged).toHaveBeenCalledWith("deploy probe: agentHosts failed", "TypeError");
    expect(JSON.stringify(logged.mock.calls)).not.toContain("sales");
  });

  it("fails the Registry's parts when it can't answer, and the gateway's on its own", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = async (): Promise<never> => {
      throw new Error("migration failed");
    };
    const { fake, pinged } = targets({
      registry: { ping: broken, list: broken },
      gateway: { ping: broken },
    });
    expect(await probeRuntime(fake)).toEqual({
      registry: "failed",
      agentHosts: "failed",
      gateway: "failed",
    });
    expect(pinged).toEqual([]);

    const unknown = targets({
      gateway: {
        ping: () => Promise.reject("not an error"),
      },
    });
    expect((await probeRuntime(unknown.fake)).gateway).toBe("failed");
  });
});
