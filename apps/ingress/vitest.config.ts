import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Ingress binds channel-egress's webhook checks and conversation-runtime's conversations.
      // Tests pass fakes to `handleTelegramWebhook()`; these stubs let the runtime start, and the
      // egress one refuses every secret so the routing test stops there.
      miniflare: {
        workers: [
          {
            name: "kelpie-channel-egress",
            modules: true,
            compatibilityDate: "2026-10-01",
            script: `import { WorkerEntrypoint } from "cloudflare:workers";
export class ChannelWebhooks extends WorkerEntrypoint {
  verifyTelegram() { return { ok: false, reason: "refused" }; }
}
export default { fetch: () => new Response(null, { status: 404 }) };`,
          },
          {
            name: "kelpie-conversation-runtime",
            modules: true,
            compatibilityDate: "2026-10-01",
            script: `import { DurableObject } from "cloudflare:workers";
export class ConversationAgent extends DurableObject {}
export default { fetch: () => new Response(null, { status: 404 }) };`,
            durableObjects: { CONVERSATION_AGENT: "ConversationAgent" },
          },
        ],
      },
    }),
  ],
});
