import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Every test runs in workerd, so the index is tested against Durable Object SQLite and its FTS5.
  plugins: [cloudflareTest({ wrangler: { configPath: "./test/wrangler.jsonc" } })],
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
      thresholds: { statements: 96, branches: 89, functions: 97, lines: 98 },
    },
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
