import { WorkerEntrypoint } from "cloudflare:workers";
import type { Remote } from "@kelpie/access";
import {
  type AgentHostContract,
  type DeployProbeContract,
  type DeployProbeStatus,
  REGISTRY_NAME,
  type RegistryContract,
  type RuntimeProbeReport,
  SETUP_AGENT_ID,
} from "@kelpie/config";

/** How many AgentHosts the probe wakes at once, so a probe stays a small load however many agents. */
export const AGENT_HOSTS_AT_ONCE = 10;

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
      // The retired setup agent's too: the Registry doesn't list it, but its AgentHost keeps the
      // runner form's waits (ADR-0047).
      const ids = [...(await targets.registry.list()).map((agent) => agent.id), SETUP_AGENT_ID];
      // A few at a time: each wakes an object, which may run its migrations now.
      for (let start = 0; start < ids.length; start += AGENT_HOSTS_AT_ONCE) {
        await Promise.all(
          ids.slice(start, start + AGENT_HOSTS_AT_ONCE).map((id) => targets.agentHost(id).ping()),
        );
      }
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
