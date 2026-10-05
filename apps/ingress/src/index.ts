import { DIRECTORY_NAME, type Remote } from "@kelpie/access";
import type { ChannelWebhooksContract } from "@kelpie/channels";
import { TELEGRAM_WEBHOOK_PATH } from "@kelpie/channels/telegram";
import type { ConversationContract } from "@kelpie/conversation/contract";
import { admitSender } from "./admission.ts";
import { handleTelegramWebhook, type TelegramWebhookDeps } from "./telegram-webhook.ts";

export { Directory } from "./directory/directory.ts";

function telegramDeps(env: Env): TelegramWebhookDeps {
  return {
    // A service binding to channel-egress's ChannelWebhooks entrypoint, which returns values only.
    webhooks: env.CHANNEL_WEBHOOKS as unknown as ChannelWebhooksContract,
    admit: (event) => admitSender(env, event),
    directory: env.DIRECTORY.getByName(DIRECTORY_NAME),
    // Conversations live in conversation-runtime, which `wrangler types` can't type; its
    // ConversationAgent implements this contract.
    ingest: (name, message) =>
      (env.CONVERSATION_AGENT.getByName(name) as unknown as Remote<ConversationContract>).ingest(
        message,
      ),
  };
}

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (request.method === "GET" && pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    const prefix = `${TELEGRAM_WEBHOOK_PATH}/`;
    if (request.method === "POST" && pathname.startsWith(prefix)) {
      // An agent id is a slug, so the segment is used as it comes; anything encoded is refused.
      return handleTelegramWebhook(request, pathname.slice(prefix.length), telegramDeps(env));
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
