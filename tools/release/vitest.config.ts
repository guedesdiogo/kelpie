import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // CI's `test:coverage` fails below these thresholds: a point under the coverage measured
    // when they were set, so it can't drop. Raise them as tests cover more (docs/testing.md).
    // main.ts is the CLI's wiring to the process, git, wrangler and Cloudflare; the modules it
    // calls hold the decisions and the tests.
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/main.ts"],
      reporter: ["text-summary", "json-summary"],
      thresholds: { statements: 96, branches: 85, functions: 94, lines: 97 },
    },
  },
});
