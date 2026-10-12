import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Blank counts as unset, so a shell that exports these, as Claude Code's users may, doesn't make
    // every adapter refuse to start (issue #276). Tests that need one stub it.
    env: { ANTHROPIC_CUSTOM_HEADERS: "", OPENAI_CUSTOM_HEADERS: "" },
    // CI's `test:coverage` fails under 80% on any of these, in every workspace (ADR-0030).
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      reporter: ["text-summary", "json-summary"],
      thresholds: { statements: 80, branches: 80, functions: 80, lines: 80 },
    },
  },
});
