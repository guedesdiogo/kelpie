import { describe, expect, it } from "vitest";
import { CloudflareError } from "../src/cloudflare.ts";
import {
  badInvocations,
  deepProbeSignature,
  probeAll,
  settle,
  verdictOf,
  watch,
} from "../src/verify.ts";
import { fakeApi, fakeClock, fakeProduction, noSleep, ORIGIN, silentLog } from "./fakes.ts";

const build = { build: 96, commit: "abc1234" };
const options = { minutes: 10, intervalMs: 60_000, errorThreshold: 3, failuresInARow: 3 };

describe("probes", () => {
  it("pass when ingress serves the build and refuses the webhooks", async () => {
    const results = await probeAll(fakeProduction({ serving: build }), ORIGIN, build);
    expect(results.map((result) => [result.probe, result.outcome])).toEqual([
      ["health", "pass"],
      ["version", "pass"],
      ["telegram-webhook", "pass"],
      ["github-webhook", "pass"],
    ]);
    expect(verdictOf(results)).toEqual({ status: "healthy" });
  });

  it("fail on another build, or a broken secret store", async () => {
    const results = await probeAll(
      fakeProduction({ serving: { build: 95, commit: "25c5076" }, telegram: 503 }),
      ORIGIN,
      build,
    );
    expect(
      results.filter((result) => result.outcome === "fail").map((result) => result.detail),
    ).toEqual([
      "serves 95-25c5076, expected 96-abc1234",
      "answered 503 (channel-egress's secret store is unavailable)",
    ]);
  });

  it("repeat only a well-formed build from /version", async () => {
    const production = (async () =>
      Response.json({ build: "<script>", commit: "x" })) as unknown as typeof fetch;
    const version = (await probeAll(production, ORIGIN, build)).find(
      (result) => result.probe === "version",
    );
    expect(version?.detail).toBe("serves another build, expected 96-abc1234");
  });

  it("keep the hostname out of a network failure", async () => {
    const [health] = await probeAll(fakeProduction({ serving: build, down: true }), ORIGIN, build);
    expect(health).toEqual({ probe: "health", outcome: "fail", detail: "no answer (TypeError)" });
  });

  it("count the zone's challenge as inconclusive", async () => {
    const results = await probeAll(
      fakeProduction({ serving: build, mitigated: true }),
      ORIGIN,
      build,
    );
    expect(verdictOf(results).status).toBe("inconclusive");
  });
});

describe("the deep probe", () => {
  const TOKEN = "0123456789abcdef0123456789abcdef";
  const deep = async (state: Parameters<typeof fakeProduction>[0], token = TOKEN) =>
    (await probeAll(fakeProduction(state), ORIGIN, build, token)).find(
      (result) => result.probe === "deep",
    );

  it("goes only with a token, and passes when every part is ok", async () => {
    const without = await probeAll(fakeProduction({ serving: build }), ORIGIN, build);
    expect(without.map((result) => result.probe)).not.toContain("deep");

    expect(await deep({ serving: build, deep: { token: TOKEN } })).toEqual({
      probe: "deep",
      outcome: "pass",
      detail: "answered 200",
    });
  });

  it("names the parts that failed, and nothing else from the answer", async () => {
    const result = await deep({
      serving: build,
      deep: { token: TOKEN, parts: { agentHosts: "failed", gateway: "<b>broken</b>" } },
    });
    expect(result).toMatchObject({ outcome: "fail", detail: "failed: agentHosts, gateway" });

    const missing = await deep({
      serving: build,
      deep: { token: TOKEN, parts: { directory: undefined } },
    });
    expect(missing?.detail).toBe("failed: directory");
  });

  it("signs the time instead of sending the token", async () => {
    const sent: string[] = [];
    const production = fakeProduction({ serving: build, deep: { token: TOKEN } });
    const recording = (async (input: string | URL | Request, init?: RequestInit) => {
      sent.push(JSON.stringify(init?.headers ?? {}));
      return production(input, init);
    }) as typeof fetch;
    const results = await probeAll(recording, ORIGIN, build, TOKEN);
    expect(results.find((result) => result.probe === "deep")?.outcome).toBe("pass");
    expect(sent.join("\n")).not.toContain(TOKEN);

    const at = Date.UTC(2026, 9, 12, 12);
    expect(await deepProbeSignature(TOKEN, at)).toMatch(
      new RegExp(`^${at / 1_000}\\.[0-9a-f]{64}$`),
    );
    expect(await deepProbeSignature(TOKEN, at)).not.toBe(
      await deepProbeSignature(TOKEN, at + 1_000),
    );
    expect(await deepProbeSignature(TOKEN, at)).not.toBe(
      await deepProbeSignature(`${TOKEN}-other`, at),
    );
  });

  it("fails on a missing route, another token or an error, without repeating the body", async () => {
    expect((await deep({ serving: build }))?.detail).toBe(
      "answered 404: ingress may lack DEPLOY_PROBE_TOKEN or hold an older one, which running the Deploy workflow with rotate-probe-token fixes; or the build has no probe route",
    );
    expect(
      (await deep({ serving: build, deep: { token: TOKEN } }, `${TOKEN}-rotated`))?.outcome,
    ).toBe("fail");
    expect(
      await deep({ serving: build, deep: { token: TOKEN, status: 500, parts: { why: "x" } } }),
    ).toMatchObject({ outcome: "fail", detail: "answered 500" });

    const text = (async () =>
      new Response("secret stack trace", { status: 200 })) as unknown as typeof fetch;
    const [result] = (await probeAll(text, ORIGIN, build, TOKEN)).filter(
      (probe) => probe.probe === "deep",
    );
    expect(result?.detail).toBe("failed: directory, registry, agentHosts, gateway");
  });

  it("counts in the watch: failing three times in a row makes the release unhealthy", async () => {
    const clock = fakeClock();
    const result = await watch(
      {
        api: fakeApi({ live: build }),
        fetch: fakeProduction({
          serving: build,
          deep: { token: TOKEN, parts: { registry: "failed" } },
        }),
        ...clock,
        log: silentLog,
      },
      ORIGIN,
      build,
      ["v1"],
      clock.now(),
      options,
      TOKEN,
    );
    expect(result.verdict).toEqual({
      status: "unhealthy",
      reason: "probes failed 3 times in a row: deep failed: registry",
    });
  });
});

