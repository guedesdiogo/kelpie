// The router module only: the package root also loads the provider SDKs.
import { type ModelSettings, parseModelSettings } from "@kelpie/llm/models";
import { MODEL_TIERS, type ModelTier } from "@kelpie/llm/router";
import { QUALIFIER_BACKENDS, type QualifierBackend } from "@kelpie/qualifier";

/** Kelpie runs one `Registry`, which lists the agents. */
export const REGISTRY_NAME = "registry";

/**
 * The built-in setup agent (Story 3.11): every instance has it, and only it gets the configuration
 * tools. No other agent may take its id.
 */
export const SETUP_AGENT_ID = "setup";

/** One agent's settings, held by its `AgentHost` (ADR-0002) and read by its conversations. */
export interface AgentSettings {
  /** Merge fragments and split replies into paced bubbles; off answers each message at once. */
  conversational: boolean;
  /**
   * The conversation's tier, as set before #286: `agentModel` counts a stored one as
   * `model.conversation.tier`. New changes go to `model`.
   */
  tier: ModelTier;
  /**
   * The agent's provider, tier and effort per area (ADR-0036 §2). What it leaves unset comes from
   * the instance, then the built-in defaults, in llm-gateway.
   */
  model: ModelSettings;
  /** Changing it starts a new prompt version: earlier replies replay without native output. */
  systemPrompt: string;
  maxOutputTokens: number;
  /** How long to wait after the user's latest message before answering (ADR-0024). */
  quietMs: number;
  /** The longest a message waits for an answer, counted from the first one buffered. */
  maxWaitMs: number;
  /** The qualifier the agent's typed decisions use, such as the memory rerank: Clef or Jev. */
  qualifier: QualifierBackend;
  /**
   * How long a turn may spend calling the model and running tools before it must answer (#141).
   * 120 s is the floor the owner set; it can only go up.
   */
  toolLoopMs: number;
  /**
   * Carry the always-loaded core of memory (#112) into every turn: off until #108's evaluation
   * shows it helps for the agent's model. Changing it starts a new prompt version, as a new system
   * prompt does, since a reply's reasoning is bound to the core it was sent with.
   */
  memoryCore: boolean;
  /**
   * How many of its tasks the agent runs at once (ADR-0011, #54); 0 runs none. Raising it raises
   * cost, so the setup agent asks for the owner's confirmation, as for any setting.
   */
  maxConcurrentTasks: number;
  /**
   * Whether the agent creates and deletes temporary subagents (ADR-0036 §5, #290). The main agent
   * has it by its role; any other agent only when Admin turns it on. A subagent never has it.
   */
  spawn: boolean;
  /** The agent's remit, one line: what it is for, as its identity tells it (ADR-0036 §4). */
  remit: string;
  /**
   * Skills kept on the agent's AgentHost, not in the vault: a subagent's, which last only as long
   * as it does (ADR-0036 §5).
   */
  skills: AgentSkill[];
  /** The tools the agent may use, by name; null for every tool it is given (ADR-0036 §3). */
  tools: string[] | null;
}

/** A skill kept with the agent's settings: its name, and what it tells the agent to do. */
export interface AgentSkill {
  name: string;
  instructions: string;
}

export const DEFAULT_SETTINGS: AgentSettings = {
  conversational: true,
  tier: "cheap",
  model: {},
  systemPrompt: "You are a helpful assistant. Reply in the language the user writes in.",
  maxOutputTokens: 1_024,
  quietMs: 10_000,
  maxWaitMs: 60_000,
  qualifier: "clef",
  toolLoopMs: 120_000,
  memoryCore: false,
  maxConcurrentTasks: 3,
  spawn: false,
  remit: "",
  skills: [],
  tools: null,
};

/** The most skills one agent keeps, and the longest one. */
const MAX_SKILLS = 10;
const MAX_SKILL_CHARS = 4_000;
/** The most tools an allowlist names. */
const MAX_TOOLS = 32;
const isToolName = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value);
/** One line of printable text, as a remit or a skill's name. */
const isLine = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max && !/\p{C}/u.test(value);

