import {
  type AgentSettings,
  type CommandResult,
  type ConfigCommands,
  isAgentId,
  parseSettings,
  SETUP_AGENT_ID,
} from "@kelpie/config";
// The router module only: the package root also loads the provider SDKs.
import { MODEL_TIERS } from "@kelpie/llm/router";
import {
  MAX_SUMMARY_CHARS,
  type Tool,
  type ToolContext,
  type ToolOutcome,
  type ToolProvider,
  visible,
} from "./tools.ts";

// The built-in setup agent (Story 3.11, ADR-0013): the owner configures Kelpie by talking to it, in
// the webchat. Every instance has it (the Registry seeds it), and only it gets these tools: the
// configuration commands the admin API runs, with the same checks. A change to access, cost or an
// external account waits for the owner's confirmation, which the host gates in code.

/** Its persona, until the owner configures another. */
export const SETUP_PROMPT = `You are Kelpie's setup agent. You help the owner configure Kelpie by talking: creating their agents, connecting each agent's Telegram bot, and pairing the owner's own Telegram account with it. Reply in the language the owner writes in.

How you work:
- Make every change with your tools, and never say you made one your tools didn't confirm.
- For a first setup, go in this order: see which agents exist (list_agents); create the first agent, with a short id of lowercase letters, digits and hyphens, and a name (create_agent); connect its Telegram bot (connect_telegram); then pair the owner's Telegram account with it (pair_telegram). Changing an agent's model or prompt (configure_agent) is optional.
- Some changes need the owner's confirmation. Kelpie itself shows them what will change and a code to reply with: don't ask them to confirm in other words, and never make up a code. Once they reply with just the code, call the same tool again with the same input.
- Never ask for a secret in the chat, such as a bot token or an API key. A bot token goes only into the secure form whose link connect_telegram gives. If the owner pastes a secret in the chat anyway, tell them to revoke it and make a new one.
- To make a Telegram bot, the owner sends /newbot to BotFather on Telegram and copies the token it answers with into the form.
- Some steps are outside what you can do: deploying Kelpie's Workers, their bindings and secrets, Cloudflare Access, and the model keys. For those, point the owner to the setup checklist in docs/admin-api.md.`;

/** The commands the setup agent's tools run; the identity and vault commands stay off them. */
export type SetupCommands = Pick<
  ConfigCommands,
  "listAgents" | "getAgent" | "createAgent" | "renameAgent" | "configureAgent" | "connectTelegram"
>;

const AGENT_ID = {
  type: "string",
  description: "The agent's id: lowercase letters, digits and hyphens.",
} as const;

const SPECS = {
  list_agents: {
    name: "list_agents",
    description: "List Kelpie's agents, by id and name.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  get_agent: {
    name: "get_agent",
    description: "Show an agent's name and settings: its model tier, prompt and timings.",
    inputSchema: {
      type: "object",
      properties: { id: AGENT_ID },
      required: ["id"],
      additionalProperties: false,
    },
  },
  create_agent: {
    name: "create_agent",
    description:
      "Create an agent. Its id can't change later: 2 to 40 lowercase letters, digits and hyphens, starting with a letter. Its name is what people see, and can change.",
    inputSchema: {
      type: "object",
      properties: { id: AGENT_ID, name: { type: "string", description: "One line." } },
      required: ["id", "name"],
      additionalProperties: false,
    },
  },
  rename_agent: {
    name: "rename_agent",
    description: "Change an agent's name. Its id stays.",
    inputSchema: {
      type: "object",
      properties: { id: AGENT_ID, name: { type: "string", description: "One line." } },
      required: ["id", "name"],
      additionalProperties: false,
    },
  },
  configure_agent: {
    name: "configure_agent",
    description:
      "Change some of an agent's settings. It needs the owner's confirmation: the first call shows them the change; call it again with the same input once they confirm.",
    inputSchema: {
      type: "object",
      properties: {
        id: AGENT_ID,
        settings: {
          type: "object",
          description: "Only the settings to change.",
          properties: {
            tier: {
              type: "string",
              enum: [...MODEL_TIERS],
              description: "The model's tier; a higher one costs more.",
            },
            systemPrompt: {
              type: "string",
              description: "The agent's instructions.",
            },
            conversational: {
              type: "boolean",
              description: "Answer in short paced bubbles, or each message at once.",
            },
            maxOutputTokens: { type: "integer", minimum: 1, maximum: 64_000 },
            quietMs: {
              type: "integer",
              minimum: 0,
              maximum: 120_000,
              description: "How long to wait after the person's last message before answering.",
            },
            maxWaitMs: { type: "integer", minimum: 0, maximum: 120_000 },
            qualifier: { type: "string", enum: ["clef", "jev"] },
            toolLoopMs: { type: "integer", minimum: 120_000, maximum: 600_000 },
          },
          additionalProperties: false,
        },
      },
      required: ["id", "settings"],
      additionalProperties: false,
    },
  },
  connect_telegram: {
    name: "connect_telegram",
    description:
      "Start connecting an agent's Telegram bot. It needs the owner's confirmation: once they confirm and you call it again, it gives a one-time link to a secure form where they paste the bot's token.",
    inputSchema: {
      type: "object",
      properties: { agentId: AGENT_ID },
      required: ["agentId"],
      additionalProperties: false,
    },
  },
  pair_telegram: {
    name: "pair_telegram",
    description:
      "Give the owner a link that pairs their own Telegram account with an agent's bot, once the bot is connected.",
    inputSchema: {
      type: "object",
      properties: { agentId: AGENT_ID },
      required: ["agentId"],
      additionalProperties: false,
    },
  },
} satisfies Record<string, Tool["spec"]>;

