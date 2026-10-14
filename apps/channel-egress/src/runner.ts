import { RUNNER_PROTOCOL, type RunnerAnswered } from "@kelpie/channels";

/** How long a health check waits for the runner. */
const HEALTH_TIMEOUT_MS = 5_000;
/** A version as the runner reports it, such as `0.1.0`; anything else isn't the runner's answer. */
const VERSION = /^[0-9A-Za-z.+-]{1,64}$/;

/**
 * The runner's secret: printable, without spaces, between 32 and 256 characters. `openssl rand -hex
 * 32` makes 64 (docs/runner.md).
 */
export const RUNNER_SECRET = /^[\x21-\x7e]{32,256}$/;

/** The one runner's slot in the secret store, `runner:vps` (ADR-0035's `vps` adapter). */
export const RUNNER_NAME = "vps";

/** `channel-egress`'s binding to the runner's VPC Service, which the release tool adds when set. */
export function runnerOf(env: Env): Fetcher | undefined {
  return (env as Env & { RUNNER?: Fetcher }).RUNNER;
}

export type RunnerCheck = RunnerAnswered | { state: "refused" | "unreachable" };

/** Calls the runner's `/health` with `secret`, through its VPC Service. Never logs the secret. */
export async function checkRunner(runner: Fetcher, secret: string): Promise<RunnerCheck> {
  let response: Response;
  try {
    // The VPC Service sets the host and the port; only the path matters.
    response = await runner.fetch("http://runner/health", {
      headers: { authorization: `Bearer ${secret}` },
      // The runner never redirects: an answer that does isn't the runner's.
      redirect: "manual",
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
  } catch (error) {
    console.warn("channel-egress: the runner couldn't be reached", errorName(error));
    return { state: "unreachable" };
  }
  if (response.status === 401) return { state: "refused" };
  const health: unknown = response.ok ? await response.json().catch(() => null) : null;
  if (!isHealth(health)) {
    console.warn("channel-egress: the runner's answer isn't its health", response.status);
    return { state: "unreachable" };
  }
  return {
    state: health.protocol === RUNNER_PROTOCOL ? "ready" : "outdated",
    version: health.version,
    protocol: health.protocol,
  };
}

function isHealth(value: unknown): value is { version: string; protocol: number } {
  const health = value as { ok?: unknown; version?: unknown; protocol?: unknown } | null;
  return (
    health?.ok === true &&
    typeof health.version === "string" &&
    VERSION.test(health.version) &&
    Number.isInteger(health.protocol)
  );
}

/** The stored value: the secret, as JSON, so the slot can carry more later. */
export function parseRunnerSecret(value: string): string | null {
  try {
    const secret = (JSON.parse(value) as { secret?: unknown } | null)?.secret;
    return typeof secret === "string" && RUNNER_SECRET.test(secret) ? secret : null;
  } catch {
    return null;
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
