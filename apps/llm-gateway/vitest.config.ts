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
});