const failed = (output: string): ToolOutcome => ({ output, isError: true });
const fields = (input: unknown): Record<string, unknown> =>
  typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};

const NOT_OWNER = failed("Only the owner can change Kelpie's configuration.");
const NOT_CONFIGURED = failed(
  "Kelpie's admin API address isn't set (ADMIN_ORIGIN on conversation-runtime), so I can't give its link. The owner sets it when deploying: see docs/admin-api.md.",
);
const WAITING =
  "Not done yet: Kelpie showed the owner this change, and how to confirm it. Tell them it waits for their confirmation. Once they confirm, call this tool again with the same input.";

/** A refusal, in words the model can act on. */
function refusal(result: Extract<CommandResult<unknown>, { ok: false }>, id?: string): ToolOutcome {
  switch (result.reason) {
    case "forbidden":
      return NOT_OWNER;
    case "unknown_agent":
      return failed(`There is no agent with the id ${id}.`);
    case "invalid_input":
      return failed("That input isn't valid.");
    default:
      return failed("That didn't work: a Kelpie service didn't answer. Try again in a moment.");
  }
}

/** The setting changes, for the owner's confirmation: each as its key and its exact value. */
function describe(settings: Partial<AgentSettings>): string {
  return Object.entries(settings)
    .map(([key, value]) => `${key} to ${JSON.stringify(value)}`)
    .join(", ");
}

/** The origin, when the value is a bare https origin; otherwise empty, as if it weren't set. */
function bareHttpsOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "";
  }
  const bare =
    url.protocol === "https:" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "" &&
    url.username === "" &&
    url.password === "";
  return bare ? url.origin : "";
}

/**
 * The setup agent's tools, over the configuration commands. `adminOrigin` is the admin API's
 * origin (`ADMIN_ORIGIN`), for the links to its secure form and its pairing page; anything but a
 * bare https origin counts as unset, so a mistyped value gives no link.
 */
