import type { CloudflareApi, InvocationCount } from "./cloudflare.ts";
import { type BuildTag, formatTag, parseTag, sameCommit } from "./tags.ts";

export interface Log {
  info(message: string): void;
  warn(message: string): void;
}

export interface VerifyDeps {
  api: CloudflareApi;
  fetch: typeof fetch;
  sleep(ms: number): Promise<void>;
  now(): Date;
  log: Log;
}

export interface ProbeResult {
  probe: string;
  /** `blocked`: the zone's security answered instead of the Worker, so nothing was learned. */
  outcome: "pass" | "fail" | "blocked";
  detail: string;
}

interface Probe {
  name: string;
  method: "GET" | "POST";
  path: string;
  headers?: Record<string, string>;
  /** Headers made when the request goes, such as a signature of the current time. */
  signedHeaders?: () => Promise<Record<string, string>>;
  body?: string;
  /** Null when the answer is the expected one, otherwise what was wrong with it. */
  judge(status: number, body: unknown): string | null;
}

/** Ingress's deploy probe (#234), in `apps/ingress/src/deploy-probe.ts`. */
const DEEP_PROBE_PATH = "/deploy/probe";
const DEEP_PROBE_HEADER = "x-kelpie-deploy-probe";
/** What it wakes; each answers `ok` or `failed`. */
const DEEP_PROBE_PARTS = ["directory", "registry", "agentHosts", "gateway"] as const;

/**
 * `<unix seconds>.<hex HMAC-SHA256 of those seconds, keyed with the token>`: ingress checks it
 * against its own copy of the token, within two minutes of its clock. The token itself never
 * travels, so a header that reaches a log soon stops working.
 */
