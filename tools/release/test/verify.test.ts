import { describe, expect, it } from "vitest";
import { CloudflareError } from "../src/cloudflare.ts";
import { badInvocations, probeAll, settle, verdictOf, watch } from "../src/verify.ts";
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

describe("settle", () => {
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
