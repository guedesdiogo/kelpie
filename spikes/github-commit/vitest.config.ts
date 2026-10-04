import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Never a real key: tests that sign generate their own key pair.
      miniflare: {
        bindings: { GITHUB_APP_PRIVATE_KEY: "not a key", SPIKE_TOKEN: "test-spike-token" },
      },
    }),
  ],
});
