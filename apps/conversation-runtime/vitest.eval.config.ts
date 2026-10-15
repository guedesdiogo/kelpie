import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { RUNTIME_MINIFLARE } from "./vitest.config.ts";

/**
 * `eval:handoff` (#287) reaches the cheap tier's models with ANTHROPIC_API_KEY and OPENAI_API_KEY,
 * which the script takes from the environment or, those two keys only, from `~/.kelpie/.env`. The
 * keys stay in this process and the test Worker. This file runs in Node, but the package compiles without Node's
 * types, so the environment is read through `globalThis`.
 */
const environment = (
  globalThis as unknown as { process: { env: Record<string, string | undefined> } }
).process.env;

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        ...RUNTIME_MINIFLARE,
        bindings: {
          ...RUNTIME_MINIFLARE.bindings,
          EVAL_MODELS: environment.EVAL_MODELS ?? "",
          ANTHROPIC_API_KEY: environment.ANTHROPIC_API_KEY ?? "",
          OPENAI_API_KEY: environment.OPENAI_API_KEY ?? "",
        },
      },
    }),
  ],
  test: {
    include: ["eval/**/*.eval.ts"],
    reporters: ["default", ["json", { outputFile: "eval/last-run.json" }]],
    // About 130 turns on a real model, a few at a time.
    testTimeout: 1_800_000,
    hookTimeout: 60_000,
  },
});
