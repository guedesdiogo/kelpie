import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Tests replace the model port with a fake, so llm-gateway is never called; the binding only
      // has to exist for the runtime to start.
      miniflare: {
        serviceBindings: {
          LLM_GATEWAY: () => new Response("llm-gateway is not available in tests", { status: 503 }),
        },
      },
    }),
  ],
});
