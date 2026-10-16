import { type Locale, type Localized, RUNNER_VERSION, type RunnerState } from "@kelpie/channels";
import {
  type AgentEntry,
  type AgentRole,
  type AgentSettings,
  type CommandResult,
  type ConfigCommands,
  type DeletedAgents,
  isAgentId,
  parseSettings,
  SETUP_AGENT_ID,
  type SetupEvent,
  type ShownAgent,
} from "@kelpie/config";
import { type ModelSettings, parseModelSettings } from "@kelpie/llm/models";
// The router module only: the package root also loads the provider SDKs.
import { MODEL_TIERS } from "@kelpie/llm/router";
import { MASCOT_SCHEMA } from "./mascot-schema.ts";
import { MODEL_SETTINGS_SCHEMA } from "./model-schema.ts";
import {
  MAX_SUMMARY_CHARS,
  type Tool,
  type ToolContext,
  type ToolOutcome,
  type ToolProvider,
  visible,
} from "./tools.ts";

// Master's configuration tools (Story 3.11, ADR-0013, ADR-0048): the owner configures Kelpie by
// talking to Master. Only the agent whose Registry role is `main` gets them, and they follow the
// role when it moves: the configuration commands the admin API runs, with the same checks. A change
// to access, cost or an external account waits for the owner's own yes (ADR-0013, ADR-0026): a
// confirmation the host gates in code, or the owner's act on an admin API page whose link the host
// sends itself.

/** How Master configures Kelpie: a built-in skill in its prompt, whatever its persona. */
export const CONFIGURE_KELPIE_SKILL = `# Skill: configure-kelpie

You also configure Kelpie for the owner, with your configuration tools. They work only in a conversation with the owner, never in a task's run.

- Make every change with your tools, and never say you made one your tools didn't confirm.
- Kelpie's agents have roles. You are Master, the role \`main\` in list_agents. Master is the agent the owner talks to, and the configuration tools go with the role: set_main_agent makes another agent Master, and it takes them. Every other agent is a specialist, and the owner can chat with a specialist only once its chat is on (set_agent_chat).
- For a first setup, go in this order: see which agents exist (list_agents); connect your own Telegram bot (connect_telegram); then pair the owner's Telegram account with it (pair_telegram). Create another agent, with a short id of lowercase letters, digits and hyphens, and a name (create_agent), only when the owner asks for one; to talk to it, its chat must be on. Changing an agent's model, prompt or mascot (configure_agent), yours included, is optional.
- Your own settings change as any agent's do, with the owner's confirmation. Kelpie refuses a tools list that would take a configuration tool from you, and refuses to make Master an agent whose tools leave them out. Before you lower your own tier, tell the owner.
- Delete an agent (delete_agent) only when the owner asks for it: its subagents go with it, and nothing it held can be recovered. Master can't be deleted.
- Changing an agent's settings or the instance's models, which agent is Master or an agent's chat, or deleting an agent, needs the owner's confirmation. Kelpie itself shows them what will change, with a Confirm button in the webchat or a code to reply with: don't ask them to confirm in other words, and never make up a code. Once they confirm, call the same tool again with the same input.
- Kelpie itself sends the owner the links of connect_telegram, pair_telegram and connect_runner, in a message of its own after your reply. Never write those links yourself, and never make one up: just tell the owner to open the link Kelpie sent. What the owner does on that page is their yes.
- When the owner finishes on one of those pages, Kelpie tells you in this conversation, in a note that starts "Kelpie, automatically". Don't ask them to tell you when they're done: when the note comes, go on with the next step.
- Never ask for a secret in the chat, such as a bot token, the runner's secret or an API key. A bot token goes only into the secure form connect_telegram has Kelpie send, and the runner's secret only into connect_runner's. If the owner pastes a secret in the chat anyway, tell them to revoke it and make a new one: for the runner, a new secret in its file on the server (docs/runner.md).
- To make a Telegram bot, the owner sends /newbot to BotFather on Telegram, which answers with the bot's token. Have them do that first, and only then call connect_telegram: its form works once and only for a few minutes. Tell them to submit the form once and wait for its page; a page that says the link was already used means the bot is connected.
- The owner's VPS runner is the computer Kelpie's agents use. To connect it, call connect_runner: Kelpie sends a secure form where the owner pastes the runner's secret from their server, never in the chat. When the runner accepts it, Kelpie tells you here, so don't ask the owner to say they submitted it. Call runner_status when they ask how the runner is.
- Some steps are outside what you can do: deploying Kelpie's Workers, their bindings and secrets, Cloudflare Access, and the model keys. For those, point the owner to the setup checklist in docs/admin-api.md.`;

