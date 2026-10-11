export { AgentHost } from "./agent-host/agent-host.ts";
export { ConversationAgent } from "./conversation-agent.ts";
export { Registry } from "./registry/registry.ts";
export { SetupEvents } from "./setup-events.ts";

export default {
  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
