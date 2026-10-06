import { DIRECTORY_NAME, type Remote, remoteKeySet, verifyAccessJwt } from "@kelpie/access";
import type { ChannelWebhooksContract } from "@kelpie/channels";
import { TELEGRAM_WEBHOOK_PATH } from "@kelpie/channels/telegram";
import { REGISTRY_NAME, type RegistryContract, versionReport } from "@kelpie/config";
import type { ConversationContract } from "@kelpie/conversation/contract";
import { admitSender } from "./admission.ts";
import {
  GITHUB_WEBHOOK_PATH,
  type GitHubWebhookDeps,
  handleGitHubWebhook,
} from "./github-webhook.ts";
import { handleTelegramWebhook, type TelegramWebhookDeps } from "./telegram-webhook.ts";
import { connectWebchat, handleWebchat, WEBCHAT_PATH, type WebchatDeps } from "./webchat.ts";

export { Directory } from "./directory/directory.ts";

/**
 * Conversations live in conversation-runtime, which `wrangler types` can't type; its
 * ConversationAgent implements this contract.
 */
function conversation(env: Env, name: string): Remote<ConversationContract> {
  return env.CONVERSATION_AGENT.getByName(name) as unknown as Remote<ConversationContract>;
}

function telegramDeps(env: Env): TelegramWebhookDeps {
  return {
    // A service binding to channel-egress's ChannelWebhooks entrypoint, which returns values only.
    webhooks: env.CHANNEL_WEBHOOKS as unknown as ChannelWebhooksContract,
    admit: (event) => admitSender(env, event),
    directory: env.DIRECTORY.getByName(DIRECTORY_NAME),
    ingest: (name, message) => conversation(env, name).ingest(message),
    pause: (name, target) => conversation(env, name).pause(target),
  };
}

function webchatDeps(env: Env): WebchatDeps {
  // A trailing slash would never match the token's issuer.
  const config = {
    teamDomain: env.ACCESS_TEAM_DOMAIN.replace(/\/+$/, ""),
    audience: env.ACCESS_AUD,
  };
  const keys = remoteKeySet(`${config.teamDomain}/cdn-cgi/access/certs`);
  return {
    authenticate: (request) =>
      verifyAccessJwt(
        request.headers.get("cf-access-jwt-assertion"),
        config,
        keys,
        Math.floor(Date.now() / 1_000),
      ),
    admit: (identity, agentId) => env.DIRECTORY.getByName(DIRECTORY_NAME).admit(identity, agentId),
    // The registry lives in conversation-runtime; its Registry implements this contract.
    agentExists: async (agentId) =>
      (await (env.REGISTRY.getByName(REGISTRY_NAME) as unknown as Remote<RegistryContract>).get(
        agentId,
      )) !== null,
    page: (request) => env.ASSETS.fetch(request),
    connect: (name, admission) => connectWebchat(env, name, admission),
  };
}

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (request.method === "GET" && pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    // Public like /health: the repository is public, and the webchat's footer reads it (#148).
    if (request.method === "GET" && pathname === "/version") {
      return Response.json(versionReport(env.CF_VERSION_METADATA), {
        headers: { "cache-control": "no-store" },
      });
    }

    if (request.method === "POST" && pathname === GITHUB_WEBHOOK_PATH) {
      // A service binding to context-store's GitHubWebhooks entrypoint, which answers with a status.
      return handleGitHubWebhook(request, env.GITHUB_WEBHOOKS as unknown as GitHubWebhookDeps);
    }

    if (
      request.method === "GET" &&
      (pathname === WEBCHAT_PATH || pathname.startsWith(`${WEBCHAT_PATH}/`))
    ) {
      return handleWebchat(request, webchatDeps(env));
    }

    const prefix = `${TELEGRAM_WEBHOOK_PATH}/`;
    if (request.method === "POST" && pathname.startsWith(prefix)) {
      // An agent id is a slug, so the segment is used as it comes; anything encoded is refused.
      return handleTelegramWebhook(request, pathname.slice(prefix.length), telegramDeps(env));
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
