import type { Locale, Localized } from "@kelpie/channels";
import {
  type AgentEntry,
  type AgentSettings,
  type CommandResult,
  type ConfigCommands,
  isAgentId,
  parseSettings,
  SETUP_AGENT_ID,
  type SetupEvent,
} from "@kelpie/config";
import { type ModelSettings, parseModelSettings } from "@kelpie/llm/models";
// The router module only: the package root also loads the provider SDKs.
import { MODEL_TIERS } from "@kelpie/llm/router";
import { MODEL_SETTINGS_SCHEMA } from "./model-schema.ts";
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
- Kelpie's agents have roles. The main agent is the one the owner talks to: a new instance starts with one, Kelpie, and set_main_agent makes another agent the main one. If list_agents shows no main agent, ask the owner which agent should be it. Every other agent is a specialist, and the owner can chat with a specialist only once its chat is on (set_agent_chat).
- For a first setup, go in this order: see which agents exist (list_agents); connect the main agent's Telegram bot (connect_telegram); then pair the owner's Telegram account with it (pair_telegram). Create another agent, with a short id of lowercase letters, digits and hyphens, and a name (create_agent), only when the owner asks for one; to talk to it, its chat must be on. Changing an agent's model or prompt (configure_agent) is optional.
- Changing an agent's settings, the main agent or an agent's chat needs the owner's confirmation. Kelpie itself shows them what will change, with a Confirm button in the webchat or a code to reply with: don't ask them to confirm in other words, and never make up a code. Once they confirm, call the same tool again with the same input.
- Kelpie itself sends the owner the links of connect_telegram and pair_telegram, in a message of its own after your reply. Never write those links yourself, and never make one up: just tell the owner to open the link Kelpie sent. What the owner does on that page is their yes.
- When the owner finishes on one of those pages, Kelpie tells you in this conversation, in a note that starts "Kelpie, automatically". Don't ask them to tell you when they're done: when the note comes, go on with the next step.
- Never ask for a secret in the chat, such as a bot token or an API key. A bot token goes only into the secure form connect_telegram has Kelpie send. If the owner pastes a secret in the chat anyway, tell them to revoke it and make a new one.
- To make a Telegram bot, the owner sends /newbot to BotFather on Telegram, which answers with the bot's token. Have them do that first, and only then call connect_telegram: its form works once and only for a few minutes. Tell them to submit the form once and wait for its page; a page that says the link was already used means the bot is connected.
- Some steps are outside what you can do: deploying Kelpie's Workers, their bindings and secrets, Cloudflare Access, and the model keys. For those, point the owner to the setup checklist in docs/admin-api.md.`;

/** The commands the setup agent's tools run; the identity and vault commands stay off them. */
export type SetupCommands = Pick<
  ConfigCommands,
  | "listAgents"
  | "getAgent"
  | "createAgent"
  | "renameAgent"
  | "configureAgent"
  | "getModels"
  | "configureModels"
  | "setMainAgent"
  | "setAgentChat"
  | "connectTelegram"
>;

const AGENT_ID = {
  type: "string",
  description: "The agent's id: lowercase letters, digits and hyphens.",
} as const;

