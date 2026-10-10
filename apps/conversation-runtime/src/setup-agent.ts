import type { Locale, Localized } from "@kelpie/channels";
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
// external account waits for the owner's own yes (ADR-0013, ADR-0026): a confirmation the host
// gates in code, or the owner's act on an admin API page whose link the host sends itself.

/** Its persona, until the owner configures another. */
export const SETUP_PROMPT = `You are Kelpie's setup agent. You help the owner configure Kelpie by talking: creating their agents, connecting each agent's Telegram bot, and pairing the owner's own Telegram account with it. Reply in the language the owner writes in.

How you work:
- Make every change with your tools, and never say you made one your tools didn't confirm.
- For a first setup, go in this order: see which agents exist (list_agents); create the first agent, with a short id of lowercase letters, digits and hyphens, and a name (create_agent); connect its Telegram bot (connect_telegram); then pair the owner's Telegram account with it (pair_telegram). Changing an agent's model or prompt (configure_agent) is optional.
- Changing an agent's settings needs the owner's confirmation. Kelpie itself shows them what will change, with a Confirm button in the webchat or a code to reply with: don't ask them to confirm in other words, and never make up a code. Once they confirm, call the same tool again with the same input.
- Kelpie itself sends the owner the links of connect_telegram and pair_telegram, in a message of its own after your reply. Never write those links yourself, and never make one up: just tell the owner to open the link Kelpie sent. What the owner does on that page is their yes.
- Never ask for a secret in the chat, such as a bot token or an API key. A bot token goes only into the secure form connect_telegram has Kelpie send. If the owner pastes a secret in the chat anyway, tell them to revoke it and make a new one.
- To make a Telegram bot, the owner sends /newbot to BotFather on Telegram, which answers with the bot's token. Have them do that first, and only then call connect_telegram: its form works once and only for a few minutes. Tell them to submit the form once and wait for its page; a page that says the link was already used means the bot is connected.
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
      "Change some of an agent's settings. It needs the owner's confirmation: the first call shows them the change, with a Confirm button in the webchat or a code to reply with; call it again with the same input once they confirm.",
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
      "Start connecting an agent's Telegram bot: Kelpie sends the owner a one-time link to a secure form, where they paste the bot's token. Submitting the form is their yes.",
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
      "Have Kelpie send the owner the link to the page that pairs their own Telegram account with an agent's bot, once the bot is connected.",
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
/** What a tool whose link the host sends says about it: never the link. */
const LINK_SENT =
  "Kelpie sends the owner the link in a message of its own, right after your reply: don't write a link yourself. If they say they didn't get it, call this tool again.";

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

/**
 * What the owner reads (#187): the confirmation's summary, and the bubbles with the links Kelpie
 * sends, which name an agent by its id only.
 */
const TEXTS: Localized<{
  settingTo: string;
  changeSettings: (agent: string, id: string, changes: string) => string;
  form: (id: string, href: string, minutes: number) => string;
  pairing: (id: string, href: string) => string;
}> = {
  en: {
    settingTo: "to",
    changeSettings: (agent, id, changes) =>
      `change the settings of the agent ${agent} (${id}): ${changes}.`,
    form: (id, href, minutes) =>
      `The secure form to connect the Telegram bot of the agent ${id}: ${href}\nIt works once, for the next ${minutes} minutes. Paste the bot's token there, never in the chat.`,
    pairing: (id, href) =>
      `To pair your own Telegram account with the bot of the agent ${id}, open ${href} and press its button.`,
  },
  "pt-BR": {
    settingTo: "para",
    changeSettings: (agent, id, changes) =>
      `alterar as configurações do agente ${agent} (${id}): ${changes}.`,
    form: (id, href, minutes) =>
      `O formulário seguro para conectar o bot do Telegram do agente ${id}: ${href}\nFunciona uma vez, nos próximos ${minutes} minutos. Cole o token do bot lá, nunca no chat.`,
    pairing: (id, href) =>
      `Para parear sua própria conta do Telegram com o bot do agente ${id}, abra ${href} e toque no botão da página.`,
  },
  es: {
    settingTo: "a",
    changeSettings: (agent, id, changes) =>
      `cambiar la configuración del agente ${agent} (${id}): ${changes}.`,
    form: (id, href, minutes) =>
      `El formulario seguro para conectar el bot de Telegram del agente ${id}: ${href}\nFunciona una vez, durante los próximos ${minutes} minutos. Pega allí el token del bot, nunca en el chat.`,
    pairing: (id, href) =>
      `Para vincular tu propia cuenta de Telegram con el bot del agente ${id}, abre ${href} y pulsa el botón de la página.`,
  },
};