describe("settle", () => {
  it("waits for the deep probe's route when given the token", async () => {
    const token = "0123456789abcdef0123456789abcdef";
    const state: Parameters<typeof fakeProduction>[0] = { serving: build };
    let sleeps = 0;
    const results = await settle(
      {
        fetch: fakeProduction(state),
        sleep: async () => {
          if (++sleeps === 1) state.deep = { token };
        },
        log: silentLog,
      },
      ORIGIN,
      build,
      { attempts: 3, intervalMs: 10 },
      token,
    );
    expect(sleeps).toBe(1);
    expect(results.map((result) => result.probe)).toContain("deep");
    expect(verdictOf(results).status).toBe("healthy");
  });

  it("probes again until the new version answers", async () => {
    const state = { serving: { build: 95, commit: "25c5076" } };
    let sleeps = 0;
    const results = await settle(
      {
        fetch: fakeProduction(state),
        sleep: async () => {
          if (++sleeps === 2) state.serving = build;
        },
        log: silentLog,
      },
      ORIGIN,
      build,
      { attempts: 5, intervalMs: 10 },
    );
    expect(sleeps).toBe(2);
    expect(verdictOf(results).status).toBe("healthy");
  });
});

describe("badInvocations", () => {
  it("counts exceptions and exceeded limits, apart for Durable Objects, and not disconnects", () => {
    expect(
      badInvocations([
        {
          dataset: "workers",
          script: "kelpie-ingress",
          status: "scriptThrewException",
          requests: 2,
        },
        { dataset: "workers", script: "kelpie-ingress", status: "clientDisconnected", requests: 9 },
        {
          dataset: "durableObjects",
          script: "kelpie-ingress",
          status: "exceededResources",
          requests: 1,
        },
        { dataset: "workers", script: "kelpie-ingress", status: "success", requests: 40 },
      ]),
    ).toEqual({ "kelpie-ingress": 2, "kelpie-ingress (Durable Objects)": 1 });
  });
});

