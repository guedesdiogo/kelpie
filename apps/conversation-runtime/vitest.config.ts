import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { INJECTED_FAILURE } from "./test/fakes.ts";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Tests replace the model and channel ports with fakes, so llm-gateway and channel-egress
      // are never called; the bindings only have to exist for the runtime to start.
      miniflare: {
        serviceBindings: {
          LLM_GATEWAY: () => new Response("llm-gateway is not available in tests", { status: 503 }),
          CHANNEL_EGRESS: () =>
            new Response("channel-egress is not available in tests", { status: 503 }),
        },
      },
    }),
  ],
  test: {
    // Only failures a test injected on purpose; any other unhandled error still fails the run.
    onUnhandledError: (error) => !error.message.includes(INJECTED_FAILURE),
  },
});
