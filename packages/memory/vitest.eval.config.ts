import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * `eval:models` reaches real models: bge-m3 and Clef on Workers AI with the developer's Cloudflare
 * login (set CLOUDFLARE_ACCOUNT_ID when it has several accounts), and OpenAI with OPENAI_API_KEY,
 * which the script loads from `~/.kelpie/.env` when that file exists. The key stays in this
 * process and the test Worker. This file runs in Node, but the package compiles without Node's
 * types, so the environment is read through `globalThis`.
 */
const environment = (
  globalThis as unknown as { process: { env: Record<string, string | undefined> } }
).process.env;
const withModels = environment.EVAL_MODELS === "1";

// The memory evaluation (#108). Each size's metrics travel in its test's `meta`, which the JSON
// reporter writes to eval/last-run.json; docs/spikes/memory-eval.md records them.
export default defineConfig({
  plugins: [
    cloudflareTest(
      withModels
        ? {
            wrangler: { configPath: "./eval/wrangler.models.jsonc" },
            remoteBindings: true,
            miniflare: {
              bindings: { EVAL_MODELS: "1", OPENAI_API_KEY: environment.OPENAI_API_KEY ?? "" },
            },
          }
        : { wrangler: { configPath: "./test/wrangler.jsonc" } },
    ),
  ],
  test: {
    include: ["eval/**/*.eval.ts"],
    reporters: ["default", ["json", { outputFile: "eval/last-run.json" }]],
    // The largest vault takes about 20 seconds to generate and index on a laptop; slower machines
    // and CI runners get room. With models, embedding a 10k vault takes minutes.
    testTimeout: 1_800_000,
    hookTimeout: 60_000,
  },
});
