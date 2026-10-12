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
  async generate() {
    throw new Error("no models in tests");
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
    // Puts the test fakes back and deletes the vaults after every test, in every file (#245).
    setupFiles: ["./test/setup.ts"],
    // CI's `test:coverage` fails under 80% on any of these, in every workspace (ADR-0030).
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      reporter: ["text-summary", "json-summary"],
      thresholds: { statements: 80, branches: 80, functions: 80, lines: 80 },
    },
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
