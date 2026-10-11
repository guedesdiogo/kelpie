import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // The AI binding is remote-only; tests pass a fake one, so no Cloudflare session is opened.
      remoteBindings: false,
      // Only Anthropic has a model key, so the OpenAI candidates are skipped. Jev has its key.
      miniflare: { bindings: { ANTHROPIC_API_KEY: "sk-ant-test", TYPESAFE_API_KEY: "ts-test" } },
    }),
  ],
  // The first test of each file waits for the workerd runtime to start, which takes seconds on a
  // busy machine (#88). These budgets cover that start, not slow tests.
  test: {
    // CI's `test:coverage` fails below these thresholds: a point under the coverage measured
    // when they were set, so it can't drop. Raise them as tests cover more (docs/testing.md).
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      reporter: ["text-summary", "json-summary"],
      thresholds: { statements: 95, branches: 86, functions: 89, lines: 96 },
    },
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