/** The commands the configuration tools run; the identity and vault commands stay off them. */
export type ConfigurationCommands = Pick<
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
  | "deleteAgent"
  | "connectTelegram"
  | "connectRunner"
  | "describeRunner"
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
    description:
      "Show an agent's name and settings: its model tier, prompt and timings, and the mascot it shows.",
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
            spawn: {
              type: "boolean",
              description:
                "Whether the agent creates temporary subagents. Master always does; a subagent never.",
            },
            remit: { type: "string", description: "What the agent is for, one line." },
            tools: {
              type: ["array", "null"],
              items: { type: "string" },
              description: "The tools it may use, by name; null for all it is given.",
            },
            maxConcurrentTasks: {
              type: "integer",
              minimum: 0,
              maximum: 10,
              description:
                "How many of its tasks the agent runs at once; 0 runs none, and more costs more.",
            },
            model: {
              ...MODEL_SETTINGS_SCHEMA,
              description: `${MODEL_SETTINGS_SCHEMA.description} It replaces the agent's whole model settings: pass them whole, as get_agent shows them, with the change.`,
            },
            mascot: MASCOT_SCHEMA,
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
      "Make an agent Master: the one the owner talks to, which owns the specialists. The previous Master becomes a specialist and keeps its chat. It needs the owner's confirmation: the first call shows them the change; call it again with the same input once they confirm.",
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
      "Turn a specialist's chat on or off: whether the owner can reach it on its channels. Master always chats. It needs the owner's confirmation, as set_main_agent does.",
    inputSchema: {
      type: "object",
      properties: { id: AGENT_ID, chat: { type: "boolean" } },
      required: ["id", "chat"],
      additionalProperties: false,
    },
  },
  delete_agent: {
    name: "delete_agent",
    description:
      "Delete an agent, and its subagents with it, for good: their settings, their conversations with all their history, and any Telegram bot connected to them. Master can't be deleted. Its files in the owner's vault stay. It needs the owner's confirmation, as set_main_agent does.",
    inputSchema: {
      type: "object",
      properties: { id: AGENT_ID },
      required: ["id"],
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
  connect_runner: {
    name: "connect_runner",
    description:
      "Start connecting the owner's VPS runner, the computer Kelpie's agents use: Kelpie sends the owner a one-time link to a secure form, where they paste the runner's secret from their server. Submitting the form is their yes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  runner_status: {
    name: "runner_status",
    description:
      "Check the owner's VPS runner: whether Kelpie reaches it with the secret it holds, and its version.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
} satisfies Record<string, Tool["spec"]>;

const failed = (output: string): ToolOutcome => ({ output, isError: true });
const fields = (input: unknown): Record<string, unknown> =>
  typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};

const NOT_OWNER = failed("Only the owner can change Kelpie's configuration.");
const NO_KEY = failed(
  "That provider has no key in llm-gateway, so it can't serve: the owner sets one as a deploy secret (docs/secrets.md). get_models lists the providers that have one.",
);
const NOT_MAIN = failed("A subagent can't be Master.");
const NOT_SPECIALIST = failed(
  "Only a specialist's chat can change: Master always chats, and a subagent never does.",
);
const NOT_DELETABLE = failed("Master can't be deleted.");
const MASTER_KEEPS = failed(
  "Master keeps every configuration tool: a tools list for it must name them all, or be null for all it is given.",
);
const NOT_MASTER = failed(
  "This agent isn't Master any more, so it can't configure Kelpie: the owner asks Master.",
);
const NOT_CONFIGURED = failed(
  "Kelpie's admin API address isn't set (ADMIN_ORIGIN on conversation-runtime), so I can't give its link. The owner sets it when deploying: see docs/admin-api.md.",
);
const NO_RUNNER = failed(
  "Kelpie was deployed without the runner's VPC Service, so there's no runner to connect yet. The owner sets up the server and the tunnel first: see docs/runner.md.",
);

/** The configuration tools, by name: the ones Master's own tools list must keep (ADR-0048). */
const CONFIGURATION_TOOLS = Object.keys(SPECS);

/** Whether an agent with this tools list, as Master, holds every configuration tool. */
const keepsConfiguration = (tools: readonly string[] | null | undefined) =>
  tools == null || CONFIGURATION_TOOLS.every((name) => tools.includes(name));

/** What the model is told of the runner's state (#294): never its secret, which Kelpie keeps. */
function runnerStatus(runner: RunnerState): string {
  switch (runner.state) {
    case "ready":
      return `The runner is ready, version ${runner.version}: Kelpie reaches it with the secret it holds.`;
    case "outdated":
      return `The runner answers, version ${runner.version}, but speaks another protocol version than this Kelpie: the owner should update it on the server (docs/runner.md).`;
    case "refused":
      return "The runner no longer takes the secret Kelpie holds: the owner should connect it again with connect_runner, pasting the secret now in the server's file.";
    case "unreachable":
      return "Kelpie couldn't reach the runner: the owner should check that it and cloudflared are running on the server (docs/runner.md).";
    case "not_connected":
      return "Kelpie has no secret for the runner yet. Once the runner runs on the owner's server (docs/runner.md), call connect_runner.";
    case "not_configured":
      return "Kelpie was deployed without the runner's VPC Service: the owner sets up the server and the tunnel first (docs/runner.md).";
  }
}

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
  if (event.step === "runner_connected") {
    if (!RUNNER_VERSION.test(String(event.version))) return null;
    const accepted = `${kelpie} the owner submitted the runner's secure form, and the runner on their server accepted the secret`;
    if (event.state === "ready") {
      return `${accepted}: it is connected and ready, version ${event.version}.`;
    }
    if (event.state === "outdated") {
      return `${accepted}, but its version ${event.version} speaks another protocol version than this Kelpie. You can't update it: tell the owner to update the runner on the server (docs/runner.md).`;
    }
    return null;
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
  /** `subagents` are already formatted, as `"Name" (id)`. */
  deleteAgent: (agent: string, id: string, subagents: string[]) => string;
  form: (id: string, href: string, minutes: number) => string;
  pairing: (id: string, href: string) => string;
  runnerForm: (href: string, minutes: number) => string;
}> = {
  en: {
    settingTo: "to",
    settingFrom: "from",
    changeSettings: (agent, id, changes) =>
      `change the settings of the agent ${agent} (${id}): ${changes}.`,
    mainAgent: (agent, id) =>
      `make the agent ${agent} (${id}) Master, the one you talk to, which also configures Kelpie.`,
    models: (before, after) =>
      `set the models every agent uses unless it has its own, from ${before} to ${after}.`,
    chat: (agent, id, on) =>
      on
        ? `let you chat with the agent ${agent} (${id}).`
        : `stop you chatting with the agent ${agent} (${id}).`,
    deleteAgent: (agent, id, subagents) =>
      subagents.length === 0
        ? `delete, for good, the agent ${agent} (${id}): its settings, its conversations with all their history, and Kelpie's connection to its Telegram bot. The bot itself stays yours: revoke its token with BotFather if you no longer want it. The files under agents/${id}/ in your vault stay.`
        : `delete, for good, the agent ${agent} (${id}) and its ${subagents.length === 1 ? "subagent" : "subagents"} ${subagents.join(", ")}: their settings, their conversations with all their history, and Kelpie's connection to their Telegram bots. A bot itself stays yours: revoke its token with BotFather if you no longer want it. The files under agents/${id}/ in your vault stay.`,
    form: (id, href, minutes) =>
      `The secure form to connect the Telegram bot of the agent ${id}: ${href}\nIt works once, for the next ${minutes} minutes. Paste the bot's token there, never in the chat.`,
    pairing: (id, href) =>
      `To pair your own Telegram account with the bot of the agent ${id}, open ${href} and press its button.`,
    runnerForm: (href, minutes) =>
      `The secure form to connect the runner: ${href}\nIt works once, for the next ${minutes} minutes. Paste the secret from ~/.config/kelpie-runner/secret on your server there, one line only, never in the chat.`,
  },
  "pt-BR": {
    settingTo: "para",
    settingFrom: "de",
    changeSettings: (agent, id, changes) =>
      `alterar as configurações do agente ${agent} (${id}): ${changes}.`,
    mainAgent: (agent, id) =>
      `tornar o agente ${agent} (${id}) o Master, o que conversa com você e configura o Kelpie.`,
    models: (before, after) =>
      `definir os modelos que todo agente usa quando não tem os seus, de ${before} para ${after}.`,
    chat: (agent, id, on) =>
      on
        ? `permitir que você converse com o agente ${agent} (${id}).`
        : `deixar de permitir que você converse com o agente ${agent} (${id}).`,
    deleteAgent: (agent, id, subagents) =>
      subagents.length === 0
        ? `excluir de vez o agente ${agent} (${id}): as configurações, as conversas com todo o histórico e a conexão do Kelpie com o bot do Telegram dele. O bot continua seu: revogue o token no BotFather se não quiser mais ele. Os arquivos em agents/${id}/ no seu vault ficam.`
        : `excluir de vez o agente ${agent} (${id}) e ${subagents.length === 1 ? "o subagente dele" : "os subagentes dele"} ${subagents.join(", ")}: as configurações, as conversas com todo o histórico e a conexão do Kelpie com os bots do Telegram deles. Cada bot continua seu: revogue o token no BotFather se não quiser mais ele. Os arquivos em agents/${id}/ no seu vault ficam.`,
    form: (id, href, minutes) =>
      `O formulário seguro para conectar o bot do Telegram do agente ${id}: ${href}\nFunciona uma vez, nos próximos ${minutes} minutos. Cole o token do bot lá, nunca no chat.`,
    pairing: (id, href) =>
      `Para parear sua própria conta do Telegram com o bot do agente ${id}, abra ${href} e toque no botão da página.`,
    runnerForm: (href, minutes) =>
      `O formulário seguro para conectar o runner: ${href}\nFunciona uma vez, nos próximos ${minutes} minutos. Cole lá o segredo de ~/.config/kelpie-runner/secret do seu servidor, uma linha só, nunca no chat.`,
  },
  es: {
    settingTo: "a",
    settingFrom: "de",
    changeSettings: (agent, id, changes) =>
      `cambiar la configuración del agente ${agent} (${id}): ${changes}.`,
    mainAgent: (agent, id) =>
      `convertir el agente ${agent} (${id}) en el Master, el que conversa contigo y configura Kelpie.`,
    models: (before, after) =>
      `definir los modelos que usa todo agente que no tenga los suyos, de ${before} a ${after}.`,
    chat: (agent, id, on) =>
      on
        ? `permitir que converses con el agente ${agent} (${id}).`
        : `dejar de permitir que converses con el agente ${agent} (${id}).`,
    deleteAgent: (agent, id, subagents) =>
      subagents.length === 0
        ? `eliminar para siempre el agente ${agent} (${id}): su configuración, sus conversaciones con todo su historial y la conexión de Kelpie con su bot de Telegram. El bot sigue siendo tuyo: revoca su token con BotFather si ya no lo quieres. Los archivos en agents/${id}/ de tu vault se quedan.`
        : `eliminar para siempre el agente ${agent} (${id}) y ${subagents.length === 1 ? "su subagente" : "sus subagentes"} ${subagents.join(", ")}: su configuración, sus conversaciones con todo su historial y la conexión de Kelpie con sus bots de Telegram. Cada bot sigue siendo tuyo: revoca su token con BotFather si ya no lo quieres. Los archivos en agents/${id}/ de tu vault se quedan.`,
    form: (id, href, minutes) =>
      `El formulario seguro para conectar el bot de Telegram del agente ${id}: ${href}\nFunciona una vez, durante los próximos ${minutes} minutos. Pega allí el token del bot, nunca en el chat.`,
    pairing: (id, href) =>
      `Para vincular tu propia cuenta de Telegram con el bot del agente ${id}, abre ${href} y presiona el botón de la página.`,
    runnerForm: (href, minutes) =>
      `El formulario seguro para conectar el runner: ${href}\nFunciona una vez, durante los próximos ${minutes} minutos. Pega allí el secreto de ~/.config/kelpie-runner/secret de tu servidor, una sola línea, nunca en el chat.`,
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

/** What the model is told of a deletion (#303), from the command's result. */
function deletedReport(id: string, { deleted, webhooksLeft, everyThread }: DeletedAgents): string {
  const below = deleted.filter((one) => one !== id);
  const along =
    below.length === 0
      ? ""
      : ` and its ${below.length === 1 ? "subagent" : "subagents"} ${below.join(", ")}`;
  const lines = [
    below.length === 0
      ? `Deleted the agent ${id}: its settings, conversations and Kelpie's connection to its Telegram bot are gone.`
      : `Deleted the agent ${id}${along}: their settings, conversations and Kelpie's connection to their Telegram bots are gone.`,
  ];
  for (const left of webhooksLeft) {
    lines.push(
      `Telegram refused to take down the webhook of ${left}'s bot: Kelpie no longer holds its token, so it refuses that bot's messages. The owner can revoke the token with BotFather.`,
    );
  }
  if (!everyThread) {
    lines.push(
      `One gap: a Telegram conversation with it from before Kelpie began recording conversations, with no message since, may remain where nothing reaches it, and an agent created again with the id ${id} would get it back. Suggest another id if the owner creates a new agent.`,
    );
  }
  lines.push(
    `Its files in the vault, under agents/${id}/, stay: the owner can remove them from their vault's repository, and the admin API's forgetVaultPaths drops Kelpie's copy.`,
  );
  return lines.join(" ");
}

/** The agents `id` owns, and theirs in turn: the subagents deleting it deletes (#303). */
function ownedBy(agents: AgentEntry[], id: string): AgentEntry[] {
  const owned: AgentEntry[] = [];
  const seen = new Set([id]);
  for (let i = -1; i < owned.length; i++) {
    const owner = i < 0 ? id : owned[i]?.id;
    for (const agent of agents) {
      if (agent.owner === owner && !seen.has(agent.id)) {
        seen.add(agent.id);
        owned.push(agent);
      }
    }
  }
  return owned;
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
 * Master's configuration tools, over the configuration commands. `roleOf` reads an agent's role
 * from the Registry. `adminOrigin` is the admin API's origin (`ADMIN_ORIGIN`), for the links to its
 * secure form and its pairing page; anything but a bare https origin counts as unset, so a
 * mistyped value gives no link. `now` tells how long a form has left: a duration, which the model
 * passes on without turning a time into a zone.
 */
export function configurationTools(
  commands: ConfigurationCommands,
  options: {
    roleOf: (agentId: string) => Promise<AgentRole | null>;
    adminOrigin: string;
    now?: () => number;
  },
): ToolProvider {
  const adminOrigin = bareHttpsOrigin(options.adminOrigin);
  const now = options.now ?? (() => Date.now());
  const isOwner = (context: ToolContext) => context.actor.role === "owner";

  /** The agent, or the tool's refusal: checked before anything is shown to the owner. */
  async function agentOf(context: ToolContext, id: unknown): Promise<ShownAgent | ToolOutcome> {
    if (!isAgentId(id))
      return failed("That isn't an agent id: lowercase letters, digits and hyphens.");
    const agent = await commands.getAgent(context.actor, { id });
    return agent.ok ? agent.value : refusal(agent, id);
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
        // Kelpie, not the model, tells the owner (#387): other agents' text reaches this turn,
        // and the change needs no yes.
        if (value.created) {
          context.announce({ kind: "agentCreated", agentId: value.id, name: value.name });
        }
        return {
          output: value.created
            ? `Created the agent ${value.id}, named ${JSON.stringify(value.name)}. It is a specialist, owned by Master, and its chat is off: the owner can't reach it until set_agent_chat turns it on.`
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
        // As for a new agent (#387), and later confirmations quote this name beside the id.
        context.announce({
          kind: "agentRenamed",
          agentId: result.value.id,
          name: result.value.name,
        });
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
        // Kelpie is never left without an agent that configures it in chat (ADR-0048).
        if (
          parsed.tools !== undefined &&
          agent.role === "main" &&
          !keepsConfiguration(parsed.tools)
        ) {
          return MASTER_KEEPS;
        }
        const change = { id: agent.id, settings: parsed };
        const summary = TEXTS[context.locale].changeSettings(
          JSON.stringify(agent.name),
          agent.id,
          describe(parsed, context.locale, agent.settings.model ?? {}),
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
        en: "Choosing Master",
        "pt-BR": "Escolhendo o Master",
        es: "Eligiendo el Master",
      },
      async run(input, context) {
        if (!isOwner(context)) return NOT_OWNER;
        const agent = await agentOf(context, fields(input).id);
        if (!("id" in agent)) return agent;
        // Checked before the owner is asked: a yes that can't change anything isn't asked for.
        if (agent.role === "subagent") return NOT_MAIN;
        if (agent.role === "main") {
          return { output: `The agent ${agent.id} is already Master; nothing changed.` };
        }
        if (!keepsConfiguration(agent.settings.tools)) {
          return failed(
            `The agent ${agent.id}'s tools leave out configuration tools, so as Master it couldn't configure Kelpie. Change its tools first with configure_agent: null for all it is given, or a list that names every configuration tool.`,
          );
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
        // The tools go with the role (ADR-0048): the caller, Master until now, can't call them.
        return {
          output: `The agent ${agent.id} is now Master: the one the owner talks to. Your configuration tools went with the role: from now on, ${agent.id} configures Kelpie.`,
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
      spec: SPECS.delete_agent,
      label: {
        en: "Deleting an agent",
        "pt-BR": "Excluindo um agente",
        es: "Eliminando un agente",
      },
      async run(input, context) {
        if (!isOwner(context)) return NOT_OWNER;
        const agent = await agentOf(context, fields(input).id);
        if (!("id" in agent)) return agent;
        if (agent.role === "main") return NOT_DELETABLE;
        // The owner sees every agent that goes, and the input names them, so the yes deletes
        // that set: the command refuses one that changed meanwhile.
        const listed = await commands.listAgents(context.actor);
        if (!listed.ok) return refusal(listed);
        const owned = ownedBy(listed.value, agent.id);
        const change = { id: agent.id, ids: [agent.id, ...owned.map((one) => one.id)].sort() };
        const summary = TEXTS[context.locale].deleteAgent(
          JSON.stringify(agent.name),
          agent.id,
          owned.map((one) => `${JSON.stringify(one.name)} (${one.id})`),
        );
        if (visible(summary).length > MAX_SUMMARY_CHARS) {
          return failed(
            "That deletion names too many agents to show the owner for confirmation here: delete it through the admin API.",
          );
        }
        const confirmed = await context.confirm({ command: "deleteAgent", input: change, summary });
        if (!confirmed) return { output: WAITING };
        const result = await commands.deleteAgent(context.actor, change);
        if (!result.ok) {
          if (result.reason === "forbidden" || result.reason === "unknown_agent") {
            return refusal(result, agent.id);
          }
          if (result.reason === "not_allowed") {
            return failed(
              `The deletion stopped: what it deletes changed since the owner was asked, such as a new subagent or a new role. Anything already deleted stays deleted. Call delete_agent again with the same input, so the owner confirms what it deletes now.`,
            );
          }
          // Whatever went is gone; the rest waits, the agent listed with its chat off.
          return failed(
            `The deletion didn't finish: a Kelpie service didn't answer. What was deleted stays deleted, and the agent ${agent.id} is still listed, with its chat off. Call delete_agent again with the same input to finish; the owner confirms it again.`,
          );
        }
        return { output: deletedReport(agent.id, result.value) };
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
    {
      spec: SPECS.connect_runner,
      label: {
        en: "Connecting the runner",
        "pt-BR": "Conectando o runner",
        es: "Conectando el runner",
      },
      async run(_input, context) {
        if (!isOwner(context)) return NOT_OWNER;
        if (adminOrigin === "") return NOT_CONFIGURED;
        // As for a bot's token: the form, behind Access and the owner check, is the yes (ADR-0026),
        // and Kelpie sends its link, so the model can't alter it.
        const result = await commands.connectRunner(context.actor);
        if (!result.ok) {
          return result.reason === "not_configured" ? NO_RUNNER : refusal(result);
        }
        const href = pageLink(adminOrigin, result.value.path, context.locale);
        const minutes = Math.max(Math.round((result.value.expiresAt - now()) / 60_000), 1);
        // The runner is the instance's, not one agent's: the retired setup agent's AgentHost keeps
        // the wait under its fixed id, and the admin API reports the form there (#328, ADR-0048).
        // The note still reaches this conversation, whichever agent is Master by then.
        context.sendLink({
          href,
          text: TEXTS[context.locale].runnerForm(href, minutes),
          awaits: {
            agentId: SETUP_AGENT_ID,
            step: "runner_connected",
            until: result.value.expiresAt,
          },
        });
        return {
          output: `${LINK_SENT}\nThe form works once, for the next ${minutes} minutes. The owner pastes the runner's secret there, never in the chat, and the form checks it with the runner before saving it.`,
        };
      },
    },
    {
      spec: SPECS.runner_status,
      label: {
        en: "Checking the runner",
        "pt-BR": "Verificando o runner",
        es: "Comprobando el runner",
      },
      async run(_input, context) {
        if (!isOwner(context)) return NOT_OWNER;
        const result = await commands.describeRunner(context.actor);
        if (!result.ok) return refusal(result);
        return { output: runnerStatus(result.value) };
      },
    },
  ];

  // Again when one runs: a turn that listed them may outlive the agent's role (ADR-0048).
  const masters: Tool[] = tools.map((tool) => ({
    ...tool,
    async run(input, context) {
      if ((await options.roleOf(context.agentId)) !== "main") return NOT_MASTER;
      return tool.run(input, context);
    },
  }));

  return {
    // A task's conversation has no owner to confirm anything (#335).
    async tools(agentId, place) {
      if (place?.channel === "task") return [];
      return (await options.roleOf(agentId)) === "main" ? masters : [];
    },
  };
}
