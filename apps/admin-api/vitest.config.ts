import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/** A Worker that only declares the classes another Worker binds to: objects and entrypoints. */
function stubWorker(name: string, classes: Record<string, string>, entrypoints: string[] = []) {
  const declarations = [
    ...Object.values(classes).map(
      (className) => `export class ${className} extends DurableObject {}`,
    ),
    ...entrypoints.map((className) => `export class ${className} extends WorkerEntrypoint {}`),
  ].join("\n");
  return {
    name,
    modules: true,
    compatibilityDate: "2026-10-01",
    script: `import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
${declarations}
export default { fetch: () => new Response(null, { status: 404 }) };`,
    durableObjects: classes,
  };
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // The bindings point at objects in ingress and conversation-runtime, and at entrypoints in
      // channel-egress and context-store. Tests never call them:
      // they pass fakes to `handle()`, so these stubs only let the runtime start.
      miniflare: {
        workers: [
          stubWorker("kelpie-ingress", { DIRECTORY: "Directory" }),
          stubWorker("kelpie-conversation-runtime", {
            REGISTRY: "Registry",
            AGENT_HOST: "AgentHost",
          }),
          stubWorker("kelpie-channel-egress", {}, ["ChannelForms"]),
          stubWorker("kelpie-context-store", {}, ["ContextStoreAdmin"]),
        ],
      },
    }),
  ],
  // The first test of each file waits for the workerd runtime to start, which takes seconds on a
  // busy machine (#88). These budgets cover that start, not slow tests.
  test: {
    // CI's `test:coverage` fails below these thresholds: a point under the coverage measured
    // when they were set, so it can't drop. Raise them as tests cover more (docs/testing.md).
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      reporter: ["text-summary", "json-summary"],
      thresholds: { statements: 91, branches: 87, functions: 80, lines: 91 },
    },
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