export function setupTools(
  commands: SetupCommands,
  options: { adminOrigin: string },
): ToolProvider {
  const adminOrigin = bareHttpsOrigin(options.adminOrigin);
  const isOwner = (context: ToolContext) => context.actor.role === "owner";

  /** The agent, or the tool's refusal: checked before anything is shown to the owner. */
  async function agentOf(
    context: ToolContext,
    id: unknown,
  ): Promise<{ id: string; name: string } | ToolOutcome> {
    if (!isAgentId(id))
      return failed("That isn't an agent id: lowercase letters, digits and hyphens.");
    const agent = await commands.getAgent(context.actor, { id });
    return agent.ok ? { id, name: agent.value.name } : refusal(agent, id);
  }

  const tools: Tool[] = [
    {
      spec: SPECS.list_agents,
      label: "Listing agents",
      async run(_input, context) {
        const result = await commands.listAgents(context.actor);
        if (!result.ok) return refusal(result);
        return { output: result.value.map(({ id, name }) => `- ${id}: ${name}`).join("\n") };
      },
    },
    {
      spec: SPECS.get_agent,
      label: "Reading an agent",
      async run(input, context) {
        const { id } = fields(input);
        if (!isAgentId(id))
          return failed("That isn't an agent id: lowercase letters, digits and hyphens.");
        const result = await commands.getAgent(context.actor, { id });
        if (!result.ok) return refusal(result, id);
        return { output: JSON.stringify(result.value, null, 2) };
      },
    },
    {
      spec: SPECS.create_agent,
      label: "Creating an agent",
      async run(input, context) {
        const { id, name } = fields(input);
        const result = await commands.createAgent(context.actor, { id, name });
        if (!result.ok) {
          if (result.reason !== "invalid_input") return refusal(result);
          return failed(
            `That id or name isn't valid. An id is 2 to 40 lowercase letters, digits and hyphens, starting with a letter, and "${SETUP_AGENT_ID}" is taken; a name is one line of up to 80 characters.`,
          );
        }
        const { value } = result;
        return {
          output: value.created
            ? `Created the agent ${value.id}, named ${JSON.stringify(value.name)}.`
            : `The agent ${value.id} already exists; nothing changed.`,
        };
      },
    },
    {
      spec: SPECS.rename_agent,
      label: "Renaming an agent",
      async run(input, context) {
        const { id, name } = fields(input);
        const result = await commands.renameAgent(context.actor, { id, name });
        if (!result.ok) return refusal(result, typeof id === "string" ? id : undefined);
        return {
          output: `The agent ${result.value.id} is now named ${JSON.stringify(result.value.name)}.`,
        };
      },
    },
    {
      spec: SPECS.configure_agent,
      label: "Changing an agent's settings",
      async run(input, context) {
        if (!isOwner(context)) return NOT_OWNER;
        const { id, settings } = fields(input);
        const parsed = parseSettings(settings);
        if (!parsed || Object.keys(parsed).length === 0) {
          return failed(
            "Those settings aren't valid. Pass only the settings to change, each with an allowed value.",
          );
        }
        const agent = await agentOf(context, id);
        if (!("id" in agent)) return agent;
        const change = { id: agent.id, settings: parsed };
        const summary = `change the settings of the agent ${JSON.stringify(agent.name)} (${agent.id}): ${describe(parsed)}.`;
        // The owner confirms what they see, and one bubble shows the whole change, or nothing.
        if (visible(summary).length > MAX_SUMMARY_CHARS) {
          return failed(
            "That change is too long to show the owner for confirmation here: make it through the admin API.",
          );
        }
        const confirmed = await context.confirm({
          command: "configureAgent",
          input: change,
          summary,
        });
        if (!confirmed) return { output: WAITING };
        const result = await commands.configureAgent(context.actor, change);
        if (!result.ok) return refusal(result, change.id);
        return { output: `Changed the settings of the agent ${change.id}.` };
      },
    },
    {
      spec: SPECS.connect_telegram,
      label: "Connecting a Telegram bot",
      async run(input, context) {
        if (!isOwner(context)) return NOT_OWNER;
        if (adminOrigin === "") return NOT_CONFIGURED;
        const { agentId } = fields(input);
        const agent = await agentOf(context, agentId);
        if (!("id" in agent)) return agent;
        const request = { agentId: agent.id };
        // The admin API's origin comes from the deploy, so the owner can check the link they get.
        const confirmed = await context.confirm({
          command: "connectTelegram",
          input: request,
          summary: `connect a Telegram bot to the agent ${JSON.stringify(agent.name)} (${agent.id}), through a one-time form for its token on ${adminOrigin}.`,
        });
        if (!confirmed) return { output: WAITING };
        const result = await commands.connectTelegram(context.actor, request);
        if (!result.ok) return refusal(result, request.agentId);
        return {
          output: `Give the owner this link to the secure form: ${adminOrigin}${result.value.path}\nIt works once, until ${new Date(result.value.expiresAt).toISOString()}. They paste the bot's token there, never in the chat. The form points the bot at Kelpie when it saves the token.`,
        };
      },
    },
    {
      spec: SPECS.pair_telegram,
      label: "Pairing Telegram",
      async run(input, context) {
        if (!isOwner(context)) return NOT_OWNER;
        if (adminOrigin === "") return NOT_CONFIGURED;
        const { agentId } = fields(input);
        const agent = await agentOf(context, agentId);
        if (!("id" in agent)) return agent;
        return {
          output: `Give the owner this link: ${adminOrigin}/pair/telegram/${agent.id}\nOn that page they press a button, and get a Telegram link that pairs the account they open it with as theirs. The agent's bot must be connected first.`,
        };
      },
    },
  ];

  return {
    async tools(agentId) {
      return agentId === SETUP_AGENT_ID ? tools : [];
    },
  };
}
