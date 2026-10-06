import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The memory evaluation (#108). Each size's metrics travel in its test's `meta`, which the JSON
// reporter writes to eval/last-run.json; docs/spikes/memory-eval.md records them.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./test/wrangler.jsonc" } })],
  test: {
    include: ["eval/**/*.eval.ts"],
    reporters: ["default", ["json", { outputFile: "eval/last-run.json" }]],
    // The largest vault takes about 20 seconds to generate and index on a laptop; slower machines
    // and CI runners get room.
    testTimeout: 1_800_000,
    hookTimeout: 60_000,
  },
});
