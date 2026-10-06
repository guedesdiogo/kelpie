import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Ingress binds channel-egress's webhook checks, context-store's GitHub webhook and
      // conversation-runtime's conversations.
      // Most tests pass fakes to `handleTelegramWebhook()`. These stubs let the routing tests run
      // the production wiring: egress accepts one secret, and a conversation keeps what it gets and
      // echoes the headers of a webchat upgrade.
      miniflare: {
        workers: [
          {
            name: "kelpie-channel-egress",
            modules: true,
            compatibilityDate: "2026-10-01",
            script: `import { WorkerEntrypoint } from "cloudflare:workers";
export class ChannelWebhooks extends WorkerEntrypoint {
  verifyTelegram(_agentId, secret) {
    return secret === "routed-secret" ? { ok: true } : { ok: false, reason: "refused" };
  }
}
export default { fetch: () => new Response(null, { status: 404 }) };`,
          },
          {
            name: "kelpie-context-store",
            modules: true,
            compatibilityDate: "2026-10-01",
            script: `import { WorkerEntrypoint } from "cloudflare:workers";
export class GitHubWebhooks extends WorkerEntrypoint {
  receive(delivery) {
    if (delivery.signature !== "sha256=${"a".repeat(64)}") return { status: 401 };
    return { status: delivery.event === "push" && delivery.body === "{}" ? 202 : 400 };
  }
}
export default { fetch: () => new Response(null, { status: 404 }) };`,
          },
          {
            name: "kelpie-conversation-runtime",
            modules: true,
            compatibilityDate: "2026-10-01",
            script: `import { DurableObject } from "cloudflare:workers";
export class ConversationAgent extends DurableObject {
  // The webchat's upgrade: the socket's first frame echoes the headers this object received.
  async fetch(request) {
    const pair = new WebSocketPair();
    pair[1].accept();
    pair[1].send(JSON.stringify(Object.fromEntries(request.headers)));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  async ingest(message) {
    await this.ctx.storage.put("received", message);
    return { status: "accepted", flushAt: null };
  }
  async received() {
    return (await this.ctx.storage.get("received")) ?? null;
  }
}
export default { fetch: () => new Response(null, { status: 404 }) };`,
            durableObjects: { CONVERSATION_AGENT: "ConversationAgent" },
          },
        ],
      },
    }),
  ],
  // The first test of each file waits for the workerd runtime to start, which takes seconds on a
  // busy machine (#88). These budgets cover that start, not slow tests.
  test: {
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