const SPECS = {
  list_agents: {
    name: "list_agents",
    description:
      "List Kelpie's agents, by id and name, with each one's role and whether the owner can chat with it.",
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
      "Create an agent. Its id can't change later: 2 to 40 lowercase letters, digits and hyphens, starting with a letter. Its name is what people see, and can change. A new agent is a specialist whose chat is off.",
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
            model: MODEL_SETTINGS_SCHEMA,
          },
          additionalProperties: false,
        },
      },
      required: ["id", "settings"],
      additionalProperties: false,
    },
  },
  get_models: {
    name: "get_models",
    description:
      "Show the instance's model settings, which every agent follows unless it has its own, the provider pinned as the default, and the providers that have a key.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  configure_models: {
    name: "configure_models",
    description:
      "Replace the instance's model settings: pass them whole, as get_models shows them, with the change. It needs the owner's confirmation, as configure_agent does.",
    inputSchema: {
      type: "object",
      properties: { settings: MODEL_SETTINGS_SCHEMA },
      required: ["settings"],
      additionalProperties: false,
    },
  },
  set_main_agent: {
    name: "set_main_agent",
    description:
      "Make an agent the main agent: the one the owner talks to, which owns the specialists. The previous main agent becomes a specialist and keeps its chat. It needs the owner's confirmation: the first call shows them the change; call it again with the same input once they confirm.",
    inputSchema: {
      type: "object",
      properties: { id: AGENT_ID },
      required: ["id"],
      additionalProperties: false,
    },
  },
  set_agent_chat: {
    name: "set_agent_chat",
    description:
      "Turn a specialist's chat on or off: whether the owner can reach it on its channels. Admin and the main agent always chat. It needs the owner's confirmation, as set_main_agent does.",
    inputSchema: {
      type: "object",
      properties: { id: AGENT_ID, chat: { type: "boolean" } },
      required: ["id", "chat"],
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
const NO_KEY = failed(
  "That provider has no key in llm-gateway, so it can't serve: the owner sets one as a deploy secret (docs/secrets.md). get_models lists the providers that have one.",
);
const NOT_MAIN = failed("Admin can't be the main agent, and a subagent can't either.");
const NOT_SPECIALIST = failed(
  "Only a specialist's chat can change: Admin and the main agent always chat, and a subagent never does.",
);
const NOT_CONFIGURED = failed(
  "Kelpie's admin API address isn't set (ADMIN_ORIGIN on conversation-runtime), so I can't give its link. The owner sets it when deploying: see docs/admin-api.md.",
);
const WAITING =
  "Not done yet: Kelpie showed the owner this change, and how to confirm it. Tell them it waits for their confirmation. Once they confirm, call this tool again with the same input.";
/** What a tool whose link the host sends says about it: never the link. */
const LINK_SENT =
  "Kelpie sends the owner the link in a message of its own, right after your reply: don't write a link yourself. When they finish on that page, Kelpie tells you here, so don't ask them to say when they're done. If they say they didn't get the link, call this tool again.";

/**
 * How long a conversation waits for pairing after sending its link (#206). The page doesn't
 * expire, and the Telegram code's hour starts only when the owner presses its button.
 */
export const PAIRING_WAIT_MS = 24 * 60 * 60_000;

/** A Telegram bot's username: letters, digits and underscores, 5 to 32 of them. */
const BOT_USERNAME = /^[A-Za-z0-9_]{5,32}$/;

/**
 * The note Kelpie writes into the conversation when the owner finished a setup step (#206), from
 * the event's checked fields only, or null for an event that doesn't check out. It says it is
 * Kelpie's, so the model doesn't take it for the owner's words.
 */
export function setupNote(agentId: string, event: SetupEvent): string | null {
  if (!isAgentId(agentId)) return null;
  if (typeof event?.userId !== "string" || event.userId === "" || event.userId.length > 128) {
    return null;
  }
  const kelpie = "Kelpie, automatically (the owner didn't write this):";
  if (event.step === "telegram_paired") {
    return `${kelpie} the owner's pairing link was used: a Telegram account is now paired, as the owner's, with the bot of the agent ${agentId}.`;
  }
  if (event.step !== "telegram_connected" || !BOT_USERNAME.test(String(event.bot))) return null;
  return event.webhookRegistered === true
    ? `${kelpie} the owner submitted the secure form, and the Telegram bot @${event.bot} now answers for the agent ${agentId}.`
    : `${kelpie} the owner submitted the secure form, and the Telegram bot @${event.bot} is connected to the agent ${agentId}, but Telegram couldn't be pointed at Kelpie, so its messages don't reach Kelpie yet. You can't fix that: tell the owner to run the registerTelegramWebhook command on the admin API for ${agentId}.`;
}

/** A refusal, in words the model can act on. */
function refusal(result: Extract<CommandResult<unknown>, { ok: false }>, id?: string): ToolOutcome {
  switch (result.reason) {
    case "forbidden":
      return NOT_OWNER;
    case "unknown_agent":
      return failed(`There is no agent with the id ${id}.`);
    case "invalid_input":
      return failed("That input isn't valid.");
    case "no_key":
      return NO_KEY;
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
  settingFrom: string;
  changeSettings: (agent: string, id: string, changes: string) => string;
  mainAgent: (agent: string, id: string) => string;
  models: (before: string, after: string) => string;
  chat: (agent: string, id: string, on: boolean) => string;
  form: (id: string, href: string, minutes: number) => string;
  pairing: (id: string, href: string) => string;
}> = {
  en: {
    settingTo: "to",
    settingFrom: "from",
    changeSettings: (agent, id, changes) =>
      `change the settings of the agent ${agent} (${id}): ${changes}.`,
    mainAgent: (agent, id) =>
      `make the agent ${agent} (${id}) the main agent, the one you talk to.`,
    models: (before, after) =>
      `set the models every agent uses unless it has its own, from ${before} to ${after}.`,
    chat: (agent, id, on) =>
      on
        ? `let you chat with the agent ${agent} (${id}).`
        : `stop you chatting with the agent ${agent} (${id}).`,
    form: (id, href, minutes) =>
      `The secure form to connect the Telegram bot of the agent ${id}: ${href}\nIt works once, for the next ${minutes} minutes. Paste the bot's token there, never in the chat.`,
    pairing: (id, href) =>
      `To pair your own Telegram account with the bot of the agent ${id}, open ${href} and press its button.`,
  },
  "pt-BR": {
    settingTo: "para",
    settingFrom: "de",
    changeSettings: (agent, id, changes) =>
      `alterar as configurações do agente ${agent} (${id}): ${changes}.`,
    mainAgent: (agent, id) =>
      `tornar o agente ${agent} (${id}) o agente principal, o que conversa com você.`,
    models: (before, after) =>
      `definir os modelos que todo agente usa quando não tem os seus, de ${before} para ${after}.`,
    chat: (agent, id, on) =>
      on
        ? `permitir que você converse com o agente ${agent} (${id}).`
        : `deixar de permitir que você converse com o agente ${agent} (${id}).`,
    form: (id, href, minutes) =>
      `O formulário seguro para conectar o bot do Telegram do agente ${id}: ${href}\nFunciona uma vez, nos próximos ${minutes} minutos. Cole o token do bot lá, nunca no chat.`,
    pairing: (id, href) =>
      `Para parear sua própria conta do Telegram com o bot do agente ${id}, abra ${href} e toque no botão da página.`,
  },
  es: {
    settingTo: "a",
    settingFrom: "de",
    changeSettings: (agent, id, changes) =>
      `cambiar la configuración del agente ${agent} (${id}): ${changes}.`,
    mainAgent: (agent, id) =>
      `convertir el agente ${agent} (${id}) en el agente principal, el que conversa contigo.`,
    models: (before, after) =>
      `definir los modelos que usa todo agente que no tenga los suyos, de ${before} a ${after}.`,
    chat: (agent, id, on) =>
      on
        ? `permitir que converses con el agente ${agent} (${id}).`
        : `dejar de permitir que converses con el agente ${agent} (${id}).`,
    form: (id, href, minutes) =>
      `El formulario seguro para conectar el bot de Telegram del agente ${id}: ${href}\nFunciona una vez, durante los próximos ${minutes} minutos. Pega allí el token del bot, nunca en el chat.`,
    pairing: (id, href) =>
      `Para vincular tu propia cuenta de Telegram con el bot del agente ${id}, abre ${href} y presiona el botón de la página.`,
  },
};

/**
 * The setting changes, for the owner's confirmation: each as its key and its exact value. `model`
 * replaces the agent's whole model settings, so it shows what they were too (#289).
 */
function describe(
  settings: Partial<AgentSettings>,
  locale: Locale,
  modelBefore?: ModelSettings,
): string {
  const { settingTo, settingFrom } = TEXTS[locale];
  return Object.entries(settings)
    .map(([key, value]) =>
      key === "model" && modelBefore !== undefined
        ? `model ${settingFrom} ${JSON.stringify(modelBefore)} ${settingTo} ${JSON.stringify(value)}`
        : `${key} ${settingTo} ${JSON.stringify(value)}`,
    )
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
  async function agentOf(context: ToolContext, id: unknown): Promise<AgentEntry | ToolOutcome> {
    if (!isAgentId(id))
      return failed("That isn't an agent id: lowercase letters, digits and hyphens.");
    const agent = await commands.getAgent(context.actor, { id });
    if (!agent.ok) return refusal(agent, id);
    const { name, role, owner, chat } = agent.value;
    return { id, name, role, owner, chat };
  }

  /** What the model is told when the owner can't reach the agent yet (#288). */
  const chatOff = (agent: AgentEntry) =>
    agent.chat
      ? ""
      : "\nIts chat is off, so it won't answer the owner until set_agent_chat turns it on, with their confirmation.";

  const tools: Tool[] = [
    {
      spec: SPECS.list_agents,
      label: { en: "Listing agents", "pt-BR": "Listando agentes", es: "Listando agentes" },
      async run(_input, context) {
        const result = await commands.listAgents(context.actor);
        if (!result.ok) return refusal(result);
        const line = ({ id, name, role, chat }: AgentEntry) =>
          `- ${id}: ${name} (${role}${role === "specialist" && !chat ? ", chat off" : ""})`;
        return { output: result.value.map(line).join("\n") };
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
            ? `Created the agent ${value.id}, named ${JSON.stringify(value.name)}. It is a specialist, owned by the main agent, and its chat is off: the owner can't reach it until set_agent_chat turns it on.`
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
        const current = parsed.model
          ? await commands.getAgent(context.actor, { id: agent.id })
          : null;
        const summary = TEXTS[context.locale].changeSettings(
          JSON.stringify(agent.name),
          agent.id,
          describe(
            parsed,
            context.locale,
            current?.ok ? (current.value.settings.model ?? {}) : undefined,
          ),
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
      spec: SPECS.get_models,
      label: { en: "Reading the models", "pt-BR": "Lendo os modelos", es: "Leyendo los modelos" },
      async run(_input, context) {
        const result = await commands.getModels(context.actor);
        if (!result.ok) return refusal(result);
        return { output: JSON.stringify(result.value, null, 2) };
      },
    },
    {
      spec: SPECS.configure_models,
      label: {
        en: "Changing the models",
        "pt-BR": "Alterando os modelos",
        es: "Cambiando los modelos",
      },
      async run(input, context) {
        if (!isOwner(context)) return NOT_OWNER;
        const settings = parseModelSettings(fields(input).settings);
        if (!settings) {
          return failed(
            "Those model settings aren't valid: a provider, and each area's provider, tier and effort, from the allowed values.",
          );
        }
        // They replace what the instance has, so the owner sees what that was.
        const current = await commands.getModels(context.actor);
        if (!current.ok) return refusal(current);
        const change = { settings };
        const confirmed = await context.confirm({
          command: "configureModels",
          input: change,
          summary: TEXTS[context.locale].models(
            JSON.stringify(current.value.settings),
            JSON.stringify(settings),
          ),
        });
        if (!confirmed) return { output: WAITING };
        const result = await commands.configureModels(context.actor, change);
        if (!result.ok) return refusal(result);
        return { output: "Changed the models every agent uses unless it has its own." };
      },
    },
    {
      spec: SPECS.set_main_agent,
      label: {
        en: "Choosing the main agent",
        "pt-BR": "Escolhendo o agente principal",
        es: "Eligiendo el agente principal",
      },
      async run(input, context) {
        if (!isOwner(context)) return NOT_OWNER;
        const agent = await agentOf(context, fields(input).id);
        if (!("id" in agent)) return agent;
        // Checked before the owner is asked: a yes that can't change anything isn't asked for.
        if (agent.role === "admin" || agent.role === "subagent") return NOT_MAIN;
        if (agent.role === "main") {
          return { output: `The agent ${agent.id} is already the main agent; nothing changed.` };
        }
        const change = { id: agent.id };
        const confirmed = await context.confirm({
          command: "setMainAgent",
          input: change,
          summary: TEXTS[context.locale].mainAgent(JSON.stringify(agent.name), agent.id),
        });
        if (!confirmed) return { output: WAITING };
        const result = await commands.setMainAgent(context.actor, change);
        if (!result.ok)
          return result.reason === "not_allowed" ? NOT_MAIN : refusal(result, agent.id);
        return {
          output: `The agent ${agent.id} is now the main agent: the one the owner talks to.`,
        };
      },
    },
    {
      spec: SPECS.set_agent_chat,
      label: {
        en: "Changing an agent's chat",
        "pt-BR": "Alterando o chat de um agente",
        es: "Cambiando el chat de un agente",
      },
      async run(input, context) {
        if (!isOwner(context)) return NOT_OWNER;
        const { id, chat } = fields(input);
        if (typeof chat !== "boolean") return failed("Say whether its chat is on: true or false.");
        const agent = await agentOf(context, id);
        if (!("id" in agent)) return agent;
        if (agent.role !== "specialist") return NOT_SPECIALIST;
        if (agent.chat === chat) {
          return {
            output: `The agent ${agent.id}'s chat is already ${chat ? "on" : "off"}; nothing changed.`,
          };
        }
        const change = { id: agent.id, chat };
        const confirmed = await context.confirm({
          command: "setAgentChat",
          input: change,
          summary: TEXTS[context.locale].chat(JSON.stringify(agent.name), agent.id, chat),
        });
        if (!confirmed) return { output: WAITING };
        const result = await commands.setAgentChat(context.actor, change);
        if (!result.ok) {
          return result.reason === "not_allowed" ? NOT_SPECIALIST : refusal(result, agent.id);
        }
        return {
          output: chat
            ? `The owner can now chat with the agent ${agent.id}.`
            : `The owner can no longer chat with the agent ${agent.id}.`,
        };
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
        context.sendLink({
          href,
          text: TEXTS[context.locale].form(agent.id, href, minutes),
          awaits: { agentId: agent.id, step: "telegram_connected", until: result.value.expiresAt },
        });
        return {
          output: `${LINK_SENT}\nThe form works once, for the next ${minutes} minutes. The owner pastes the bot's token there, never in the chat; submitting it is their yes. The form points the bot at Kelpie when it saves the token.${chatOff(agent)}`,
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
        context.sendLink({
          href,
          text: TEXTS[context.locale].pairing(agent.id, href),
          awaits: { agentId: agent.id, step: "telegram_paired", until: now() + PAIRING_WAIT_MS },
        });
        return {
          output: `${LINK_SENT}\nOn that page the owner presses a button, and gets a Telegram link that pairs the account they open it with as theirs. The agent's bot must be connected first.${chatOff(agent)}`,
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
