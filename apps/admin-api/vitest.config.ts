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
      // The bindings point at objects in ingress and conversation-runtime. Tests never call them:
      // they pass fakes to `handle()`, so these stubs only let the runtime start.
      miniflare: {
        workers: [
          stubWorker("kelpie-ingress", { DIRECTORY: "Directory" }),
          stubWorker("kelpie-conversation-runtime", {
            REGISTRY: "Registry",
            AGENT_HOST: "AgentHost",
          }),
          stubWorker("kelpie-channel-egress", {}, ["ChannelForms"]),
        ],
      },
    }),
  ],
});
