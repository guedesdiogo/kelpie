import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig, type Plugin } from "vitest/config";

const RUNNER_SECRETS: Record<string, { version: string; protocol: number }> = {
  ["r".repeat(64)]: { version: "0.1.0", protocol: 1 },
  ["o".repeat(64)]: { version: "0.0.9", protocol: 2 },
};

/**
 * A stand-in for the VPS runner behind its VPC Service (#294). Its answer depends on the secret, so
 * each test picks one (test/runner.test.ts): a known secret gets its health, `b…` a server error,
 * and any other a 401.
 */
function fakeRunner(request: Request): Response {
  const secret = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  if (new URL(request.url).pathname !== "/health") return new Response(null, { status: 404 });
  if (secret === "b".repeat(64)) return new Response("boom", { status: 500 });
  const health = RUNNER_SECRETS[secret];
  return health
    ? Response.json({ ok: true, ...health })
    : Response.json({ ok: false }, { status: 401 });
}

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
