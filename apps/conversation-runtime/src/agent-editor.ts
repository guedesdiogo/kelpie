import { WorkerEntrypoint } from "cloudflare:workers";
import {
  type Actor,
  type AgentEditorContract,
  type CommandResult,
  type Mascot,
  parseMascot,
} from "@kelpie/config";
import { configCommands } from "./ports.ts";

const invalid = { ok: false, reason: "invalid_input" } as const;

/**
 * What ingress binds for the webchat's agent editor (#379): an agent's mascot, name, remit and
 * specialty, each through its configuration command, which checks the actor again. Each method
 * builds its setting itself, from its one value, so nothing else reaches the agent. Binding the
 * AgentHost itself would let the internet-facing Worker configure any agent, any way.
 */
export class AgentEditor extends WorkerEntrypoint<Env> implements AgentEditorContract {
  /** The whole mascot: the setting is set whole. null, the default, isn't something it offers. */
  async setMascot(actor: Actor, agentId: string, mascot: unknown): Promise<CommandResult<Mascot>> {
    const parsed = parseMascot(mascot);
    if (!parsed) return invalid;
    const result = await configCommands(this.env).configureAgent(actor, {
      id: agentId,
      settings: { mascot: parsed },
    });
    return result.ok ? { ok: true, value: result.value.settings.mascot ?? parsed } : result;
  }

  async rename(actor: Actor, agentId: string, name: unknown): Promise<CommandResult<string>> {
    const result = await configCommands(this.env).renameAgent(actor, { id: agentId, name });
    return result.ok ? { ok: true, value: result.value.name } : result;
  }

  async setRemit(actor: Actor, agentId: string, remit: unknown): Promise<CommandResult<string>> {
    const result = await configCommands(this.env).configureAgent(actor, {
      id: agentId,
      settings: { remit },
    });
    return result.ok ? { ok: true, value: result.value.settings.remit } : result;
  }

  /** The main agent's is always "principal": the command refuses it, by the agent's role. */
  async setSpecialty(
    actor: Actor,
    agentId: string,
    specialty: unknown,
  ): Promise<CommandResult<string>> {
    const result = await configCommands(this.env).configureAgent(actor, {
      id: agentId,
      settings: { specialty },
    });
    return result.ok ? { ok: true, value: result.value.settings.specialty } : result;
  }
}
