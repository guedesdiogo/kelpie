import {
  type AgentEntry,
  type AgentSettings,
  type AgentSkill,
  type CommandResult,
  type ConfigureResult,
  type DeletedAgents,
  isAgentName,
  parseSettings,
  type SetAgentResult,
} from "@kelpie/config";
import type { ModelDescription, ModelSettings } from "@kelpie/llm/models";
import { SUBAGENT_TOOLS } from "./subagent-limits.ts";
import type { Tool, ToolContext, ToolOutcome, ToolProvider } from "./tools.ts";

// Temporary subagents (ADR-0036 §5, #290): an agent with `spawn` creates them for a demand, and
// deletes them when it ends. A subagent never runs above its creator, works only through tasks,
// reads only its creator's memory and writes none. Turning `spawn` on is the owner's standing yes,
// so no confirmation is asked.

export interface SubagentPorts {
  /** Whether the agent creates subagents: the main agent by its role, others by `spawn`. */
  canSpawn(agentId: string): Promise<boolean>;
  /** The creator's own trio, as it resolves now: a subagent's ceiling. */
  ceiling(agentId: string): Promise<{ model: ModelSettings; described: ModelDescription }>;
  add(
    id: string,
    name: string,
    creator: string,
    actor: ToolContext["actor"],
  ): Promise<SetAgentResult>;
  configure(
    id: string,
    settings: Partial<AgentSettings>,
    actor: ToolContext["actor"],
  ): Promise<ConfigureResult>;
  /** The agents the creator owns, its subagents among them. */
  owned(creator: string): Promise<AgentEntry[]>;
  /** #303's deletion, for one of the creator's subagents. */
  remove(actor: ToolContext["actor"], id: string): Promise<CommandResult<DeletedAgents>>;
}

const TIERS = ["cheap", "medium", "frontier"] as const;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

const SPECS = {
  create_subagent: {
    name: "create_subagent",
    description:
      "Create a temporary subagent for a demand, then hand it work with create_task. Give it a name, a soul (its persona and how it works), a one-line remit, and skills for the work. It can't talk to the owner, confirm anything or write memory, and runs at most on your own model. You have at most three live; delete each with delete_subagent once its demand ends.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "One line." },
        soul: { type: "string", description: "Its persona and how it works." },
        remit: { type: "string", description: "What it is for, one line." },
        skills: {
          type: "array",
          maxItems: 10,
          items: {
            type: "object",
            properties: { name: { type: "string" }, instructions: { type: "string" } },
            required: ["name", "instructions"],
            additionalProperties: false,
          },
        },
        tier: { type: "string", enum: [...TIERS], description: "At most your own tier." },
        effort: { type: "string", enum: [...EFFORTS], description: "At most your own effort." },
        tools: {
          type: "array",
          items: { type: "string", enum: [...SUBAGENT_TOOLS] },
          description: "Its tools; all of these by default.",
        },
      },
      required: ["name", "soul", "remit"],
      additionalProperties: false,
    },
  },
  delete_subagent: {
    name: "delete_subagent",
    description:
      "Delete one of your subagents once its demand ends: it goes for good, with its conversations. Its results stay on your tasks.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
} as const satisfies Record<string, Tool["spec"]>;

const failed = (output: string): ToolOutcome => ({ output, isError: true });
const fields = (input: unknown): Record<string, unknown> =>
  typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};

/** A subagent's id, from its creator's: never one the model picks. */
function subagentId(creator: string): string {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 6);
  return `${creator.slice(0, 29).replace(/-+$/, "")}-sub-${suffix}`;
}