function parseSkills(value: unknown): AgentSkill[] | null {
  if (!Array.isArray(value) || value.length > MAX_SKILLS) return null;
  const skills: AgentSkill[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const { name, instructions, ...rest } = entry as Record<string, unknown>;
    if (Object.keys(rest).length > 0) return null;
    if (!isLine(name, 80) || name.trim() === "") return null;
    if (typeof instructions !== "string" || instructions.trim() === "") return null;
    if (instructions.length > MAX_SKILL_CHARS) return null;
    skills.push({ name: name.trim(), instructions });
  }
  return skills;
}

/** Agent ids become object names and URL segments: lowercase letters, digits and hyphens. */
export function isAgentId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{1,39}$/.test(value);
}

/** Agent names appear in lists and in models' context: one line of printable text. */
export function isAgentName(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim() !== "" && value.length <= 80 && !/\p{C}/u.test(value)
  );
}

const isInteger = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

/** Accepts only known settings with sane values; anything else invalidates the whole change. */
export function parseSettings(input: unknown): Partial<AgentSettings> | null {
  if (typeof input !== "object" || input === null) return null;
  const parsed: Partial<AgentSettings> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    switch (key) {
      case "conversational":
        if (typeof value !== "boolean") return null;
        parsed.conversational = value;
        break;
      case "tier":
        if (!MODEL_TIERS.includes(value as ModelTier)) return null;
        parsed.tier = value as ModelTier;
        break;
      case "model": {
        const model = parseModelSettings(value);
        if (!model) return null;
        parsed.model = model;
        break;
      }
      case "systemPrompt":
        if (typeof value !== "string" || value.trim() === "" || value.length > 20_000) return null;
        parsed.systemPrompt = value;
        break;
      case "maxOutputTokens":
        if (!isInteger(value, 1, 64_000)) return null;
        parsed.maxOutputTokens = value;
        break;
      case "maxWaitMs":
        if (!isInteger(value, 0, 120_000)) return null;
        parsed.maxWaitMs = value;
        break;
      case "qualifier":
        if (!QUALIFIER_BACKENDS.includes(value as QualifierBackend)) return null;
        parsed.qualifier = value as QualifierBackend;
        break;
      case "quietMs":
        if (!isInteger(value, 0, 120_000)) return null;
        parsed.quietMs = value;
        break;
      case "toolLoopMs":
        if (!isInteger(value, 120_000, 600_000)) return null;
        parsed.toolLoopMs = value;
        break;
      case "memoryCore":
        if (typeof value !== "boolean") return null;
        parsed.memoryCore = value;
        break;
      case "spawn":
        if (typeof value !== "boolean") return null;
        parsed.spawn = value;
        break;
      case "remit":
        if (!isLine(value, 200)) return null;
        parsed.remit = value.trim();
        break;
      case "skills": {
        const skills = parseSkills(value);
        if (!skills) return null;
        parsed.skills = skills;
        break;
      }
      case "tools":
        if (value === null) {
          parsed.tools = null;
          break;
        }
        if (!Array.isArray(value) || value.length > MAX_TOOLS || !value.every(isToolName)) {
          return null;
        }
        parsed.tools = [...new Set(value)];
        break;
      case "maxConcurrentTasks":
        // 0 runs none of the agent's tasks: they wait in To do (#335).
        if (!isInteger(value, 0, 10)) return null;
        parsed.maxConcurrentTasks = value;
        break;
      default:
        return null;
    }
  }
  return parsed;
}

/**
 * The agent's model settings from what its owner set: `stored` holds only the settings a change set
 * (#218), so a tier there was chosen, and counts as the conversation's unless `model` sets one.
 */
export function agentModel(stored: Partial<AgentSettings>): ModelSettings {
  const model = stored.model ?? {};
  if (stored.tier === undefined || model.conversation?.tier !== undefined) return model;
  return { ...model, conversation: { ...model.conversation, tier: stored.tier } };
}
