import {
  type Actor,
  type AgentEntry,
  type AgentRole,
  type CommandResult,
  isAgentId,
  MAX_PROPOSAL_REASON,
  PROPOSABLE,
  type Proposal,
  parseProposalChanges,
} from "@kelpie/config";
import type { ModelDescription } from "@kelpie/llm/models";
import { MODEL_SETTINGS_SCHEMA } from "./model-schema.ts";
import { beyondCreator, MAX_BRIEF_CHARS } from "./subagent-limits.ts";
import type { Tool, ToolOutcome, ToolProvider } from "./tools.ts";

// Proposals (ADR-0036 §3, ADR-0061, #302): an owner agent asks for a change to an agent it owns,
// and only the owner's approval on the admin API's page applies it. The tool is offered where the
// agent has no configure_agent: in every turn of a specialist that owns a subagent, and in
// Master's task runs. It applies nothing, and never sees the page's link.

export interface ProposalToolPorts {
  /** The agent's role in the Registry now; null when it isn't listed. */
  roleOf(agentId: string): Promise<AgentRole | null>;
  /** The agents `agentId` owns (ADR-0036 §1). */
  owned(agentId: string): Promise<AgentEntry[]>;
  /** What the proposer holds: its trio as it resolves now, and its tools, Master's included. */
  holds(agentId: string): Promise<{ described: ModelDescription; tools: string[] | null }>;
  /** The `proposeAgentChange` command, as the owner through the proposer. */
  propose(
    actor: Actor,
    input: unknown,
  ): Promise<CommandResult<{ proposal: Proposal; noticed: boolean }>>;
}

