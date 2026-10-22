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
      // channel-egress, context-store and llm-gateway. The API's tests pass fakes to `handle()`, so
      // most stubs only let the runtime start; llm-gateway's answers the Worker's own test.
      miniflare: {
        workers: [
          stubWorker("kelpie-ingress", { DIRECTORY: "Directory" }),
          // The Registry knows every agent and lists Kelpie as Master, and each task method of the
          // AgentHost answers with its name and arguments, so the Worker's own test checks the
          // task commands' wiring (#54) and finds Master (ADR-0060).
          {
            name: "kelpie-conversation-runtime",
            modules: true,
            compatibilityDate: "2026-10-01",
            script: `import { DurableObject } from "cloudflare:workers";
export class Registry extends DurableObject {
  get(id) {
    return { id, name: id, role: "specialist", owner: "kelpie", chat: false };
  }
  list() {
    return [
      { id: "kelpie", name: "Kelpie", role: "master", owner: null, chat: true },
      { id: "sales", name: "sales", role: "specialist", owner: "kelpie", chat: false },
    ];
  }
}
const echo = (method) =>
  function (...args) {
    return method === "listTasks" ? [{ method, args }] : { ok: true, value: { method, args } };
  };
export class AgentHost extends DurableObject {}
for (const method of ["createTask", "editTask", "moveTask", "commentTask", "requestStop", "listTasks", "getTask"]) {
  AgentHost.prototype[method] = echo(method);
}
export default { fetch: () => new Response(null, { status: 404 }) };`,
            durableObjects: { REGISTRY: "Registry", AGENT_HOST: "AgentHost" },
          },
          stubWorker("kelpie-channel-egress", {}, ["ChannelForms"]),
          stubWorker("kelpie-context-store", {}, ["ContextStoreAdmin"]),
          // The instance's model settings (#289), which the worker test reads through the commands.
          {
            name: "kelpie-llm-gateway",
            modules: true,
            compatibilityDate: "2026-10-01",
            script: `import { WorkerEntrypoint } from "cloudflare:workers";
export class ProviderCheck extends WorkerEntrypoint {}
export class LlmGatewayAdmin extends WorkerEntrypoint {
  providers() {
    return ["anthropic"];
  }
  instanceModels() {
    return { settings: {}, pinned: "anthropic", providers: ["anthropic"] };
  }
  configureDefaults() {
    return { ok: true };
  }
  setClaudeCode(on) {
    return typeof on === "boolean" ? { ok: true } : { ok: false, reason: "invalid_input" };
  }
}
export default { fetch: () => new Response(null, { status: 404 }) };`,
          },
        ],
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
