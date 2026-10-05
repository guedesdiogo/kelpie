import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Only Anthropic has a key, so the OpenAI candidates are skipped.
      miniflare: { bindings: { ANTHROPIC_API_KEY: "sk-ant-test" } },
    }),
  ],
  // The first test of each file waits for the workerd runtime to start, which takes seconds on a
  // busy machine (#88). These budgets cover that start, not slow tests.
  test: {
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
