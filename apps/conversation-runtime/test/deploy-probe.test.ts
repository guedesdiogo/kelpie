import { listDurableObjectIds, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { REGISTRY_NAME, SETUP_AGENT_ID } from "@kelpie/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import agentHostMigrations from "../src/agent-host/migrations/migrations.js";
import { AGENT_HOSTS_AT_ONCE, type ProbeTargets, probeRuntime } from "../src/deploy-probe.ts";
import registryMigrations from "../src/registry/migrations/migrations.js";

// The deploy's probe (#234): ingress calls the DeployProbe entrypoint, which wakes the Registry,
// every agent's AgentHost and llm-gateway (a stub in vitest.config.ts), and reports a status each.

const owner = { userId: "u-owner", role: "owner", via: "admin-api" } as const;

afterEach(() => {
  vi.restoreAllMocks();
});

/** An agent as the Registry lists it; the probe reads only its id. */
const entry = (id: string, name: string) =>
  ({ id, name, role: "specialist", owner: null, chat: true }) as const;

/** Targets that answer, with the AgentHosts they were asked for. */
function targets(overrides: Partial<ProbeTargets> = {}) {
  const pinged: string[] = [];
  const fake: ProbeTargets = {
    registry: {
      ping: async () => ({ ok: true }),
      list: async () => [entry("sales", "Sales"), entry(SETUP_AGENT_ID, "Setup")],
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
      // The main agent a new instance starts with (#288), the setup agent and the one added.
      ["kelpie", "sales", SETUP_AGENT_ID]
        .map((name) => env.AGENT_HOST.idFromName(name).toString())
        .sort(),
    );
  });
});

describe("ping", () => {
  /** Migrations the object recorded as applied. */
  const applied = (_instance: unknown, state: DurableObjectState) =>
    state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM __drizzle_migrations").one().n;

  it("answers on the Registry only once its migrations ran", async () => {
    const stub = env.REGISTRY.getByName("ping-waits-for-migrations");
    expect(await stub.ping()).toEqual({ ok: true });
    expect(await runInDurableObject(stub, applied)).toBe(registryMigrations.journal.entries.length);
  });

  it("answers on an AgentHost only once its migrations ran", async () => {
    const stub = env.AGENT_HOST.getByName("ping-waits-for-migrations");
    expect(await stub.ping()).toEqual({ ok: true });
    expect(await runInDurableObject(stub, applied)).toBe(
      agentHostMigrations.journal.entries.length,
    );
  });
});

describe("probeRuntime", () => {
  it("pings each AgentHost the Registry lists", async () => {
    const { fake, pinged } = targets();
    expect(await probeRuntime(fake)).toEqual({ registry: "ok", agentHosts: "ok", gateway: "ok" });
    expect(pinged.sort()).toEqual(["sales", SETUP_AGENT_ID]);
  });

  it("wakes at most ten AgentHosts at a time", async () => {
    let awake = 0;
    let most = 0;
    const agents = Array.from({ length: 25 }, (_, index) => entry(`agent-${index}`, "A"));
    const pinged: string[] = [];
    const { fake } = targets({
      registry: { ping: async () => ({ ok: true }), list: async () => agents },
      agentHost: (id) => ({
        ping: async () => {
          awake += 1;
          most = Math.max(most, awake);
          await new Promise((resolve) => setTimeout(resolve, 5));
          awake -= 1;
          pinged.push(id);
          return { ok: true };
        },
      }),
    });
    expect((await probeRuntime(fake)).agentHosts).toBe("ok");
    expect(most).toBe(AGENT_HOSTS_AT_ONCE);
    expect(pinged).toHaveLength(25);
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