export async function deepProbeSignature(token: string, nowMs: number): Promise<string> {
  const seconds = String(Math.floor(nowMs / 1_000));
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(seconds));
  const hex = [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${seconds}.${hex}`;
}

/**
 * The deploy's deep probe: signed with `DEPLOY_PROBE_TOKEN`, which ingress holds, it has ingress
 * wake the Directory, the Registry, every AgentHost and llm-gateway. Only the deploy of a new build
 * sends it; an older build has no such route, so a rollback is checked without it.
 */
function deepProbe(token: string): Probe {
  return {
    name: "deep",
    method: "POST",
    path: DEEP_PROBE_PATH,
    signedHeaders: async () => ({
      [DEEP_PROBE_HEADER]: await deepProbeSignature(token, Date.now()),
    }),
    judge(status, body) {
      if (status === 404) {
        return "answered 404: ingress may lack DEPLOY_PROBE_TOKEN or hold an older one, which running the Deploy workflow with rotate-probe-token fixes; or the build has no probe route";
      }
      if (status !== 200) return `answered ${status}`;
      // Only the parts' names are repeated: the answer goes into public reports.
      const parts = (typeof body === "object" ? body : null) as Record<string, unknown> | null;
      const failed = DEEP_PROBE_PARTS.filter((part) => parts?.[part] !== "ok");
      return failed.length === 0 ? null : `failed: ${failed.join(", ")}`;
    },
  };
}

/**
 * What the probes reach from outside, without a login:
 * - `/health` and `/version`: ingress runs, and serves the expected build;
 * - a Telegram update with a wrong secret: ingress asks channel-egress, which reads its
 *   `SecretStore` object, so that object wakes and applies its migrations. A broken store answers
 *   503;
 * - a GitHub delivery with a wrong signature: ingress hands it to context-store.
 * The refusals change nothing: no agent is named, so no notice or conversation runs. With
 * `deepToken`, the deep probe goes too; it only wakes objects, and changes nothing either.
 */
function probes(expected: BuildTag | null, deepToken?: string): Probe[] {
  const expectStatus =
    (want: number, explain: Record<number, string> = {}) =>
    (status: number) =>
      status === want
        ? null
        : `answered ${status}${explain[status] ? ` (${explain[status]})` : ""}`;
  return [
    {
      name: "health",
      method: "GET",
      path: "/health",
      judge: (status, body) =>
        status === 200 && (body as { status?: unknown } | null)?.status === "ok"
          ? null
          : `answered ${status}`,
    },
    {
      name: "version",
      method: "GET",
      path: "/version",
      judge(status, body) {
        if (status !== 200) return `answered ${status}`;
        if (!expected) return null;
        const { build, commit } = (body ?? {}) as { build?: unknown; commit?: unknown };
        if (
          build === expected.build &&
          typeof commit === "string" &&
          sameCommit(commit, expected.commit)
        ) {
          return null;
        }
        // The answer goes into public reports, so only a well-formed build is repeated.
        const served =
          typeof build === "number" && typeof commit === "string"
            ? parseTag(`${build}-${commit}`)
            : null;
        return `serves ${served ? formatTag(served) : "another build"}, expected ${formatTag(expected)}`;
      },
    },
    {
      name: "telegram-webhook",
      method: "POST",
      path: "/webhooks/telegram/kelpie-deploy-probe",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "kelpie-deploy-probe",
      },
      body: "{}",
      judge: expectStatus(401, { 503: "channel-egress's secret store is unavailable" }),
    },
    {
      name: "github-webhook",
      method: "POST",
      path: "/github/webhook",
      headers: {
        "content-type": "application/json",
        "x-github-event": "ping",
        "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
      },
      body: "{}",
      judge: expectStatus(401),
    },
    ...(deepToken ? [deepProbe(deepToken)] : []),
  ];
}

async function runProbe(
  fetchImpl: typeof fetch,
  origin: string,
  probe: Probe,
): Promise<ProbeResult> {
  try {
    const signed = probe.signedHeaders ? await probe.signedHeaders() : {};
    const response = await fetchImpl(new URL(probe.path, origin), {
      method: probe.method,
      headers: { "user-agent": "kelpie-release", ...probe.headers, ...signed },
      ...(probe.body === undefined ? {} : { body: probe.body }),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    const mitigated = response.headers.get("cf-mitigated");
    const text = await response.text();
    if (mitigated) {
      return {
        probe: probe.name,
        outcome: "blocked",
        detail: `answered ${response.status} from the zone's security (cf-mitigated: ${mitigated}), not from the Worker`,
      };
    }
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      // Webhook refusals have no body.
    }
    const problem = probe.judge(response.status, body);
    return problem
      ? { probe: probe.name, outcome: "fail", detail: problem }
      : { probe: probe.name, outcome: "pass", detail: `answered ${response.status}` };
  } catch (error) {
    // The URL stays out of the message: CI logs are public.
    const name = error instanceof Error ? error.name : "error";
    return { probe: probe.name, outcome: "fail", detail: `no answer (${name})` };
  }
}

/** Runs every probe; the deep one too when `deepToken` is given. */
export function probeAll(
  fetchImpl: typeof fetch,
  origin: string,
  expected: BuildTag | null,
  deepToken?: string,
): Promise<ProbeResult[]> {
  return Promise.all(
    probes(expected, deepToken).map((probe) => runProbe(fetchImpl, origin, probe)),
  );
}

export type Verdict =
  | { status: "healthy" }
  | { status: "unhealthy"; reason: string }
  | { status: "inconclusive"; reason: string };

export function verdictOf(results: readonly ProbeResult[]): Verdict {
  const describe = (list: readonly ProbeResult[]) =>
    list.map((result) => `${result.probe} ${result.detail}`).join("; ");
  const failed = results.filter((result) => result.outcome === "fail");
  if (failed.length > 0)
    return { status: "unhealthy", reason: `probes failed: ${describe(failed)}` };
  const blocked = results.filter((result) => result.outcome === "blocked");
  if (blocked.length > 0) {
    return { status: "inconclusive", reason: `probes were blocked: ${describe(blocked)}` };
  }
  return { status: "healthy" };
}

export interface SettleOptions {
  attempts: number;
  intervalMs: number;
}

/**
 * Probes until every probe passes or the attempts run out. A new version takes a little while to
 * reach every Cloudflare location, so the first answers may still come from the old one.
 * `deepToken` adds the deep probe, for a deploy's new build only.
 */