const SPEC = {
  name: "propose_agent_change",
  description:
    "Propose a change to an agent you own. Nothing changes unless the owner approves it, on a page Kelpie sends them, within 72 hours; Kelpie tells you the outcome. For a subagent of yours: its model's tier or effort, at most yours, its tools, remit, soul (systemPrompt) or skills. For a specialist: its model, tools, remit or spawn, or its chat on its own. The owner reads your reason as your words.",
  inputSchema: {
    type: "object",
    properties: {
      agentId: { type: "string", description: "The agent you own that the change is for." },
      changes: {
        type: "object",
        description: "Only what to change.",
        properties: {
          model: {
            ...MODEL_SETTINGS_SCHEMA,
            description:
              "Only the parts to change: Kelpie merges them into its model settings, and the owner sees the result. A subagent takes only conversation's tier and effort.",
          },
          tools: {
            type: ["array", "null"],
            items: { type: "string" },
            description: "The tools it may use, by name, within yours; null for all it is given.",
          },
          remit: { type: "string", description: "What it is for, one line." },
          spawn: {
            type: "boolean",
            description: "A specialist's: whether it creates temporary subagents.",
          },
          chat: {
            type: "boolean",
            description: "A specialist's, on its own: whether the owner can chat with it.",
          },
          systemPrompt: { type: "string", description: "A subagent's soul." },
          skills: {
            type: "array",
            maxItems: 10,
            description: "A subagent's skills, all of them.",
            items: {
              type: "object",
              properties: { name: { type: "string" }, instructions: { type: "string" } },
              required: ["name", "instructions"],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      reason: {
        type: "string",
        maxLength: MAX_PROPOSAL_REASON,
        description: "Why, for the owner, in a few sentences.",
      },
    },
    required: ["agentId", "changes", "reason"],
    additionalProperties: false,
  },
} as const satisfies Tool["spec"];

const failed = (output: string): ToolOutcome => ({ output, isError: true });
const fields = (input: unknown): Record<string, unknown> =>
  typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};

const NO_KEY = failed(
  "That provider doesn't serve in llm-gateway: a provider needs its key, and claude-code needs the owner to turn it on.",
);

/** A refusal of the command, in words the model can act on. */
function refusal(
  reason: Extract<CommandResult<unknown>, { ok: false }>["reason"],
  agentId: string,
): ToolOutcome {
  switch (reason) {
    case "too_many":
      return failed(
        "There are too many proposals waiting: one per agent and three of yours at a time, ten of yours a day, and twenty in all. Wait for the owner to decide them.",
      );
    case "invalid_input":
      return failed(
        `That change to the agent ${agentId} isn't valid for it, or is what it has already.`,
      );
    case "no_key":
      return NO_KEY;
    case "not_allowed":
    case "unknown_agent":
      return failed(`You don't own the agent ${agentId} any more.`);
    default:
      return failed("That didn't work: a Kelpie service didn't answer. Try again in a moment.");
  }
}

/**
 * Why a change to a subagent would exceed what its creator holds (ADR-0036 §5), as
 * `create_subagent` checks it, or null.
 */
async function beyondSubagent(
  ports: ProposalToolPorts,
  creator: string,
  changes: Exclude<ReturnType<typeof parseProposalChanges>, null>,
): Promise<string | null> {
  if ("chat" in changes) return null;
  const { model, tools, systemPrompt, skills } = changes;
  // It runs on its creator's provider and memory, whatever its own settings say.
  if (model && (model.provider || model.memory || model.conversation?.provider)) {
    return "A subagent runs on its creator's route: propose only its tier or effort, in model.conversation.";
  }
  if (tools === null) return "A subagent's tools are a list: name each one.";
  const brief =
    (systemPrompt?.length ?? 0) +
    (skills ?? []).reduce((sum, skill) => sum + JSON.stringify(skill).length, 0);
  if (brief > MAX_BRIEF_CHARS) {
    return `Its soul and skills together hold at most ${MAX_BRIEF_CHARS} characters.`;
  }
  const { described, tools: held } = await ports.holds(creator);
  return beyondCreator(
    { tools, tier: model?.conversation?.tier, effort: model?.conversation?.effort },
    { tier: described.tier, effort: described.effort, tools: held },
  );
}

/** Why tools proposed for a specialist exceed what the proposer holds (ADR-0036 §6 rule 3), or null. */
async function beyondProposer(
  ports: ProposalToolPorts,
  proposer: string,
  tools: string[] | null,
): Promise<string | null> {
  const { tools: held } = await ports.holds(proposer);
  if (held === null) return null;
  if (tools === null) {
    return "Only an agent that holds every tool can propose every tool for another: name the tools.";
  }
  const extra = tools.filter((tool) => !held.includes(tool));
  return extra.length === 0
    ? null
    : `A tool you don't hold can't be proposed for another agent: ${extra.join(", ")}.`;
}

export function proposalTools(ports: ProposalToolPorts): ToolProvider {
  const tool: Tool = {
    spec: SPEC,
    label: {
      en: "Proposing a change",
      "pt-BR": "Propondo uma mudança",
      es: "Proponiendo un cambio",
    },
    async run(input, context) {
      // A proposal acts for the owner, so only a turn for them, which reads all their memory, makes
      // one, whatever started it (#345): nothing applies until the owner approves it.
      if (context.actor.role !== "owner" || context.scopes !== "all") {
        return failed(
          "Only turns for the owner propose changes: in a direct conversation with them, or in a task's run.",
        );
      }
      // Checked again as it runs: the role may have moved since the turn listed its tools.
      const role = await ports.roleOf(context.agentId);
      if (role === "master" && !context.task) {
        return failed(
          "In a conversation with the owner, change it with configure_agent, which asks for their confirmation.",
        );
      }
      if (role !== "master" && role !== "specialist") return failed("You can't propose changes.");
      const { agentId, changes, reason } = fields(input);
      const owned = await ports.owned(context.agentId);
      const target = owned.find((agent) => agent.id === agentId);
      if (!isAgentId(agentId) || !target || target.role === "master") {
        return failed(
          `You don't own an agent ${String(agentId).slice(0, 40)}. You can propose changes only to the agents you own: ${owned.map((one) => one.id).join(", ")}.`,
        );
      }
      const allowed: readonly string[] = PROPOSABLE[target.role];
      const named = Object.keys(fields(changes));
      if (named.length === 0 || named.some((field) => !allowed.includes(field))) {
        return failed(
          `That can't change for the agent ${target.id} by a proposal: for a ${target.role}, only ${allowed.join(", ")}${target.role === "specialist" ? ", with chat on its own" : ""}.`,
        );
      }
      const parsed = parseProposalChanges(target.role, changes);
      if (!parsed) {
        return failed(
          "Those values aren't valid: a remit of one line, tools by name, a soul of up to 20,000 characters, at most 10 skills, chat on its own, and model settings from the allowed values.",
        );
      }
      const beyond =
        target.role === "subagent"
          ? await beyondSubagent(ports, context.agentId, parsed)
          : "tools" in parsed && parsed.tools !== undefined
            ? await beyondProposer(ports, context.agentId, parsed.tools)
            : null;
      if (beyond !== null) return failed(beyond);
      const result = await ports.propose(context.actor, {
        agentId: target.id,
        changes,
        reason,
        taskId: context.task?.id ?? null,
      });
      if (!result.ok) return refusal(result.reason, target.id);
      const { proposal, noticed } = result.value;
      const told = noticed
        ? "Kelpie tells the owner in their conversation with Master, with the page that shows the change, where they approve or refuse it."
        : "Master has no conversation with the owner yet, so the owner finds it on the admin API's proposals page.";
      const next = context.task
        ? "End this run now with wait_on_task with reason dependency, saying what you wait for: Kelpie comments the decision on this task, which resumes it."
        : "Kelpie tells you the outcome here. Don't tell the owner it changed.";
      return {
        output: `Proposed the change to the agent ${target.id}: proposal ${proposal.id}. ${told} Nothing changes unless the owner approves it there, within 72 hours. ${next}`,
      };
    },
  };
  return {
    async tools(agentId, place) {
      const role = await ports.roleOf(agentId).catch(() => null);
      // In its conversations, Master changes agents with configure_agent (ADR-0048).
      if (role === "specialist" || (role === "master" && place?.channel === "task")) {
        const owned = await ports.owned(agentId).catch(() => []);
        return owned.length > 0 ? [tool] : [];
      }
      return [];
    },
  };
}
