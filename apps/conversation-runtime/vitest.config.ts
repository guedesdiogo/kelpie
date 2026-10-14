import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { INJECTED_FAILURE } from "./test/fakes.ts";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Tests replace the model and channel ports with fakes, so channel-egress and llm-gateway's
      // model calls are never made; the bindings only have to exist for the runtime to start.
      miniflare: {
        // The admin API's origin, as a deploy sets it: links to it are Kelpie's own (#188).
        bindings: { ADMIN_ORIGIN: "https://admin.example" },
        serviceBindings: {
          CHANNEL_EGRESS: () =>
            new Response("channel-egress is not available in tests", { status: 503 }),
          SETUP_FORMS: () =>
            new Response("channel-egress is not available in tests", { status: 503 }),
        },
        // An empty vault: agents run on their settings unless a test swaps in a Context Store.
        workers: [
          {
            name: "kelpie-context-store",
            modules: true,
            compatibilityDate: "2026-10-01",
            script: `import { WorkerEntrypoint } from "cloudflare:workers";
export class ContextStore extends WorkerEntrypoint {
  compile() {
    return { persona: null, rules: [], skills: [] };
  }
}
export default { fetch: () => new Response(null, { status: 404 }) };`,
          },
          // llm-gateway answers the deploy probe's ping (#234), and describes an area's trio for an
          // agent's prompt (#286) as `withIdentity` in test/prompts.ts expects it: the agent's
          // area tier and effort, cheap by default, on one model named after the tier. It has no
          // other method, so a model call is refused by the runtime.
          {
            name: "kelpie-llm-gateway",
            modules: true,
            compatibilityDate: "2026-10-01",
            script: `import { WorkerEntrypoint } from "cloudflare:workers";
export class LlmGateway extends WorkerEntrypoint {
  ping() {
    return { ok: true };
  }
  describe(area, agent) {
    const tier = agent?.[area]?.tier ?? "cheap";
    const effort = agent?.[area]?.effort;
    return {
      provider: "anthropic",
      tier,
      ...(effort ? { effort } : {}),
      route: [{ provider: "anthropic", model: "claude-test-" + tier }],
    };
  }
}
export default { fetch: () => new Response(null, { status: 404 }) };`,
          },
        ],
      },
    }),
  ],
  test: {
    // CI's `test:coverage` fails under 80% on any of these, in every workspace (ADR-0030).
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      reporter: ["text-summary", "json-summary"],
      thresholds: { statements: 80, branches: 80, functions: 80, lines: 80 },
    },
    // The first test of each file waits for the workerd runtime to start, which takes seconds on a
    // busy machine (#88). These budgets cover that start, not slow tests.
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Only failures a test injected on purpose; any other unhandled error still fails the run.
    onUnhandledError: (error) => !error.message.includes(INJECTED_FAILURE),
  },
});
