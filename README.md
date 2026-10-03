# Kelpie

> Herds your AI agents across every channel, at the edge.

Kelpie is a multi-tenant, multi-agent AI assistant harness that connects chat channels (WhatsApp, Telegram, Discord, Slack and a web chat) to large language models. It is designed for Cloudflare's developer platform: Workers, Durable Objects, Queues and Workflows, event-driven and without containers.

> **Status: design phase.** There is no runnable code yet. The viability study and the architecture decisions are tracked on the [project board](https://github.com/users/guedesdiogo/projects/1).

## Goals

- **Human-paced conversations.** Buffer fragmented user messages before calling the model, and deliver one model reply as several paced messages with a typing indicator where the channel supports it.
- **Memory that compounds.** Agent persona, user profiles, memories and skills live as versioned Markdown files that people and other agents can read and edit.
- **Tools from anywhere.** Remote MCP servers and Composio behind a single tool interface.
- **A qualifier layer.** Typed decisions (which tool, which skill, which memories) go through Jev, TypeSafe AI's decision model, with a fallback that needs no API key.
- **More than one model provider.** Anthropic and OpenAI first, behind a provider interface that leaves room for others.
- **Multi-tenant and multi-agent.** Many agents per tenant, agents that orchestrate other agents, and agents that are not attached to any channel.

## Why "Kelpie"

The Australian kelpie is a herding dog that works on its own, far from its handler, and learns its commands: Kelpie runs agents across channels at the edge and learns skills from conversations. In Celtic folklore a kelpie is a shape-shifting spirit, which suits one harness wearing many agent personas.

## License

No license has been chosen yet. Until one is added, all rights are reserved.
