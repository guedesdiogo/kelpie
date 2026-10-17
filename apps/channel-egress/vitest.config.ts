import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig, type Plugin } from "vitest/config";
import { fakeRunner } from "./test/fake-runner.ts";

/**
 * The webchat's mascot files, linked into src/photo/webchat as `.txt` (ADR-0046), stay at the path
 * of their link, so the `Text` rule below loads them as text. Vite would follow the links to the
 * `.js` files and run them.
 */
const textLinks: Plugin = {
  name: "kelpie-text-links",
  enforce: "pre",
  resolveId: (source, importer) =>
    source.endsWith(".txt") && importer
      ? decodeURIComponent(new URL(source, `file://${importer}`).pathname)
      : null,
};

export default defineConfig({
  plugins: [
    textLinks,
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // A key for tests only: 32 bytes of 0x2a, base64.
      miniflare: {
        bindings: {
          SECRETS_KEY: "KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio=",
          INGRESS_ORIGIN: "https://ingress.test",
        },
        // The release tool adds the real binding when the instance has a runner (docs/deploy.md).
        serviceBindings: { RUNNER: fakeRunner },
      },
    }),
  ],
  // The first test of each file waits for the workerd runtime to start, which takes seconds on a
  // busy machine (#88). These budgets cover that start, not slow tests.
  test: {
    // CI's `test:coverage` fails under 80% on any of these, in every workspace (ADR-0030).
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      reporter: ["text-summary", "json-summary"],
      thresholds: { statements: 80, branches: 80, functions: 80, lines: 80 },
    },
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
