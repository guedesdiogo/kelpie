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
import { SUBAGENT_TOOLS, subagentPrefix } from "./subagent-limits.ts";
import type { Tool, ToolContext, ToolOutcome, ToolProvider } from "./tools.ts";

// Temporary subagents (ADR-0036 §5, #290): an agent with `spawn` creates them for a demand, and
// deletes them when it ends. A subagent never runs above its creator, works only through tasks,
// reads only its creator's memory and writes none. Turning `spawn` on is the owner's standing yes,
// so no confirmation is asked.

export interface SubagentPorts {
  /** Whether the agent creates subagents: Master by its role, others by `spawn`. */
  canSpawn(agentId: string): Promise<boolean>;
  /** The creator's own trio, as it resolves now, and its tool allowlist: a subagent's ceiling. */
  creator(agentId: string): Promise<{
    model: ModelSettings;
    described: ModelDescription;
    tools: string[] | null;
  }>;
  /** Pins the new subagent's creator on its own object, so it stays a subagent whatever happens. */
  bindCreator(id: string, creator: string): Promise<{ ok: boolean }>;
  /** Erases the object of a subagent the Registry never listed (#344). */
  discard(id: string): Promise<unknown>;
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
/** The longest a subagent's soul and skills are together: they go with every model call it makes. */
const MAX_BRIEF_CHARS = 24_000;
const fields = (input: unknown): Record<string, unknown> =>
  typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};

