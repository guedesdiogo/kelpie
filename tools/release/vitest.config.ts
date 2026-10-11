import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // CI's `test:coverage` fails under 80% on any of these, in every workspace (ADR-0030).
    // main.ts is the CLI's wiring to the process, git, wrangler and Cloudflare; the modules it
    // calls hold the decisions and the tests.
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/main.ts"],
      reporter: ["text-summary", "json-summary"],
      thresholds: { statements: 80, branches: 80, functions: 80, lines: 80 },
    },
  },
});
