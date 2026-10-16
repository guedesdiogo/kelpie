import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The Workers' own code runs in workerd; the webchat page's modules run in a browser-like DOM.
const workers = cloudflareTest({
  wrangler: { configPath: "./wrangler.jsonc" },
  // Ingress binds channel-egress's webhook checks, context-store's GitHub webhook, and
  // conversation-runtime's conversations and deploy probe.
  // Most tests pass fakes to `handleTelegramWebhook()`. These stubs let the routing tests run
  // the production wiring: egress accepts one secret, a conversation keeps what it gets and
  // echoes the headers of a webchat upgrade, and the deploy's probe finds every part ok.
  miniflare: {
    // The deploy probe's token, as the deploy workflow uploads it (#234).
    bindings: { DEPLOY_PROBE_TOKEN: "deploy-probe-token-for-tests-0123456789" },
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
        script: `import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
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
// Agents as the Registry holds them (#288): one that chats, and one whose chat is off.
export class Registry extends DurableObject {
  get(id) {
    if (id === "assistant") {
      return { id, name: "Assistant", role: "specialist", owner: "kelpie", chat: true };
    }
    if (id === "quiet") {
      return { id, name: "Quiet", role: "specialist", owner: "kelpie", chat: false };
    }
    // As a Registry from before #288 answers, during a partial rollback: no role, no chat.
    if (id === "legacy") return { id, name: "Legacy" };
    return null;
  }
}
export class SetupEvents extends WorkerEntrypoint {
  setupDone() {}
}
// Each agent's mascot for the webchat's list (ADR-0050 §7): none in the routing tests.
export class AgentLooks extends WorkerEntrypoint {
  mascots() {
    return {};
  }
}
export class DeployProbe extends WorkerEntrypoint {
  probe() {
    return { registry: "ok", agentHosts: "ok", gateway: "ok" };
  }
}
export default { fetch: () => new Response(null, { status: 404 }) };`,
        durableObjects: { CONVERSATION_AGENT: "ConversationAgent", REGISTRY: "Registry" },
      },
    ],
  },
});

export default defineConfig({
  test: {
    // CI's `test:coverage` fails under 80% on any of these, in every workspace (ADR-0030).
    coverage: {
      provider: "istanbul",
      // The webchat's page (#140) and the mascot's data and pure logic. mascot.js and the bot's
      // photo (mascot-photo.js, ADR-0046) paint on a canvas, which the page's DOM doesn't have, so
      // they are checked in a browser.
      include: ["src/**/*.ts", "public/webchat/*.js"],
      exclude: ["src/**/*.d.ts", "public/webchat/mascot.js", "public/webchat/mascot-photo.js"],
      reporter: ["text-summary", "json-summary"],
      thresholds: { statements: 80, branches: 80, functions: 80, lines: 80 },
    },
    projects: [
      {
        plugins: [workers],
        test: {
          name: "workers",
          include: ["test/**/*.test.ts"],
          // The mascot's test reads its stylesheet's tokens as text; Vitest empties CSS otherwise.
          css: { include: [/mascot\.css/, /tokens\.css/] },
          // The first test of each file waits for the workerd runtime to start, which takes seconds
          // on a busy machine (#88). These budgets cover that start, not slow tests.
          testTimeout: 20_000,
          hookTimeout: 30_000,
        },
      },
      {
        test: {
          name: "page",
          include: ["test/page/**/*.test.js"],
          environment: "happy-dom",
          // Each file's first test imports the page; with coverage's instrumentation that takes
          // seconds on a busy machine.
          testTimeout: 20_000,
          // The page's tests import its modules themselves; nothing is fetched from a server.
          environmentOptions: {
            happyDOM: {
              settings: {
                disableCSSFileLoading: true,
                disableJavaScriptFileLoading: true,
                // A file it doesn't load isn't an error to log.
                handleDisabledFileLoadingAsSuccess: true,
              },
            },
          },
        },
      },
    ],
  },
});
