import {
  CHANNEL_IDS,
  type ChannelIdentity,
  canonicalTimeZone,
  type IdentityResult,
  type IdentityStatus,
  maskIdentityValue,
  type PairingCodeResult,
  type Role,
  type TimeZoneResult,
} from "@kelpie/access";
import type { ChannelFormsContract, ChannelId } from "@kelpie/channels";
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

/**
 * The `Registry` and `AgentHost` methods other Workers call. The objects implement them, and
 * callers bind them as `Remote<…>`, so a change on either side fails the type check.
 */
export interface RegistryContract {
  add(id: string, name: string, actor: Actor): AddAgentResult;
  rename(id: string, name: string, actor: Actor): RenameAgentResult;
  get(id: string): AgentSummary | null;
  list(): AgentSummary[];
}

export interface AgentHostContract {
  configure(changes: Partial<AgentSettings>, actor: Actor): ConfigureResult;
  config(): AgentConfig;
}

/** A vault file pushed with conflict markers that still waits: on the model, or on a pull request. */
export interface HeldVaultFile {
  path: string;
  state: "held" | "proposed";
  attempts: number;
  at: number;
}

export type ForgetVaultResult =
  | { ok: true; forgotten: number; stillInVault: string[] }
  | { ok: false; reason: "vault_off" | "invalid_input" };

