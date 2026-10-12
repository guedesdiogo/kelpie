import { listDurableObjectIds } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import type { RuntimeProbeReport } from "@kelpie/config";
import { describe, expect, it } from "vitest";
import {
  DEPLOY_PROBE_HEADER,
  type DeployProbeDeps,
  handleDeployProbe,
  sameSecret,
} from "../src/deploy-probe.ts";

/** The token vitest.config.ts gives the Worker. */
const TOKEN = "deploy-probe-token-for-tests-0123456789";
const ALL_OK: RuntimeProbeReport = { registry: "ok", agentHosts: "ok", gateway: "ok" };

const request = (headers: Record<string, string> = {}) =>
  new Request("https://ingress.test/deploy/probe", { method: "POST", headers });

/** Deps whose calls are counted, so a test sees what was woken. */
function fakes(overrides: Partial<DeployProbeDeps> = {}) {
  const woken: string[] = [];
  const deps: DeployProbeDeps = {
    token: TOKEN,
    async pingDirectory() {
      woken.push("directory");
      return { ok: true };
    },
    async probeRuntime() {
      woken.push("runtime");
      return ALL_OK;
    },
    ...overrides,
  };
  return { deps, woken };
}

describe("the deploy probe", () => {
  it("doesn't exist without the right token, and wakes nothing", async () => {
    const cases: Array<[Partial<DeployProbeDeps>, Record<string, string>]> = [
      [{ token: undefined }, { [DEPLOY_PROBE_HEADER]: TOKEN }],
      [{ token: "" }, { [DEPLOY_PROBE_HEADER]: "" }],
      [{}, {}],
      [{}, { [DEPLOY_PROBE_HEADER]: "" }],
      [{}, { [DEPLOY_PROBE_HEADER]: `${TOKEN}x` }],
      [{}, { [DEPLOY_PROBE_HEADER]: TOKEN.slice(0, -1) }],
    ];
    for (const [overrides, headers] of cases) {
      const { deps, woken } = fakes(overrides);
      expect(await handleDeployProbe(request(headers), deps)).toBeNull();
      expect(woken).toEqual([]);
    }
  });

  it("wakes every part with the token, and answers with statuses only", async () => {
    const { deps, woken } = fakes();
    const response = await handleDeployProbe(request({ [DEPLOY_PROBE_HEADER]: TOKEN }), deps);

    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(await response?.json()).toEqual({ directory: "ok", ...ALL_OK });
    expect(woken.sort()).toEqual(["directory", "runtime"]);
  });

  it("reports each part that failed", async () => {
    const { deps } = fakes({
      pingDirectory: async () => {
        throw new Error("Directory migration failed");
      },
      probeRuntime: async () => ({ registry: "ok", agentHosts: "failed", gateway: "ok" }),
    });
    const response = await handleDeployProbe(request({ [DEPLOY_PROBE_HEADER]: TOKEN }), deps);

    expect(await response?.json()).toEqual({
      directory: "failed",
      registry: "ok",
      agentHosts: "failed",
      gateway: "ok",
    });
  });

  it("fails every runtime part when conversation-runtime can't answer, and repeats nothing else", async () => {
    const unreachable = fakes({
      probeRuntime: async () => {
        throw new Error("no such entrypoint");
      },
    });
    const response = await handleDeployProbe(
      request({ [DEPLOY_PROBE_HEADER]: TOKEN }),
      unreachable.deps,
    );
    expect(await response?.json()).toEqual({
      directory: "ok",
      registry: "failed",
      agentHosts: "failed",
      gateway: "failed",
    });

    // Anything but an exact "ok" fails, and extra fields never reach the answer.
    const odd = fakes({
      probeRuntime: async () =>
        ({ registry: "OK", agentHosts: "ok", gateway: "ok", agents: ["sales"] }) as never,
    });
    const body = await (
      await handleDeployProbe(request({ [DEPLOY_PROBE_HEADER]: TOKEN }), odd.deps)
    )?.text();
    expect(JSON.parse(body ?? "")).toEqual({
      directory: "ok",
      registry: "failed",
      agentHosts: "ok",
      gateway: "ok",
    });
    expect(body).not.toContain("sales");
  });

  it("compares the token whole, whatever its length", async () => {
    expect(await sameSecret(TOKEN, TOKEN)).toBe(true);
    expect(await sameSecret(TOKEN.toUpperCase(), TOKEN)).toBe(false);
    expect(await sameSecret("", TOKEN)).toBe(false);
    expect(await sameSecret(`${TOKEN}${TOKEN}`, TOKEN)).toBe(false);
  });
});

describe("POST /deploy/probe", () => {
  const post = (headers: Record<string, string> = {}, method = "POST") =>
    exports.default.fetch("https://ingress.test/deploy/probe", { method, headers });

  it("answers 404, as an unknown path does, without the token, and wakes no Directory", async () => {
    const unknown = await exports.default.fetch("https://ingress.test/unknown", { method: "POST" });
    const notFound = await unknown.text();
    for (const response of [
      await post(),
      await post({ [DEPLOY_PROBE_HEADER]: "wrong" }),
      await post({ [DEPLOY_PROBE_HEADER]: TOKEN }, "GET"),
    ]) {
      expect(response.status).toBe(unknown.status);
      expect(await response.text()).toBe(notFound);
    }
    expect(await listDurableObjectIds(env.DIRECTORY)).toEqual([]);
  });

  it("wakes the Directory and conversation-runtime's probe with the token", async () => {
    const response = await post({ [DEPLOY_PROBE_HEADER]: TOKEN });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ directory: "ok", ...ALL_OK });
    expect(await listDurableObjectIds(env.DIRECTORY)).toHaveLength(1);
  });
});
