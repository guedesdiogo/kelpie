import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { INJECTED_FAILURE } from "./test/fakes.ts";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Tests replace the model and channel ports with fakes, so llm-gateway and channel-egress
      // are never called; the bindings only have to exist for the runtime to start.
      miniflare: {
        serviceBindings: {
          LLM_GATEWAY: () => new Response("llm-gateway is not available in tests", { status: 503 }),
          CHANNEL_EGRESS: () =>
            new Response("channel-egress is not available in tests", { status: 503 }),
          CHANNEL_FORMS: () =>
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
        ],
      },
    }),
  ],
  test: {
    // The first test of each file waits for the workerd runtime to start, which takes seconds on a
    // busy machine (#88). These budgets cover that start, not slow tests.
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Only failures a test injected on purpose; any other unhandled error still fails the run.
    onUnhandledError: (error) => !error.message.includes(INJECTED_FAILURE),
  },
});
