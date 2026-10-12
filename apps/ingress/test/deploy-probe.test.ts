import { listDurableObjectIds, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import type { RuntimeProbeReport } from "@kelpie/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEPLOY_PROBE_HEADER,
  type DeployProbeDeps,
  handleDeployProbe,
  sameSecret,
  signature,
  validSignature,
} from "../src/deploy-probe.ts";
import migrations from "../src/directory/migrations/migrations.js";

/** The token vitest.config.ts gives the Worker. */
const TOKEN = "deploy-probe-token-for-tests-0123456789";
const NOW = Date.UTC(2026, 9, 12, 12);
const ALL_OK: RuntimeProbeReport = { registry: "ok", agentHosts: "ok", gateway: "ok" };

/** The header the deploy sends: the time, and its HMAC keyed with the token. */
async function signed(atMs: number, token = TOKEN): Promise<string> {
  const seconds = String(Math.floor(atMs / 1_000));
  return `${seconds}.${await signature(token, seconds)}`;
}

const request = (headers: Record<string, string> = {}) =>
  new Request("https://ingress.test/deploy/probe", { method: "POST", headers });

/** Deps whose calls are counted, so a test sees what was woken. */
function fakes(overrides: Partial<DeployProbeDeps> = {}) {
  const woken: string[] = [];
  const deps: DeployProbeDeps = {
    token: TOKEN,
    now: () => NOW,
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the deploy probe", () => {
  it("doesn't exist without a valid signature, and wakes nothing", async () => {
    const valid = await signed(NOW);
    const [seconds = "", mac = ""] = valid.split(".");
    const cases: Array<[string, Partial<DeployProbeDeps>, Record<string, string>]> = [
      ["no secret", { token: undefined }, { [DEPLOY_PROBE_HEADER]: valid }],
      ["a secret under 32 characters", { token: "short-token" }, { [DEPLOY_PROBE_HEADER]: "" }],
      ["no header", {}, {}],
      ["the token itself", {}, { [DEPLOY_PROBE_HEADER]: TOKEN }],
      ["expired", {}, { [DEPLOY_PROBE_HEADER]: await signed(NOW - 121_000) }],
      ["from the future", {}, { [DEPLOY_PROBE_HEADER]: await signed(NOW + 121_000) }],
      ["another token", {}, { [DEPLOY_PROBE_HEADER]: await signed(NOW, `${TOKEN}-other`) }],
      ["a wrong MAC", {}, { [DEPLOY_PROBE_HEADER]: `${seconds}.${"0".repeat(64)}` }],
      ["another time", {}, { [DEPLOY_PROBE_HEADER]: `${Number(seconds) + 1}.${mac}` }],
      ["upper case", {}, { [DEPLOY_PROBE_HEADER]: valid.toUpperCase() }],
      ["malformed", {}, { [DEPLOY_PROBE_HEADER]: `${valid}.0` }],
    ];
    for (const [what, overrides, headers] of cases) {
      const { deps, woken } = fakes(overrides);
      expect(await handleDeployProbe(request(headers), deps), what).toBeNull();
      expect(woken, what).toEqual([]);
    }
    // A secret under 32 characters counts as unset even with its own valid signature.
    const short = fakes({ token: "short-token" });
    const own = { [DEPLOY_PROBE_HEADER]: await signed(NOW, "short-token") };
    expect(await handleDeployProbe(request(own), short.deps)).toBeNull();
  });

  it("accepts a signature within two minutes of its clock, either way", async () => {
    for (const at of [NOW, NOW - 119_000, NOW + 119_000]) {
      expect(await validSignature(await signed(at), TOKEN, NOW)).toBe(true);
    }
  });

  it("wakes every part with a valid signature, and answers with statuses only", async () => {
    const { deps, woken } = fakes();
    const response = await handleDeployProbe(
      request({ [DEPLOY_PROBE_HEADER]: await signed(NOW) }),
      deps,
    );

    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(await response?.json()).toEqual({ directory: "ok", ...ALL_OK });
    expect(woken.sort()).toEqual(["directory", "runtime"]);
  });

  it("reports each part that failed, and logs it by the error's name only", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps } = fakes({
      pingDirectory: async () => {
        throw new TypeError("Directory migration failed for u-owner");
      },
      probeRuntime: async () => ({ registry: "ok", agentHosts: "failed", gateway: "ok" }),
    });
    const response = await handleDeployProbe(
      request({ [DEPLOY_PROBE_HEADER]: await signed(NOW) }),
      deps,
    );

    expect(await response?.json()).toEqual({
      directory: "failed",
      registry: "ok",
      agentHosts: "failed",
      gateway: "ok",
    });
    expect(logged).toHaveBeenCalledWith("deploy probe: directory failed", "TypeError");
    expect(JSON.stringify(logged.mock.calls)).not.toContain("u-owner");
  });

  it("fails every runtime part when conversation-runtime can't answer, and repeats nothing else", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const unreachable = fakes({
      probeRuntime: () => Promise.reject("no such entrypoint"),
    });
    const response = await handleDeployProbe(
      request({ [DEPLOY_PROBE_HEADER]: await signed(NOW) }),
      unreachable.deps,
    );
    expect(await response?.json()).toEqual({
      directory: "ok",
      registry: "failed",
      agentHosts: "failed",
      gateway: "failed",
    });
    expect(logged).toHaveBeenCalledWith("deploy probe: conversation-runtime failed", "unknown");

    // Anything but an exact "ok" fails, and extra fields never reach the answer.
    const odd = fakes({
      probeRuntime: async () =>
        ({ registry: "OK", agentHosts: "ok", gateway: "ok", agents: ["sales"] }) as never,
    });
    const body = await (
      await handleDeployProbe(request({ [DEPLOY_PROBE_HEADER]: await signed(NOW) }), odd.deps)
    )?.text();
    expect(JSON.parse(body ?? "")).toEqual({
      directory: "ok",
      registry: "failed",
      agentHosts: "ok",
      gateway: "ok",
    });
    expect(body).not.toContain("sales");
  });

  it("compares the MAC whole, whatever its length", async () => {
    expect(await sameSecret(TOKEN, TOKEN)).toBe(true);
    expect(await sameSecret(TOKEN.toUpperCase(), TOKEN)).toBe(false);
    expect(await sameSecret("", TOKEN)).toBe(false);
    expect(await sameSecret(`${TOKEN}${TOKEN}`, TOKEN)).toBe(false);
  });
});