/** A subagent's id, from its creator's: never one the model picks. */
function subagentId(creator: string): string {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 6);
  return `${subagentPrefix(creator)}${suffix}`;
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
      // Only a turn that reads all of the owner's memory makes one: a subagent reads all of its
      // creator's (ADR-0036 §5), never more than the turn that made it.
      if (context.actor.role !== "owner" || context.scopes !== "all") {
        return failed("Only the owner's own turns, in a direct conversation, create subagents.");
      }
      if (!(await ports.canSpawn(context.agentId))) {
        return failed(
          "You can't create subagents: only Master can let you, at the owner's request.",
        );
      }
      const given = fields(input);
      const optional = (key: string) => (given[key] === null ? undefined : given[key]);
      const { name, soul, remit } = given;
      const skills = optional("skills") ?? [];
      const tier = optional("tier");
      const effort = optional("effort");
      if (!isAgentName(name)) return failed("Give it a name: one line of up to 80 characters.");
      const { model, described, tools: creatorTools } = await ports.creator(context.agentId);
      // Its tools are a subagent's, within what its creator may use.
      const allowed = [...SUBAGENT_TOOLS].filter(
        (tool) => creatorTools === null || creatorTools.includes(tool),
      );
      // Without complete_task, a subagent could never finish a task (#344).
      if (!allowed.includes("complete_task")) {
        return failed(
          "You may not use complete_task, so a subagent of yours could never finish a task: ask the owner to allow it through Master.",
        );
      }
      const tools = optional("tools") ?? allowed;
      if (!Array.isArray(tools) || tools.some((tool) => !allowed.includes(String(tool)))) {
        return failed(`A subagent's tools can only be these: ${allowed.join(", ") || "none"}.`);
      }
      if (!tools.includes("complete_task")) {
        return failed(
          "A subagent's tools must include complete_task, or it can't finish its task.",
        );
      }
      if (tier !== undefined && !TIERS.includes(tier as never)) return failed("Unknown tier.");
      if (effort !== undefined && !EFFORTS.includes(effort as never))
        return failed("Unknown effort.");
      // A tier Kelpie doesn't rank leaves only the cheapest.
      const ceiling = Math.max(TIERS.indexOf(described.tier as never), 0);
      if (tier !== undefined && TIERS.indexOf(tier as never) > ceiling) {
        return failed(`Its tier can't be above yours, ${TIERS[ceiling]}.`);
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
      const brief =
        String(soul ?? "").length +
        (Array.isArray(skills)
          ? skills.reduce((sum, skill) => sum + JSON.stringify(skill ?? "").length, 0)
          : 0);
      if (brief > MAX_BRIEF_CHARS) {
        return failed(`Its soul and skills together hold at most ${MAX_BRIEF_CHARS} characters.`);
      }
      const settings = parseSettings({
        systemPrompt: soul,
        remit,
        skills: skills as AgentSkill[],
        tools: tools as string[],
        // It runs on its creator's route, at the cheapest tier unless it asks for more, within the
        // creator's: costs are the creator's (ADR-0036 §5).
        model: {
          ...(described.provider === null ? {} : { provider: described.provider }),
          ...(model.memory ? { memory: model.memory } : {}),
          conversation: {
            tier: (tier ?? "cheap") as never,
            ...(effort !== undefined
              ? { effort: effort as never }
              : described.effort === undefined
                ? {}
                : { effort: "low" as never }),
          },
        },
        maxConcurrentTasks: 1,
      });
      if (!settings) {
        return failed(
          "That subagent isn't valid: a soul of up to 20,000 characters, a remit of one line, and at most 10 skills.",
        );
      }
      const live = (await ports.owned(context.agentId)).filter((one) => one.role === "subagent");
      if (live.length >= 3) {
        return failed(
          `You already have three live subagents, ${live.map((one) => one.id).join(", ")}: delete one with delete_subagent first.`,
        );
      }
      const id = subagentId(context.agentId);
      // Pinned before the Registry lists it, so it is never an agent without its limits (#344).
      if (!(await ports.bindCreator(id, context.agentId).catch(() => ({ ok: false }))).ok) {
        return failed("Kelpie couldn't set it up: try again.");
      }
      const added = await ports.add(id, name.trim(), context.agentId, context.actor);
      if (!added.ok) {
        // Pinned but never listed: its object goes, so nothing is left behind.
        await ports.discard(id).catch(() => undefined);
        return failed(
          added.reason === "not_allowed"
            ? "Kelpie didn't create it: you made the most subagents a day allows, or have three live."
            : "Kelpie couldn't create it: try again.",
        );
      }
      // Half made, it goes, so nothing runs without its limits.
      const undo = async (why: string) => {
        const removed = await ports.remove(context.actor, id).catch(() => null);
        // Still listed, it exists: the owner hears of it from Kelpie as of any other (#342).
        if (!removed?.ok) context.announce({ kind: "created", agentId: id, name: name.trim() });
        return failed(
          removed?.ok
            ? why
            : `${why} Kelpie couldn't remove the half-made subagent ${id}: call delete_subagent with it.`,
        );
      };
      try {
        const configured = await ports.configure(id, settings, context.actor);
        if (!configured.ok) return await undo("Kelpie couldn't set it up: try again.");
      } catch {
        return await undo("Kelpie couldn't set it up: try again.");
      }
      // Kelpie, not the model, tells the owner it exists (ADR-0036 §6, #342).
      context.announce({ kind: "created", agentId: id, name: name.trim() });
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
      if (context.actor.role !== "owner" || context.scopes !== "all") {
        return failed("Only the owner's own turns, in a direct conversation, delete subagents.");
      }
      const { id } = fields(input);
      const mine = (await ports.owned(context.agentId)).find(
        (agent) => agent.id === id && agent.role === "subagent",
      );
      if (!mine) return failed(`You have no subagent ${String(id)}.`);
      const result = await ports.remove(context.actor, mine.id);
      if (result.ok) {
        context.announce({ kind: "deleted", agentId: mine.id, name: mine.name });
        return {
          output: `Deleted the subagent ${mine.id}. What it reported reached you already; a task it hadn't finished went with it.`,
        };
      }
      return failed(
        result.reason === "forbidden"
          ? "Only the owner's own turns delete subagents."
          : "The deletion didn't finish: call delete_subagent again.",
      );
    },
  };
  return {
    async tools(agentId) {
      return (await ports.canSpawn(agentId).catch(() => false)) ? [create, remove] : [];
    },
  };
}
