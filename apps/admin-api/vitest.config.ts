import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/** A Worker that only declares the Durable Object classes another Worker binds to. */
function stubWorker(name: string, classes: Record<string, string>) {
  const declarations = Object.values(classes)
    .map((className) => `export class ${className} extends DurableObject {}`)
    .join("\n");
  return {
    name,
    modules: true,
    compatibilityDate: "2026-10-01",
    script: `import { DurableObject } from "cloudflare:workers";
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
        ],
      },
    }),
  ],
});
