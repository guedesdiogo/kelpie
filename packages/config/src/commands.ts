import {
  CHANNEL_IDS,
  type ChannelIdentity,
  type IdentityResult,
  type IdentityStatus,
  maskIdentityValue,
  type Role,
} from "@kelpie/access";
import { type AgentSettings, isAgentId, parseSettings } from "./settings.ts";

/** Who asked for a change, and through what: "admin-api", or "agent:<id>" for an agent's tool. */
export interface Actor {
  userId: string;
  role: Role;
  via: string;
}

export interface AgentSummary {
  id: string;
  name: string;
}

export interface AgentConfig {
  settings: AgentSettings;
  /** Bumped by every system prompt change. */
  promptVersion: number;
}

/** What an agent's host answers to a change it rejects on its own validation. */
export type ConfigureResult =
  | { ok: true; value: AgentConfig }
  | { ok: false; reason: "invalid_input" };

/** What the commands need from the objects that hold configuration. */
export interface ConfigPorts {
  registry: {
    /** Idempotent: adding an existing agent reports `created: false` and changes nothing. */
    add(id: string, name: string, actor: Actor): Promise<{ created: boolean }>;
    rename(id: string, name: string, actor: Actor): Promise<{ found: boolean }>;
    get(id: string): Promise<AgentSummary | null>;
    list(): Promise<AgentSummary[]>;
  };
  agents: {
    configure(id: string, changes: Partial<AgentSettings>, actor: Actor): Promise<ConfigureResult>;
    config(id: string): Promise<AgentConfig>;
  };
  directory: {
    addIdentity(userId: string, identity: ChannelIdentity): Promise<IdentityResult>;
    enableIdentity(identity: ChannelIdentity): Promise<IdentityResult>;
    disableIdentity(identity: ChannelIdentity): Promise<IdentityResult>;
    listIdentities(): Promise<(ChannelIdentity & { status: IdentityStatus })[]>;
  };
}

export type CommandResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reason:
        | "forbidden"
        | "invalid_input"
        | "unknown_agent"
        | Extract<IdentityResult, { ok: false }>["reason"];
    };

/** An identity as commands show it: the value masked, because it is personal data. */
export interface ShownIdentity {
  channel: ChannelIdentity["channel"];
  value: string;
  status: IdentityStatus;
}

/**
 * The configuration commands (ADR-0013). The admin API and, from Story 3.11, the setup agent's
 * tools call these same functions. Every command is owner-only until multi-user lands
 * (ADR-0015); the check uses the actor's role, never a comparison of ids.
 */
export function createConfigCommands(ports: ConfigPorts) {
  const forbidden = { ok: false, reason: "forbidden" } as const;
  const invalid = { ok: false, reason: "invalid_input" } as const;
  const isOwner = (actor: Actor) => actor.role === "owner";
  const show = (identity: ChannelIdentity, status: IdentityStatus): ShownIdentity => ({
    channel: identity.channel,
    value: maskIdentityValue(identity.channelUserId),
    status,
  });

  return {
    async listAgents(actor: Actor): Promise<CommandResult<AgentSummary[]>> {
      if (!isOwner(actor)) return forbidden;
      return { ok: true, value: await ports.registry.list() };
    },

    async createAgent(
      actor: Actor,
      input: unknown,
    ): Promise<CommandResult<AgentSummary & { created: boolean }>> {
      if (!isOwner(actor)) return forbidden;
      const { id, name } = (input ?? {}) as { id?: unknown; name?: unknown };
      if (!isAgentId(id) || !isName(name)) return invalid;
      const { created } = await ports.registry.add(id, name, actor);
      return { ok: true, value: { id, name, created } };
    },

    async renameAgent(actor: Actor, input: unknown): Promise<CommandResult<AgentSummary>> {
      if (!isOwner(actor)) return forbidden;
      const { id, name } = (input ?? {}) as { id?: unknown; name?: unknown };
      if (!isAgentId(id) || !isName(name)) return invalid;
      const { found } = await ports.registry.rename(id, name, actor);
      return found ? { ok: true, value: { id, name } } : { ok: false, reason: "unknown_agent" };
    },

    async getAgent(
      actor: Actor,
      input: unknown,
    ): Promise<CommandResult<AgentSummary & AgentConfig>> {
      if (!isOwner(actor)) return forbidden;
      const { id } = (input ?? {}) as { id?: unknown };
      if (!isAgentId(id)) return invalid;
      const agent = await ports.registry.get(id);
      if (!agent) return { ok: false, reason: "unknown_agent" };
      return { ok: true, value: { ...agent, ...(await ports.agents.config(id)) } };
    },

    async configureAgent(actor: Actor, input: unknown): Promise<CommandResult<AgentConfig>> {
      if (!isOwner(actor)) return forbidden;
      const { id, settings } = (input ?? {}) as { id?: unknown; settings?: unknown };
      if (!isAgentId(id)) return invalid;
      const changes = parseSettings(settings);
      if (!changes) return invalid;
      if (!(await ports.registry.get(id))) return { ok: false, reason: "unknown_agent" };
      return ports.agents.configure(id, changes, actor);
    },

    async listIdentities(actor: Actor): Promise<CommandResult<ShownIdentity[]>> {
      if (!isOwner(actor)) return forbidden;
      const identities = await ports.directory.listIdentities();
      return { ok: true, value: identities.map((identity) => show(identity, identity.status)) };
    },

    /** Adds one of the owner's own identities, as pending until it is paired. */
    async addIdentity(actor: Actor, input: unknown): Promise<CommandResult<ShownIdentity>> {
      if (!isOwner(actor)) return forbidden;
      const identity = parseIdentity(input);
      if (!identity) return invalid;
      const result = await ports.directory.addIdentity(actor.userId, identity);
      return result.ok ? { ok: true, value: show(identity, result.status) } : result;
    },

    async enableIdentity(actor: Actor, input: unknown): Promise<CommandResult<ShownIdentity>> {
      if (!isOwner(actor)) return forbidden;
      const identity = parseIdentity(input);
      if (!identity) return invalid;
      const result = await ports.directory.enableIdentity(identity);
      return result.ok ? { ok: true, value: show(identity, result.status) } : result;
    },

    async disableIdentity(actor: Actor, input: unknown): Promise<CommandResult<ShownIdentity>> {
      if (!isOwner(actor)) return forbidden;
      const identity = parseIdentity(input);
      if (!identity) return invalid;
      const result = await ports.directory.disableIdentity(identity);
      return result.ok ? { ok: true, value: show(identity, result.status) } : result;
    },
  };
}

export type ConfigCommands = ReturnType<typeof createConfigCommands>;

function isName(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= 80;
}

function parseIdentity(input: unknown): ChannelIdentity | null {
  const { channel, channelUserId } = (input ?? {}) as Partial<Record<string, unknown>>;
  if (!CHANNEL_IDS.includes(channel as ChannelIdentity["channel"])) return null;
  if (typeof channelUserId !== "string" || channelUserId.trim() === "") return null;
  return { channel: channel as ChannelIdentity["channel"], channelUserId };
}
