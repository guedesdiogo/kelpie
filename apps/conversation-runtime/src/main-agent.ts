import type { Localized } from "@kelpie/channels";
import {
  type AgentRole,
  type CommandResult,
  type ConfigCommands,
  isAgentId,
  parseSettings,
} from "@kelpie/config";
import { mergeModelSettings } from "@kelpie/llm/models";
import { MODEL_SETTINGS_SCHEMA } from "./model-schema.ts";
import type { Tool, ToolOutcome, ToolProvider } from "./tools.ts";

// The main agent's tools (ADR-0036 §3, #289): it changes other agents' model trios, when the owner
// asks or confirms its suggestion. The yes is always Kelpie's own confirmation (ADR-0026), and no
// agent changes its own trio: only Admin does, for any agent.

/** The commands the main agent's tools run. */
export type MainAgentCommands = Pick<ConfigCommands, "getAgent" | "configureAgent">;

const SET_AGENT_MODEL = {
  name: "set_agent_model",
  description:
    "Change another agent's model settings: its provider, and each area's tier and effort. Only the fields you pass change; the others stay as they are (to clear one, the owner asks Admin). Use it when the owner asks, or when they agree with your suggestion. Never for yourself: only Admin changes your own model. It needs the owner's confirmation: the first call shows them the change; call it again with the same input once they confirm.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "The agent's id." },
      model: MODEL_SETTINGS_SCHEMA,
    },
    required: ["id", "model"],
    additionalProperties: false,
  },
} as const;

const failed = (output: string): ToolOutcome => ({ output, isError: true });

const WAITING =
  "Not done yet: Kelpie showed the owner this change, and how to confirm it. Tell them it waits for their confirmation. Once they confirm, call this tool again with the same input.";

/** The confirmation's summary, in the conversation's language (ADR-0027). */
const SUMMARY: Localized<(agent: string, id: string, before: string, after: string) => string> = {
  en: (agent, id, before, after) =>
    `change the model of the agent ${agent} (${id}) from ${before} to ${after}.`,
  "pt-BR": (agent, id, before, after) =>
    `alterar o modelo do agente ${agent} (${id}) de ${before} para ${after}.`,
  es: (agent, id, before, after) =>
    `cambiar el modelo del agente ${agent} (${id}) de ${before} a ${after}.`,
};

function refusal(result: Extract<CommandResult<unknown>, { ok: false }>, id: string): ToolOutcome {
  switch (result.reason) {
    case "forbidden":
      return failed("Only the owner can change an agent's model.");
    case "unknown_agent":
      return failed(`There is no agent with the id ${id}.`);
    case "no_key":
      return failed(
        "That provider has no key in llm-gateway, so it can't serve. Ask the owner to have Admin show which providers have one.",
      );
    default:
      return failed("That didn't work: a Kelpie service didn't answer. Try again in a moment.");
  }
}

/** The main agent's tools; `roleOf` reads an agent's role from the Registry. */
export function mainAgentTools(
  commands: MainAgentCommands,
  roleOf: (agentId: string) => Promise<AgentRole | null>,
): ToolProvider {
  const tool: Tool = {
    spec: SET_AGENT_MODEL,
    label: {
      en: "Changing an agent's model",
      "pt-BR": "Alterando o modelo de um agente",
      es: "Cambiando el modelo de un agente",
    },
    async run(input, context) {
      if (context.actor.role !== "owner") {
        return failed("Only the owner can change an agent's model.");
      }
      // Again when it runs: a turn that listed the tool may outlive the agent's role.
      if ((await roleOf(context.agentId)) !== "main") {
        return failed("This agent isn't the main agent any more, so it can't change models.");
      }
      const { id, model } = (typeof input === "object" && input !== null ? input : {}) as {
        id?: unknown;
        model?: unknown;
      };
      if (!isAgentId(id))
        return failed("That isn't an agent id: lowercase letters, digits and hyphens.");
      if (id === context.agentId) {
        return failed(
          "Only Admin changes your own model: ask the owner to have Admin change it, if they want to.",
        );
      }
      const parsed = parseSettings({ model })?.model;
      if (!parsed) {
        return failed(
          "Those model settings aren't valid: a provider, and each area's provider, tier and effort, from the allowed values.",
        );
      }
      const agent = await commands.getAgent(context.actor, { id });
      if (!agent.ok) return refusal(agent, id);
      // What was asked, over what the agent has: the owner confirms the whole result.
      const before = agent.value.settings.model ?? {};
      const merged = mergeModelSettings(before, parsed);
      const change = { id, settings: { model: merged } };
      const confirmed = await context.confirm({
        command: "configureAgent",
        input: change,
        summary: SUMMARY[context.locale](
          JSON.stringify(agent.value.name),
          id,
          JSON.stringify(before),
          JSON.stringify(merged),
        ),
      });
      if (!confirmed) return { output: WAITING };
      const result = await commands.configureAgent(context.actor, change);
      if (!result.ok) return refusal(result, id);
      return { output: `Changed the model of the agent ${id}.` };
    },
  };

  return {
    async tools(agentId) {
      return (await roleOf(agentId)) === "main" ? [tool] : [];
    },
  };
}
