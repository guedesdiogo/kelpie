import { describe, expect, it } from "vitest";
import { CloudflareError, cloudflareApi } from "../src/cloudflare.ts";

const ACCOUNT = "0123456789abcdef0123456789abcdef";

function recorder(answer: (url: URL, init: RequestInit) => Response) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return answer(url, init);
  }) as typeof fetch;
  return { calls, api: cloudflareApi("token", ACCOUNT, fetchImpl) };
}

describe("cloudflareApi", () => {
  it("deploys versions the way wrangler rollback does", async () => {
    const { calls, api } = recorder(() => Response.json({ success: true, result: {} }));
    await api.deployVersions(
      "kelpie-ingress",
      [{ version_id: "v1", percentage: 100 }],
      "m".repeat(150),
      true,
    );
    const [call] = calls;
    expect(call?.url.pathname).toBe(
      `/client/v4/accounts/${ACCOUNT}/workers/scripts/kelpie-ingress/deployments`,
    );
    expect(call?.url.search).toBe("?force=true");
    expect(call?.init.method).toBe("POST");
    expect(JSON.parse(String(call?.init.body))).toEqual({
      strategy: "percentage",
      versions: [{ version_id: "v1", percentage: 100 }],
      annotations: { "workers/message": "m".repeat(100) },
    });
    expect(new Headers(call?.init.headers).get("authorization")).toBe("Bearer token");
  });

  it("raises the API's error codes, without the account id", async () => {
    const { api } = recorder(() =>
      Response.json(
        { success: false, errors: [{ code: 10220, message: "secrets changed" }], result: null },
        { status: 400 },
      ),
    );
    const error = await api
      .deployVersions("kelpie-ingress", [], "m", false)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CloudflareError);
    expect((error as CloudflareError).codes).toEqual([10220]);
    expect((error as CloudflareError).message).not.toContain(ACCOUNT);
    expect((error as CloudflareError).message).toContain("secrets changed [10220]");
  });

  it("reads the active deployment and the deployable versions", async () => {
    const { calls, api } = recorder((url) =>
      url.pathname.endsWith("/deployments")
        ? Response.json({
            success: true,
            result: { deployments: [{ id: "d2", versions: [] }, { id: "d1" }] },
          })
        : Response.json({ success: true, result: { items: [{ id: "v1", number: 1 }] } }),
    );
    expect((await api.activeDeployment("kelpie-ingress"))?.id).toBe("d2");
    expect(await api.deployableVersions("kelpie-ingress")).toEqual([{ id: "v1", number: 1 }]);
    expect(calls[1]?.url.search).toBe("?deployable=true");
  });

  it("counts invocations of the given versions from both datasets", async () => {
    const { calls, api } = recorder(() =>
      Response.json({
        data: {
          viewer: {
            accounts: [
              {
                workers: [
                  {
                    sum: { requests: 4 },
                    dimensions: { scriptName: "kelpie-ingress", status: "success" },
                  },
                ],
                durableObjects: [
                  {
                    sum: { requests: 1 },
                    dimensions: { scriptName: "kelpie-ingress", status: "scriptThrewException" },
                  },
                ],
              },
            ],
          },
        },
        errors: null,
      }),
    );
    const rows = await api.invocations(["v1"], new Date(0), new Date(60_000));
    expect(rows).toEqual([
      { dataset: "workers", script: "kelpie-ingress", status: "success", requests: 4 },
      {
        dataset: "durableObjects",
        script: "kelpie-ingress",
        status: "scriptThrewException",
        requests: 1,
      },
    ]);
    expect(JSON.parse(String(calls[0]?.init.body)).variables).toEqual({
      account: ACCOUNT,
      versions: ["v1"],
      since: "1970-01-01T00:00:00.000Z",
      until: "1970-01-01T00:01:00.000Z",
    });
  });

  it("fails on GraphQL errors", async () => {
    const { api } = recorder(() =>
      Response.json({ data: null, errors: [{ message: "not authorized" }] }),
    );
    await expect(api.invocations(["v1"], new Date(0), new Date(1))).rejects.toThrow(
      "not authorized",
    );
  });
});
