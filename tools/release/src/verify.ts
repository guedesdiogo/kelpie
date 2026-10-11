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
  body?: string;
  /** Null when the answer is the expected one, otherwise what was wrong with it. */
  judge(status: number, body: unknown): string | null;
}

/**
 * What the probes reach from outside, without a login:
 * - `/health` and `/version`: ingress runs, and serves the expected build;
 * - a Telegram update with a wrong secret: ingress asks channel-egress, which reads its
 *   `SecretStore` object, so that object wakes and applies its migrations. A broken store answers
 *   503;
 * - a GitHub delivery with a wrong signature: ingress hands it to context-store.
 * The refusals change nothing: no agent is named, so no notice or conversation runs.
 */
function probes(expected: BuildTag | null): Probe[] {
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
  ];
}

async function runProbe(
  fetchImpl: typeof fetch,
  origin: string,
  probe: Probe,
): Promise<ProbeResult> {
  try {
    const response = await fetchImpl(new URL(probe.path, origin), {
      method: probe.method,
      headers: { "user-agent": "kelpie-release", ...probe.headers },
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

export function probeAll(
  fetchImpl: typeof fetch,
  origin: string,
  expected: BuildTag | null,
): Promise<ProbeResult[]> {
  return Promise.all(probes(expected).map((probe) => runProbe(fetchImpl, origin, probe)));
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
 */
export async function settle(
  deps: Pick<VerifyDeps, "fetch" | "sleep" | "log">,
  origin: string,
  expected: BuildTag | null,
  options: SettleOptions,
): Promise<ProbeResult[]> {
  let results: ProbeResult[] = [];
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    results = await probeAll(deps.fetch, origin, expected);
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

/** Watches the new versions for a while: the probes, and their failed invocations. */
export async function watch(
  deps: VerifyDeps,
  origin: string,
  expected: BuildTag,
  versionIds: readonly string[],
  since: Date,
  options: WatchOptions,
): Promise<WatchResult> {
  const end = deps.now().getTime() + options.minutes * 60_000;
  const streaks = new Map<string, number>();
  let probes: ProbeResult[] = [];
  let errors: Record<string, number> = {};
  let analytics = true;
  for (;;) {
    probes = await probeAll(deps.fetch, origin, expected);
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

    try {
      errors = badInvocations(await deps.api.invocations(versionIds, since, deps.now()));
      analytics = true;
    } catch (error) {
      if (analytics) {
        deps.log.warn(
          `Analytics unavailable, so only the probes judge: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      analytics = false;
    }
    const total = Object.values(errors).reduce((sum, count) => sum + count, 0);
    if (total >= options.errorThreshold) {
      const detail = Object.entries(errors)
        .map(([script, count]) => `${script}: ${count}`)
        .join(", ");
      return {
        verdict: {
          status: "unhealthy",
          reason: `the new versions failed ${total} invocations (${detail})`,
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