/** The setting changes, for the owner's confirmation: each as its key and its exact value. */
function describe(settings: Partial<AgentSettings>, locale: Locale): string {
  return Object.entries(settings)
    .map(([key, value]) => `${key} ${TEXTS[locale].settingTo} ${JSON.stringify(value)}`)
    .join(", ");
}

/** An admin page's link, in the conversation's language, so the page opens in it too (#187). */
const pageLink = (origin: string, path: string, locale: Locale) =>
  `${origin}${path}?lang=${locale}`;

/** The origin, when the value is a bare https origin; otherwise empty, as if it weren't set. */
export function bareHttpsOrigin(value: string): string {
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
 * bare https origin counts as unset, so a mistyped value gives no link. `now` tells how long a
 * form has left: a duration, which the model passes on without turning a time into a zone.
 */
export function setupTools(
  commands: SetupCommands,
  options: { adminOrigin: string; now?: () => number },
): ToolProvider {
  const adminOrigin = bareHttpsOrigin(options.adminOrigin);
  const now = options.now ?? (() => Date.now());
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
      label: { en: "Listing agents", "pt-BR": "Listando agentes", es: "Listando agentes" },
      async run(_input, context) {
        const result = await commands.listAgents(context.actor);
        if (!result.ok) return refusal(result);
        return { output: result.value.map(({ id, name }) => `- ${id}: ${name}`).join("\n") };
      },
    },
    {
      spec: SPECS.get_agent,
      label: { en: "Reading an agent", "pt-BR": "Lendo um agente", es: "Leyendo un agente" },
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
      label: { en: "Creating an agent", "pt-BR": "Criando um agente", es: "Creando un agente" },
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
      label: {
        en: "Renaming an agent",
        "pt-BR": "Renomeando um agente",
        es: "Renombrando un agente",
      },
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
      label: {
        en: "Changing an agent's settings",
        "pt-BR": "Alterando as configurações de um agente",
        es: "Cambiando la configuración de un agente",
      },
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
        const summary = TEXTS[context.locale].changeSettings(
          JSON.stringify(agent.name),
          agent.id,
          describe(parsed, context.locale),
        );
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
      label: {
        en: "Connecting a Telegram bot",
        "pt-BR": "Conectando um bot do Telegram",
        es: "Conectando un bot de Telegram",
      },
      async run(input, context) {
        if (!isOwner(context)) return NOT_OWNER;
        if (adminOrigin === "") return NOT_CONFIGURED;
        const { agentId } = fields(input);
        const agent = await agentOf(context, agentId);
        if (!("id" in agent)) return agent;
        // Opening a form changes nothing: the owner's submitting it, behind Access and the owner
        // check, is the yes (ADR-0026). Kelpie sends its link, so the model can't alter it.
        const result = await commands.connectTelegram(context.actor, { agentId: agent.id });
        if (!result.ok) return refusal(result, agent.id);
        const href = pageLink(adminOrigin, result.value.path, context.locale);
        const minutes = Math.max(Math.round((result.value.expiresAt - now()) / 60_000), 1);
        // The agent by its id only: its name is the model's, and the bubble is formatted.
        context.sendLink({ href, text: TEXTS[context.locale].form(agent.id, href, minutes) });
        return {
          output: `${LINK_SENT}\nThe form works once, for the next ${minutes} minutes. The owner pastes the bot's token there, never in the chat; submitting it is their yes. The form points the bot at Kelpie when it saves the token.`,
        };
      },
    },
    {
      spec: SPECS.pair_telegram,
      label: { en: "Pairing Telegram", "pt-BR": "Pareando o Telegram", es: "Vinculando Telegram" },
      async run(input, context) {
        if (!isOwner(context)) return NOT_OWNER;
        if (adminOrigin === "") return NOT_CONFIGURED;
        const { agentId } = fields(input);
        const agent = await agentOf(context, agentId);
        if (!("id" in agent)) return agent;
        const href = pageLink(adminOrigin, `/pair/telegram/${agent.id}`, context.locale);
        context.sendLink({ href, text: TEXTS[context.locale].pairing(agent.id, href) });
        return {
          output: `${LINK_SENT}\nOn that page the owner presses a button, and gets a Telegram link that pairs the account they open it with as theirs. The agent's bot must be connected first.`,
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