describe("watch", () => {
  it("keeps a release that stays healthy for the whole window", async () => {
    const clock = fakeClock();
    const api = fakeApi({ live: build });
    const result = await watch(
      { api, fetch: fakeProduction({ serving: build }), ...clock, log: silentLog },
      ORIGIN,
      build,
      ["v1"],
      clock.now(),
      options,
    );
    expect(result).toMatchObject({ verdict: { status: "healthy" }, analytics: true, errors: {} });
    expect(clock.now().getTime() - Date.parse("2026-10-11T00:00:00Z")).toBe(10 * 60_000);
  });

  it("rejects a release whose versions fail invocations", async () => {
    const clock = fakeClock();
    const api = fakeApi({
      live: build,
      invocations: () => [
        {
          dataset: "durableObjects",
          script: "kelpie-conversation-runtime",
          status: "scriptThrewException",
          requests: 3,
        },
      ],
    });
    const result = await watch(
      { api, fetch: fakeProduction({ serving: build }), ...clock, log: silentLog },
      ORIGIN,
      build,
      ["v1"],
      clock.now(),
      options,
    );
    expect(result.verdict).toEqual({
      status: "unhealthy",
      reason:
        "the new versions failed 3 invocations (kelpie-conversation-runtime (Durable Objects): 3)",
    });
  });

  it("judges Workers and Durable Objects apart, so one exception isn't counted twice", async () => {
    const clock = fakeClock();
    const api = fakeApi({
      live: build,
      invocations: () => [
        {
          dataset: "workers",
          script: "kelpie-ingress",
          status: "scriptThrewException",
          requests: 2,
        },
        {
          dataset: "durableObjects",
          script: "kelpie-ingress",
          status: "scriptThrewException",
          requests: 2,
        },
      ],
    });
    const result = await watch(
      { api, fetch: fakeProduction({ serving: build }), ...clock, log: silentLog },
      ORIGIN,
      build,
      ["v1"],
      clock.now(),
      options,
    );
    expect(result.verdict.status).toBe("healthy");
    expect(result.errors).toEqual({ "kelpie-ingress": 2, "kelpie-ingress (Durable Objects)": 2 });
  });

  it("forgives a probe that fails twice in a row, not three times", async () => {
    const run = async (failures: number) => {
      const clock = fakeClock();
      const state = { serving: build, telegram: 503 };
      let rounds = 0;
      const production = fakeProduction(state);
      const result = await watch(
        {
          api: fakeApi({ live: build }),
          fetch: (async (input: string | URL | Request, init?: RequestInit) => {
            if (new URL(String(input)).pathname === "/health") rounds++;
            state.telegram = rounds <= failures ? 503 : 401;
            return production(input, init);
          }) as typeof fetch,
          ...clock,
          log: silentLog,
        },
        ORIGIN,
        build,
        ["v1"],
        clock.now(),
        options,
      );
      return result.verdict.status;
    };
    expect(await run(2)).toBe("healthy");
    expect(await run(3)).toBe("unhealthy");
  });

  it("probes past the window while a probe is failing", async () => {
    const clock = fakeClock();
    const state = { serving: build, telegram: 401 };
    let rounds = 0;
    const production = fakeProduction(state);
    const result = await watch(
      {
        api: fakeApi({ live: build }),
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          if (new URL(String(input)).pathname === "/health") rounds++;
          // The last scheduled round, at minute 10, fails; so do the ones after it.
          state.telegram = rounds >= 11 ? 503 : 401;
          return production(input, init);
        }) as typeof fetch,
        ...clock,
        log: silentLog,
      },
      ORIGIN,
      build,
      ["v1"],
      clock.now(),
      options,
    );
    expect(result.verdict.status).toBe("unhealthy");
    expect(rounds).toBe(13);
  });

  it("judges by the probes alone when analytics can't be read", async () => {
    const clock = fakeClock();
    const warnings: string[] = [];
    const result = await watch(
      {
        api: fakeApi({
          live: build,
          invocations: () => {
            throw new CloudflareError("Cloudflare GraphQL query failed (403)", []);
          },
        }),
        fetch: fakeProduction({ serving: build }),
        ...clock,
        log: { info: () => {}, warn: (message) => warnings.push(message) },
      },
      ORIGIN,
      build,
      ["v1"],
      clock.now(),
      options,
    );
    expect(result).toMatchObject({ verdict: { status: "healthy" }, analytics: false });
    expect(warnings).toHaveLength(1);
  });

  it("probes once when the window is zero", async () => {
    const clock = fakeClock();
    const result = await watch(
      {
        api: fakeApi({ live: build }),
        fetch: fakeProduction({ serving: build }),
        now: clock.now,
        sleep: noSleep,
        log: silentLog,
      },
      ORIGIN,
      build,
      ["v1"],
      clock.now(),
      { ...options, minutes: 0 },
    );
    expect(result.verdict.status).toBe("healthy");
  });
});
