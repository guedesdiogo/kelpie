import type { DeployProbeStatus, RuntimeProbeReport } from "@kelpie/config";

/** The deploy's deep probe (#234). `tools/release` posts here after a deploy, with the header. */
export const DEPLOY_PROBE_PATH = "/deploy/probe";
/** `<unix seconds>.<hex HMAC-SHA256 of those seconds, keyed with DEPLOY_PROBE_TOKEN>`. */
export const DEPLOY_PROBE_HEADER = "x-kelpie-deploy-probe";

/** How far a signature's time may be from this Worker's clock: a header a log kept soon expires. */
const SIGNATURE_WINDOW_S = 120;
/** A shorter secret counts as unset, so a weak token never opens the route. */
const MIN_TOKEN_LENGTH = 32;
const SIGNATURE = /^(\d{1,12})\.([0-9a-f]{64})$/;

export interface DeployProbeDeps {
  /** The Worker secret `DEPLOY_PROBE_TOKEN`. Without it the route doesn't exist. */
  token: string | undefined;
  /** The time, in milliseconds, that a signature is checked against. */
  now(): number;
  /** Wakes the Directory, which answers once its migrations ran. */
  pingDirectory(): Promise<unknown>;
  /** conversation-runtime's `DeployProbe`: the Registry, every AgentHost and llm-gateway. */
  probeRuntime(): Promise<RuntimeProbeReport>;
}

/**
 * Wakes the Directory and conversation-runtime's objects, so their migrations run during the
 * deploy, and reports each part as `ok` or `failed`, with no ids and no data.
 *
 * Without a valid signature it returns null and wakes nothing: the request then gets the 404 any
 * unknown path gets, so the route doesn't show.
 */
export async function handleDeployProbe(
  request: Request,
  deps: DeployProbeDeps,
): Promise<Response | null> {
  const presented = request.headers.get(DEPLOY_PROBE_HEADER);
  if (!(await validSignature(presented, deps.token, deps.now()))) return null;
  const [directory, runtime] = await Promise.all([
    deps.pingDirectory().then(
      (): DeployProbeStatus => "ok",
      (error: unknown): DeployProbeStatus => {
        logFailure("directory", error);
        return "failed";
      },
    ),
    // A runtime that can't answer at all fails each of its parts.
    deps.probeRuntime().catch((error: unknown) => {
      logFailure("conversation-runtime", error);
      return null;
    }),
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

/** By the error's name only: a message can quote stored data. */
function logFailure(part: string, error: unknown): void {
  console.error(`deploy probe: ${part} failed`, error instanceof Error ? error.name : "unknown");
}

/**
 * Whether the header signs a time within two minutes of `nowMs` with the token. The token itself
 * never travels, so a header that reaches a log is useless once its window passes.
 */
export async function validSignature(
  presented: string | null,
  token: string | undefined,
  nowMs: number,
): Promise<boolean> {
  if (!token || token.length < MIN_TOKEN_LENGTH || presented === null) return false;
  const [, seconds = "", mac = ""] = SIGNATURE.exec(presented) ?? [];
  if (!seconds || Math.abs(nowMs / 1_000 - Number(seconds)) > SIGNATURE_WINDOW_S) return false;
  return sameSecret(mac, await signature(token, seconds));
}

/** HMAC-SHA256 of `seconds`, keyed with the token, in hex. */
export async function signature(token: string, seconds: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(seconds));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Compares through digests, in constant time: neither a guess's length nor its prefix shows. */
export async function sameSecret(presented: string, expected: string): Promise<boolean> {
  const digest = (text: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const [left, right] = await Promise.all([digest(presented), digest(expected)]);
  return crypto.subtle.timingSafeEqual(left, right);
}