export function subagentTools(ports: SubagentPorts): ToolProvider {
  const create: Tool = {
    spec: SPECS.create_subagent,
    label: {
      en: "Creating a subagent",
      "pt-BR": "Criando um subagente",
      es: "Creando un subagente",
    },
    async run(input, context) {
      if (context.actor.role !== "owner") return failed("Only the owner's turns create subagents.");
      if (!(await ports.canSpawn(context.agentId))) {
        return failed(
          "You can't create subagents: only Admin can let you, at the owner's request.",
        );
      }
      const {
        name,
        soul,
        remit,
        skills = [],
        tier,
        effort,
        tools = [...SUBAGENT_TOOLS],
      } = fields(input);
      if (!isAgentName(name)) return failed("Give it a name: one line of up to 80 characters.");
      if (!Array.isArray(tools) || tools.some((tool) => !SUBAGENT_TOOLS.has(String(tool)))) {
        return failed(
          `A subagent's tools are only these: ${[...SUBAGENT_TOOLS].join(", ")}. It can't have the others.`,
        );
      }
      if (tier !== undefined && !TIERS.includes(tier as never)) return failed("Unknown tier.");
      if (effort !== undefined && !EFFORTS.includes(effort as never))
        return failed("Unknown effort.");
      const { model, described } = await ports.ceiling(context.agentId);
      if (
        tier !== undefined &&
        TIERS.indexOf(tier as never) > TIERS.indexOf(described.tier as never)
      ) {
        return failed(`Its tier can't be above yours, ${described.tier}.`);
      }
      if (
        effort !== undefined &&
        (described.effort === undefined ||
          EFFORTS.indexOf(effort as never) > EFFORTS.indexOf(described.effort as never))
      ) {
        return failed(
          described.effort === undefined
            ? "You run with no effort set, so it can't set one."
            : `Its effort can't be above yours, ${described.effort}.`,
        );
      }
      const settings = parseSettings({
        systemPrompt: soul,
        remit,
        skills: skills as AgentSkill[],
        tools: tools as string[],
        // It runs on its creator's route, at most its creator's tier and effort.
        model: {
          ...(described.provider === null ? {} : { provider: described.provider }),
          ...(model.memory ? { memory: model.memory } : {}),
          conversation: {
            tier: (tier ?? described.tier) as never,
            ...(effort === undefined
              ? described.effort === undefined
                ? {}
                : { effort: described.effort }
              : { effort: effort as never }),
          },
        },
        maxConcurrentTasks: 1,
      });
      if (!settings) {
        return failed(
          "That subagent isn't valid: a soul of up to 20,000 characters, a remit of one line, and at most 10 skills.",
        );
      }
      const id = subagentId(context.agentId);
      const added = await ports.add(id, name.trim(), context.agentId, context.actor);
      if (!added.ok) {
        return failed(
          added.reason === "not_allowed"
            ? "You already have three live subagents: delete one with delete_subagent first."
            : "Kelpie couldn't create it: try again.",
        );
      }
      const configured = await ports.configure(id, settings, context.actor);
      if (!configured.ok) {
        // Half made: it goes, so nothing runs without its limits.
        await ports.remove(context.actor, id);
        return failed("Kelpie couldn't set it up: try again.");
      }
      return {
        output: `Created the subagent ${id}, named ${JSON.stringify(name.trim())}. Hand it work with create_task and agentId ${id}; Kelpie tells you when each task ends or asks something. Delete it with delete_subagent once its demand ends.`,
      };
    },
  };
  const remove: Tool = {
    spec: SPECS.delete_subagent,
    label: {
      en: "Deleting a subagent",
      "pt-BR": "Excluindo um subagente",
      es: "Eliminando un subagente",
    },
    async run(input, context) {
      const { id } = fields(input);
      const mine = (await ports.owned(context.agentId)).find(
        (agent) => agent.id === id && agent.role === "subagent",
      );
      if (!mine) return failed(`You have no subagent ${String(id)}.`);
      const result = await ports.remove(context.actor, mine.id);
      return result.ok
        ? { output: `Deleted the subagent ${mine.id}. Its results stay on your tasks.` }
        : failed("The deletion didn't finish: call delete_subagent again.");
    },
  };
  return {
    async tools(agentId) {
      return (await ports.canSpawn(agentId).catch(() => false)) ? [create, remove] : [];
    },
  };
}