describe("the Directory's ping", () => {
  it("answers only once its migrations ran", async () => {
    const stub = env.DIRECTORY.getByName("ping-waits-for-migrations");
    expect(await stub.ping()).toEqual({ ok: true });
    const applied = await runInDurableObject(
      stub,
      (_instance, state) =>
        state.storage.sql
          .exec<{ n: number }>("SELECT count(*) AS n FROM __drizzle_migrations")
          .one().n,
    );
    expect(applied).toBe(migrations.journal.entries.length);
  });
});

describe("POST /deploy/probe", () => {
  const post = async (headers: Record<string, string> = {}, method = "POST") =>
    exports.default.fetch("https://ingress.test/deploy/probe", { method, headers });

  it("answers 404, as an unknown path does, without a valid signature, and wakes no Directory", async () => {
    const before = (await listDurableObjectIds(env.DIRECTORY)).length;
    const unknown = await exports.default.fetch("https://ingress.test/unknown", { method: "POST" });
    const notFound = await unknown.text();
    for (const response of [
      await post(),
      await post({ [DEPLOY_PROBE_HEADER]: TOKEN }),
      await post({ [DEPLOY_PROBE_HEADER]: await signed(Date.now() - 300_000) }),
      await post({ [DEPLOY_PROBE_HEADER]: await signed(Date.now()) }, "GET"),
    ]) {
      expect(response.status).toBe(unknown.status);
      expect(await response.text()).toBe(notFound);
    }
    expect(await listDurableObjectIds(env.DIRECTORY)).toHaveLength(before);
  });

  it("wakes the Directory and conversation-runtime's probe with a valid signature", async () => {
    const before = (await listDurableObjectIds(env.DIRECTORY)).length;
    const response = await post({ [DEPLOY_PROBE_HEADER]: await signed(Date.now()) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ directory: "ok", ...ALL_OK });
    expect(await listDurableObjectIds(env.DIRECTORY)).toHaveLength(before + 1);
  });
});
