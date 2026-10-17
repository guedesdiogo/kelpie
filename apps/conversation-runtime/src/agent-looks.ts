import { WorkerEntrypoint } from "cloudflare:workers";
import type { Remote } from "@kelpie/access";
import {
  type AgentLook,
  type AgentLooksContract,
  isAgentId,
  type Mascot,
  mascotFor,
  REGISTRY_NAME,
  type RegistryContract,
} from "@kelpie/config";

/** The most agents one call asks about; the webchat follows at most 16 (ADR-0052 §1). */
const AT_MOST = 32;

/**
 * What ingress binds to draw the webchat's list of agents (ADR-0052 §7): how each listed agent
 * shows, its mascot as the conversation's `agent` frame computes it, its specialty and its remit
 * (#379), and nothing more. Binding the AgentHost itself would also let the internet-facing Worker
 * configure any agent.
 */
export class AgentLooks extends WorkerEntrypoint<Env> implements AgentLooksContract {
  async looks(agentIds: string[]): Promise<Record<string, AgentLook>> {
    if (!Array.isArray(agentIds)) return {};
    const ids = [...new Set(agentIds.filter((id) => isAgentId(id)))].slice(0, AT_MOST);
    const registry = this.env.REGISTRY.getByName(REGISTRY_NAME) as unknown as Remote<
      Pick<RegistryContract, "get">
    >;
    const looks = await Promise.all(
      ids.map(async (id) => {
        try {
          // The Registry first, so an id it doesn't list never wakes an AgentHost.
          const entry = await registry.get(id);
          if (!entry) return null;
          const { settings } = await this.env.AGENT_HOST.getByName(id).config();
          const look: AgentLook = {
            mascot: mascotFor(id, entry.role, settings.mascot ?? null),
            // An AgentHost from before the fields, during a rollout, has neither.
            specialty: settings.specialty ?? "",
            remit: settings.remit ?? "",
          };
          return [id, look] as const;
        } catch (error) {
          // A row without its look draws none; the list still shows the agent.
          console.warn("AgentLooks: a look wasn't read", error instanceof Error ? error.name : "");
          return null;
        }
      }),
    );
    return Object.fromEntries(looks.filter((look) => look !== null));
  }

  /**
   * The mascots alone: the ingress of the release before calls this until the deploy reaches it,
   * since conversation-runtime deploys first (docs/deploy.md).
   */
  async mascots(agentIds: string[]): Promise<Record<string, Mascot>> {
    const looks = await this.looks(agentIds);
    return Object.fromEntries(Object.entries(looks).map(([id, { mascot }]) => [id, mascot]));
  }
}
