const API = "https://api.cloudflare.com/client/v4";

/** The API's answer when a rollback's target has other secrets than the live version. */
export const SECRETS_CHANGED = 10220;

export interface VersionTraffic {
  version_id: string;
  percentage: number;
}

export interface Deployment {
  id: string;
  created_on: string;
  versions: VersionTraffic[];
  annotations?: Record<string, string | undefined>;
}

export interface Binding {
  type: string;
  name: string;
  text?: string;
}

export interface WorkerVersion {
  id: string;
  number: number;
  metadata?: { created_on?: string };
  annotations?: Record<string, string | undefined>;
  resources?: { bindings?: Binding[] };
}

/** Invocations of a version, by Worker and status, from the GraphQL Analytics API. */
export interface InvocationCount {
  dataset: "workers" | "durableObjects";
  script: string;
  status: string;
  requests: number;
}

export class CloudflareError extends Error {
  constructor(
    message: string,
    readonly codes: readonly number[],
  ) {
    super(message);
    this.name = "CloudflareError";
  }
}

/** The parts of Cloudflare's API that deploys and rollbacks use. */
export interface CloudflareApi {
  /** The deployment serving traffic now, or null for a Worker never deployed. */
  activeDeployment(script: string): Promise<Deployment | null>;
  /** The most recent deployments, newest first: the one serving now, then what came before. */
  deployments(script: string): Promise<Deployment[]>;
  version(script: string, versionId: string): Promise<WorkerVersion>;
  /** The versions a rollback can reach: the 100 most recent. */
  deployableVersions(script: string): Promise<WorkerVersion[]>;
  /** Serves these versions, as `wrangler rollback` does. */
  deployVersions(
    script: string,
    traffic: readonly VersionTraffic[],
    message: string,
    force: boolean,
  ): Promise<void>;
  invocations(versionIds: readonly string[], since: Date, until: Date): Promise<InvocationCount[]>;
}

interface Envelope<T> {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result: T;
}

export function cloudflareApi(
  token: string,
  accountId: string,
  fetchImpl: typeof fetch = fetch,
): CloudflareApi {
  const scripts = `${API}/accounts/${accountId}/workers/scripts`;

  async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await fetchImpl(url, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...init.headers,
      },
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await response.json().catch(() => null)) as Envelope<T> | null;
    if (!response.ok || !body?.success) {
      const errors = body?.errors ?? [];
      const detail = errors.map((error) => `${error.message} [${error.code}]`).join("; ");
      throw new CloudflareError(
        // Reports reach public issues, so the account id stays out of the path.
        `Cloudflare API ${init.method ?? "GET"} ${new URL(url).pathname.replaceAll(accountId, "<account>")} failed (${response.status})${detail ? `: ${detail}` : ""}`,
        errors.map((error) => error.code),
      );
    }
    return body.result;
  }

  async function deployments(script: string): Promise<Deployment[]> {
    const result = await call<{ deployments: Deployment[] }>(`${scripts}/${script}/deployments`);
    return result.deployments;
  }

  return {
    deployments,

    async activeDeployment(script) {
      return (await deployments(script))[0] ?? null;
    },

    version: (script, versionId) => call(`${scripts}/${script}/versions/${versionId}`),

    async deployableVersions(script) {
      const { items } = await call<{ items: WorkerVersion[] }>(
        `${scripts}/${script}/versions?deployable=true`,
      );
      return items;
    },

    async deployVersions(script, traffic, message, force) {
      await call(`${scripts}/${script}/deployments${force ? "?force=true" : ""}`, {
        method: "POST",
        body: JSON.stringify({
          strategy: "percentage",
          versions: traffic,
          annotations: { "workers/message": message.slice(0, 100) },
        }),
      });
    },

    async invocations(versionIds, since, until) {
      const query = `query ($account: string!, $versions: [string!], $since: Time!, $until: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    workers: workersInvocationsAdaptive(limit: 1000, filter: { scriptVersion_in: $versions, datetime_geq: $since, datetime_leq: $until }) { sum { requests } dimensions { scriptName status } }
    durableObjects: durableObjectsInvocationsAdaptiveGroups(limit: 1000, filter: { scriptVersion_in: $versions, datetime_geq: $since, datetime_leq: $until }) { sum { requests } dimensions { scriptName status } }
  } }
}`;
      type Row = { sum: { requests: number }; dimensions: { scriptName: string; status: string } };
      const response = await fetchImpl(`${API}/graphql`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          query,
          variables: {
            account: accountId,
            versions: versionIds,
            since: since.toISOString(),
            until: until.toISOString(),
          },
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = (await response.json().catch(() => null)) as {
        data?: { viewer?: { accounts?: Array<Record<"workers" | "durableObjects", Row[]>> } };
        errors?: Array<{ message: string }> | null;
      } | null;
      const account = body?.data?.viewer?.accounts?.[0];
      if (!response.ok || !account || (body?.errors?.length ?? 0) > 0) {
        const detail = body?.errors?.map((error) => error.message).join("; ") ?? "";
        throw new CloudflareError(
          `Cloudflare GraphQL query failed (${response.status})${detail ? `: ${detail}` : ""}`,
          [],
        );
      }
      return (["workers", "durableObjects"] as const).flatMap((dataset) =>
        account[dataset].map((row) => ({
          dataset,
          script: row.dimensions.scriptName,
          status: row.dimensions.status,
          requests: row.sum.requests,
        })),
      );
    },
  };
}
