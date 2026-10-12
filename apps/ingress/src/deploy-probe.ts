import type { DeployProbeStatus, RuntimeProbeReport } from "@kelpie/config";

/** The deploy's deep probe (#234). `tools/release` posts here after a deploy, with the header. */
export const DEPLOY_PROBE_PATH = "/deploy/probe";
export const DEPLOY_PROBE_HEADER = "x-kelpie-deploy-probe";

export interface DeployProbeDeps {
  /** The Worker secret `DEPLOY_PROBE_TOKEN`. Without it the route doesn't exist. */
  token: string | undefined;
  /** Wakes the Directory, which answers once its migrations ran. */
  pingDirectory(): Promise<unknown>;
  /** conversation-runtime's `DeployProbe`: the Registry, every AgentHost and llm-gateway. */
  probeRuntime(): Promise<RuntimeProbeReport>;
}

/**
 * Wakes the Directory and conversation-runtime's objects, so their migrations run during the
 * deploy, and reports each part as `ok` or `failed`, with no ids and no data.
 *
 * Without the token, or with a wrong one, it returns null and wakes nothing: the request then gets
 * the 404 any unknown path gets, so the route doesn't show.
 */
export async function handleDeployProbe(
  request: Request,
  deps: DeployProbeDeps,
): Promise<Response | null> {
  const presented = request.headers.get(DEPLOY_PROBE_HEADER);
  if (!deps.token || presented === null || !(await sameSecret(presented, deps.token))) return null;
  const [directory, runtime] = await Promise.all([
    deps.pingDirectory().then(
      (): DeployProbeStatus => "ok",
      (): DeployProbeStatus => "failed",
    ),
    // A runtime that can't answer at all fails each of its parts.
    deps.probeRuntime().catch(() => null),
  ]);
  // Only an exact "ok" passes, so nothing else conversation-runtime returns reaches the answer.
  const status = (value: unknown): DeployProbeStatus => (value === "ok" ? "ok" : "failed");
  return Response.json(
    {
      directory,
      registry: status(runtime?.registry),
      agentHosts: status(runtime?.agentHosts),
      gateway: status(runtime?.gateway),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

/** Compares through digests, in constant time: neither a guess's length nor its prefix shows. */
export async function sameSecret(presented: string, expected: string): Promise<boolean> {
  const digest = (text: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const [left, right] = await Promise.all([digest(presented), digest(expected)]);
  return crypto.subtle.timingSafeEqual(left, right);
}
