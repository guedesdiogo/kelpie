import { WorkerEntrypoint } from "cloudflare:workers";
import type { Remote } from "@kelpie/access";
import {
  type AgentHostContract,
  type DeployProbeContract,
  type DeployProbeStatus,
  REGISTRY_NAME,
  type RegistryContract,
  type RuntimeProbeReport,
} from "@kelpie/config";

/** What the probe calls. Each `ping()` answers once its object's migrations ran. */
export interface ProbeTargets {
  registry: Pick<Remote<RegistryContract>, "ping" | "list">;
  agentHost(id: string): Pick<Remote<AgentHostContract>, "ping">;
  /** llm-gateway's `ping()` loads its configuration and calls no provider. */
  gateway: { ping(): Promise<{ ok: true }> };
}

/**
 * Wakes the Registry, every agent's AgentHost and llm-gateway, and reports each part. A failure is
 * logged by the part and the error's name only: an error's message can quote stored data.
 */
export async function probeRuntime(targets: ProbeTargets): Promise<RuntimeProbeReport> {
  const status = (part: keyof RuntimeProbeReport, call: () => Promise<unknown>) =>
    call().then(
      (): DeployProbeStatus => "ok",
      (error: unknown): DeployProbeStatus => {
        console.error(
          `deploy probe: ${part} failed`,
          error instanceof Error ? error.name : "unknown",
        );
        return "failed";
      },
    );
  const [registry, agentHosts, gateway] = await Promise.all([
    status("registry", () => targets.registry.ping()),
    // Listing goes through the Registry too, so a broken Registry fails this part as well.
    status("agentHosts", async () => {
      const agents = await targets.registry.list();
      await Promise.all(agents.map((agent) => targets.agentHost(agent.id).ping()));
    }),
    status("gateway", () => targets.gateway.ping()),
  ]);
  return { registry, agentHosts, gateway };
}

/**
 * The deploy's probe (#234), which only ingress binds. It wakes the Registry and each agent's
 * AgentHost, so their migrations run during the deploy rather than on the first real request, and
 * has llm-gateway load its configuration without calling a model. It answers with statuses only:
 * no agent ids, no settings.
 */
export class DeployProbe extends WorkerEntrypoint<Env> implements DeployProbeContract {
  probe(): Promise<RuntimeProbeReport> {
    return probeRuntime({
      registry: this.env.REGISTRY.getByName(REGISTRY_NAME) as unknown as Remote<RegistryContract>,
      agentHost: (id) => this.env.AGENT_HOST.getByName(id) as unknown as Remote<AgentHostContract>,
      gateway: this.env.LLM_GATEWAY as unknown as ProbeTargets["gateway"],
    });
  }
}
