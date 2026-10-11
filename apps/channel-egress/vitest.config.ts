import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // A key for tests only: 32 bytes of 0x2a, base64.
      miniflare: {
        bindings: {
          SECRETS_KEY: "KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio=",
          INGRESS_ORIGIN: "https://ingress.test",
        },
      },
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
      thresholds: { statements: 88, branches: 83, functions: 96, lines: 92 },
    },
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
