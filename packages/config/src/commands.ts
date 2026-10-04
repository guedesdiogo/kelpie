import {
  CHANNEL_IDS,
  type ChannelIdentity,
  type IdentityResult,
  type IdentityStatus,
  maskIdentityValue,
  type Role,
} from "@kelpie/access";
import { type AgentSettings, isAgentId, isAgentName, parseSettings } from "./settings.ts";

/**
 * Who asked for a change, and through what: "admin-api", or "agent:<id>" for an agent's tool.
 * Callers build it from the `Directory`'s `Admission` for the authenticated user, never from
 * request input.
 */
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

/**
 * What the objects that hold configuration answer. They validate their input again, because they
 * are an RPC boundary; authorizing the actor is the commands' job.
 */
export type ConfigureResult =
  | { ok: true; value: AgentConfig }
  | { ok: false; reason: "invalid_input" };
export type AddAgentResult =
  | { ok: true; created: boolean }
  | { ok: false; reason: "invalid_input" };
export type RenameAgentResult =
  | { ok: true }
  | { ok: false; reason: "unknown_agent" | "invalid_input" };

/** What the commands need from the objects that hold configuration. */
export interface ConfigPorts {
  registry: {
    /** Idempotent: adding an existing agent reports `created: false` and changes nothing. */
    add(id: string, name: string, actor: Actor): Promise<AddAgentResult>;
    rename(id: string, name: string, actor: Actor): Promise<RenameAgentResult>;
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
      if (!isAgentId(id) || !isAgentName(name)) return invalid;
      const result = await ports.registry.add(id, name.trim(), actor);
      if (!result.ok) return result;
      return { ok: true, value: { id, name: name.trim(), created: result.created } };
    },

    async renameAgent(actor: Actor, input: unknown): Promise<CommandResult<AgentSummary>> {
      if (!isOwner(actor)) return forbidden;
      const { id, name } = (input ?? {}) as { id?: unknown; name?: unknown };
      if (!isAgentId(id) || !isAgentName(name)) return invalid;
      const result = await ports.registry.rename(id, name.trim(), actor);
      return result.ok ? { ok: true, value: { id, name: name.trim() } } : result;
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

function parseIdentity(input: unknown): ChannelIdentity | null {
  const { channel, channelUserId } = (input ?? {}) as Partial<Record<string, unknown>>;
  // Messaging channels only: an Access identity enters through the first-run bootstrap alone.
  if (!(CHANNEL_IDS as readonly unknown[]).includes(channel)) return null;
  if (typeof channelUserId !== "string") return null;
  const value = channelUserId.trim();
  if (value === "" || value.length > 256) return null;
  return { channel: channel as ChannelIdentity["channel"], channelUserId: value };
}
