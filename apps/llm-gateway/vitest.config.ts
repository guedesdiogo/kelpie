import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // The AI binding is remote-only; tests pass a fake one, so no Cloudflare session is opened.
      remoteBindings: false,
      miniflare: {
        // Only Anthropic has a model key, so the OpenAI candidates are skipped. Jev has its key.
        bindings: { ANTHROPIC_API_KEY: "sk-ant-test", TYPESAFE_API_KEY: "ts-test" },
        // channel-egress's RunnerChat, as a runner that isn't connected yet: the `claude-code`
        // route's tests that need a turn swap in a client of their own.
        workers: [
          {
            name: "kelpie-channel-egress",
            modules: true,
            compatibilityDate: "2026-10-01",
            script: `import { WorkerEntrypoint } from "cloudflare:workers";
export class RunnerChat extends WorkerEntrypoint {
  turn() {
    return { ok: false, reason: "not_connected" };
  }
  answer() {
    return { ok: false, reason: "not_connected" };
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
