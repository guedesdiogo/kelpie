import { WorkerEntrypoint } from "cloudflare:workers";
import { isAgentId, type SetupEvent, type SetupEventsContract } from "@kelpie/config";

/**
 * What ingress binds to report a pairing the owner finished (#206), and nothing more. Binding the
 * AgentHost itself would also let the internet-facing Worker configure any agent.
 */
export class SetupEvents extends WorkerEntrypoint<Env> implements SetupEventsContract {
  async setupDone(agentId: string, event: SetupEvent): Promise<void> {
    if (!isAgentId(agentId)) return;
    await this.env.AGENT_HOST.getByName(agentId).setupDone(event);
  }
}