export async function settle(
  deps: Pick<VerifyDeps, "fetch" | "sleep" | "log">,
  origin: string,
  expected: BuildTag | null,
  options: SettleOptions,
  deepToken?: string,
): Promise<ProbeResult[]> {
  let results: ProbeResult[] = [];
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    results = await probeAll(deps.fetch, origin, expected, deepToken);
    if (results.every((result) => result.outcome === "pass")) return results;
    if (attempt < options.attempts) await deps.sleep(options.intervalMs);
  }
  return results;
}

/** Statuses a broken version produces; client disconnects are left out. */
export const BAD_STATUSES: ReadonlySet<string> = new Set([
  "scriptThrewException",
  "exceededResources",
  "internalError",
]);

/** Failed invocations by Worker, with its Durable Objects counted apart. */
export function badInvocations(rows: readonly InvocationCount[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    if (!BAD_STATUSES.has(row.status)) continue;
    const key = row.dataset === "durableObjects" ? `${row.script} (Durable Objects)` : row.script;
    counts[key] = (counts[key] ?? 0) + row.requests;
  }
  return counts;
}

export interface WatchOptions {
  minutes: number;
  intervalMs: number;
  /** Failed invocations of the new versions, all Workers together, that make a deploy unhealthy. */
  errorThreshold: number;
  /** Failures in a row that make a probe count. */
  failuresInARow: number;
}

export interface WatchResult {
  verdict: Verdict;
  probes: ProbeResult[];
  errors: Record<string, number>;
  /** False when the analytics couldn't be read, so only the probes judged. */
  analytics: boolean;
}

/**
 * Watches the new versions for a while: the probes, and their failed invocations. `deepToken` adds
 * the deep probe.
 */
export async function watch(
  deps: VerifyDeps,
  origin: string,
  expected: BuildTag,
  versionIds: readonly string[],
  since: Date,
  options: WatchOptions,
  deepToken?: string,
): Promise<WatchResult> {
  const end = deps.now().getTime() + options.minutes * 60_000;
  const streaks = new Map<string, number>();
  let probes: ProbeResult[] = [];
  let errors: Record<string, number> = {};
  let analytics = true;
  for (;;) {
    probes = await probeAll(deps.fetch, origin, expected, deepToken);
    for (const result of probes) {
      streaks.set(
        result.probe,
        result.outcome === "fail" ? (streaks.get(result.probe) ?? 0) + 1 : 0,
      );
    }
    const failing = probes.filter(
      (result) => (streaks.get(result.probe) ?? 0) >= options.failuresInARow,
    );
    if (failing.length > 0) {
      const detail = failing.map((result) => `${result.probe} ${result.detail}`).join("; ");
      return {
        verdict: {
          status: "unhealthy",
          reason: `probes failed ${options.failuresInARow} times in a row: ${detail}`,
        },
        probes,
        errors,
        analytics,
      };
    }

    let failed = 0;
    try {
      const rows = await deps.api.invocations(versionIds, since, deps.now());
      errors = badInvocations(rows);
      // A Durable Object's exception also fails the Worker that called it: the two datasets are
      // judged apart, not added up.
      failed = Math.max(
        ...(["workers", "durableObjects"] as const).map((dataset) =>
          rows
            .filter((row) => row.dataset === dataset && BAD_STATUSES.has(row.status))
            .reduce((sum, row) => sum + row.requests, 0),
        ),
      );
      analytics = true;
    } catch (error) {
      if (analytics) {
        deps.log.warn(
          `Analytics unavailable, so only the probes judge: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      analytics = false;
    }
    if (failed >= options.errorThreshold) {
      const detail = Object.entries(errors)
        .map(([script, count]) => `${script}: ${count}`)
        .join(", ");
      return {
        verdict: {
          status: "unhealthy",
          reason: `the new versions failed ${failed} invocations (${detail})`,
        },
        probes,
        errors,
        analytics,
      };
    }

    // A probe that just failed is probed again until it passes or counts, even past the end.
    const settled = [...streaks.values()].every((streak) => streak === 0);
    if (deps.now().getTime() >= end && settled) break;
    await deps.sleep(options.intervalMs);
  }
  return { verdict: verdictOf(probes), probes, errors, analytics };
}