/** The most paths one `forgetVaultPaths` names, and the longest path the vault takes. */
const MAX_FORGET_PATHS = 1_000;
const MAX_PATH_LENGTH = 300;

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
    issuePairingCode(userId: string, channel: ChannelId): Promise<PairingCodeResult>;
    enableIdentity(identity: ChannelIdentity): Promise<IdentityResult>;
    disableIdentity(identity: ChannelIdentity): Promise<IdentityResult>;
    listIdentities(): Promise<(ChannelIdentity & { status: IdentityStatus })[]>;
    setTimeZone(userId: string, timeZone: string): Promise<TimeZoneResult>;
  };
  /** The secure forms that take a channel's secrets, in channel-egress (ADR-0013). */
  channels: Pick<
    ChannelFormsContract,
    "createTelegramForm" | "registerTelegramWebhook" | "describeTelegramBot"
  >;
  /** The vault's Context Store (#114). */
  vault: {
    held(): Promise<HeldVaultFile[]>;
    forget(paths: string[]): Promise<ForgetVaultResult>;
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
        | "unknown_user"
        | "unavailable"
        | "not_connected"
        | "not_configured"
        | "channel_refused"
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

    /**
     * Re-enables one of the owner's identities that was disabled. Nothing enables an identity by its
     * typed value: a new account is paired (`pairTelegram`), which proves it is the owner's.
     */
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

    /**
     * Starts connecting an agent's Telegram bot (Story 3.6): returns the path of a one-time secure
     * form on the admin API, where the owner pastes the bot token. The token never passes through
     * this command or a conversation (ADR-0013). From an agent's tool (Story 3.11) it needs the
     * owner's confirmation first.
     */
    async connectTelegram(
      actor: Actor,
      input: unknown,
    ): Promise<CommandResult<{ path: string; expiresAt: number }>> {
      if (!isOwner(actor)) return forbidden;
      const { agentId } = (input ?? {}) as { agentId?: unknown };
      if (!isAgentId(agentId)) return invalid;
      if (!(await ports.registry.get(agentId))) return { ok: false, reason: "unknown_agent" };
      const form = await ports.channels.createTelegramForm(agentId);
      if (!form.ok) {
        return form.reason === "invalid_input" ? invalid : { ok: false, reason: "unavailable" };
      }
      return { ok: true, value: { path: `/forms/${form.token}`, expiresAt: form.expiresAt } };
    },

    /**
     * Pairs the owner's Telegram account with an agent's bot (Story 3.6): returns a `t.me` link
     * that sends the bot `/start <code>`. The account it comes from becomes the owner's, enabled.
     * The code lasts an hour, and a new one replaces it.
     */
    async pairTelegram(
      actor: Actor,
      input: unknown,
    ): Promise<CommandResult<{ link: string; expiresAt: number }>> {
      if (!isOwner(actor)) return forbidden;
      const { agentId } = (input ?? {}) as { agentId?: unknown };
      if (!isAgentId(agentId)) return invalid;
      if (!(await ports.registry.get(agentId))) return { ok: false, reason: "unknown_agent" };
      const bot = await ports.channels.describeTelegramBot(agentId);
      if (!bot.ok) {
        if (bot.reason === "invalid_input") return invalid;
        return {
          ok: false,
          reason: bot.reason === "not_connected" ? "not_connected" : "unavailable",
        };
      }
      const issued = await ports.directory.issuePairingCode(actor.userId, "telegram");
      if (!issued.ok)
        return issued.reason === "unknown_user" ? { ok: false, reason: "unknown_user" } : invalid;
      return {
        ok: true,
        value: {
          link: `https://t.me/${encodeURIComponent(bot.username)}?start=${issued.code}`,
          expiresAt: issued.expiresAt,
        },
      };
    },

    /**
     * Points an agent's Telegram bot at ingress again. The secure form already does this; it is
     * for a failed registration and for a new ingress hostname. Refusals: no bot connected
     * (`not_connected`), ingress's origin not set at deploy (`not_configured`), or Telegram
     * refused (`channel_refused`).
     */
    async registerTelegramWebhook(
      actor: Actor,
      input: unknown,
    ): Promise<CommandResult<{ agentId: string; registered: true }>> {
      if (!isOwner(actor)) return forbidden;
      const { agentId } = (input ?? {}) as { agentId?: unknown };
      if (!isAgentId(agentId)) return invalid;
      if (!(await ports.registry.get(agentId))) return { ok: false, reason: "unknown_agent" };
      const result = await ports.channels.registerTelegramWebhook(agentId);
      if (result.ok) return { ok: true, value: { agentId, registered: true } };
      if (result.reason === "invalid_input") return invalid;
      return {
        ok: false,
        reason: result.reason === "store_unavailable" ? "unavailable" : result.reason,
      };
    },

    /**
     * Sets the owner's own time zone (Story 3.12), an IANA name. Messages sent from then on are
     * stamped in it; earlier stamps stay as written.
     */
    async setTimeZone(actor: Actor, input: unknown): Promise<CommandResult<{ timeZone: string }>> {
      if (!isOwner(actor)) return forbidden;
      const { timeZone } = (input ?? {}) as { timeZone?: unknown };
      const canonical = canonicalTimeZone(timeZone);
      if (!canonical) return invalid;
      const result = await ports.directory.setTimeZone(actor.userId, canonical);
      if (result.ok) return { ok: true, value: { timeZone: result.timeZone } };
      return result.reason === "unknown_user" ? { ok: false, reason: "unknown_user" } : invalid;
    },

    /**
     * The vault's files pushed with conflict markers that still wait (#114): on the model, on a
     * pull request with its resolution, or, after the model's tries, on the owner.
     */
    async listHeldFiles(actor: Actor): Promise<CommandResult<HeldVaultFile[]>> {
      if (!isOwner(actor)) return forbidden;
      return { ok: true, value: await ports.vault.held() };
    },

    /**
     * After the owner rewrote the vault's history to erase content (#114): Kelpie forgets its own
     * copies of `paths` (a path ending in `/` names a folder), and memory's index drops every old
     * version. It answers which of them the vault still has. Git is never touched.
     */
    async forgetVaultPaths(
      actor: Actor,
      input: unknown,
    ): Promise<CommandResult<{ forgotten: number; stillInVault: string[] }>> {
      if (!isOwner(actor)) return forbidden;
      const { paths } = (input ?? {}) as { paths?: unknown };
      if (
        !Array.isArray(paths) ||
        paths.length === 0 ||
        paths.length > MAX_FORGET_PATHS ||
        !paths.every(
          (path) => typeof path === "string" && path !== "" && path.length <= MAX_PATH_LENGTH,
        )
      ) {
        return invalid;
      }
      const result = await ports.vault.forget(paths);
      if (result.ok) {
        return {
          ok: true,
          value: { forgotten: result.forgotten, stillInVault: result.stillInVault },
        };
      }
      return result.reason === "vault_off" ? { ok: false, reason: "not_configured" } : invalid;
    },
  };
}

export type ConfigCommands = ReturnType<typeof createConfigCommands>;

function parseIdentity(input: unknown): ChannelIdentity | null {
  const { channel, channelUserId } = (input ?? {}) as Partial<Record<string, unknown>>;
  // Messaging channels only: no command adds or changes an Access identity. The first-run bootstrap
  // adds the owner's, and a token-gated recovery replaces it.
  if (!(CHANNEL_IDS as readonly unknown[]).includes(channel)) return null;
  if (typeof channelUserId !== "string") return null;
  const value = channelUserId.trim();
  if (value === "" || value.length > 256) return null;
  return { channel: channel as ChannelIdentity["channel"], channelUserId: value };
}
