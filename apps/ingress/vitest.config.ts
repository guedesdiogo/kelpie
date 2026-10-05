import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Ingress binds channel-egress's webhook checks and conversation-runtime's conversations.
      // Most tests pass fakes to `handleTelegramWebhook()`. These stubs let the routing tests run
      // the production wiring: egress accepts one secret, and a conversation keeps what it gets.
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
            name: "kelpie-conversation-runtime",
            modules: true,
            compatibilityDate: "2026-10-01",
            script: `import { DurableObject } from "cloudflare:workers";
export class ConversationAgent extends DurableObject {
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
});
