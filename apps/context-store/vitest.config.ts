import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Tests replace the GitHub backend with an in-memory one; the webhook secret is real. An
      // llm-gateway without models answers memory's calls unless a test swaps in a fake.
      miniflare: {
        bindings: { GITHUB_WEBHOOK_SECRET: "webhook-secret-for-tests" },
        workers: [
          {
            name: "kelpie-llm-gateway",
            modules: true,
            compatibilityDate: "2026-10-01",
            script: `import { WorkerEntrypoint } from "cloudflare:workers";
export class LlmGateway extends WorkerEntrypoint {
  embed() {
    return { ok: false, reason: "not_configured" };
  }
  qualify() {
    return { ok: false, reason: "not_configured" };
  }
}
export default { fetch: () => new Response(null, { status: 404 }) };`,
          },
        ],
      },
    }),
  ],
  // The first test of each file waits for the workerd runtime to start, which takes seconds on a
  // busy machine (#88). These budgets cover that start, not slow tests.
  test: {
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
