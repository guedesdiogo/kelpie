import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Report, runExperiment } from "../src/experiment.ts";
import { authorized } from "../src/index.ts";
import { decodeBase64Text, generateAppKey } from "./helpers.ts";

// The Worker runs in the test's isolate, so stubbing the global fetch stands in for GitHub. The
// fake's response shapes follow GitHub's GraphQL schema; its stale-head error is made up, because
// the real one is what the spike measures.

const run = (headers: Record<string, string> = {}, method = "POST", path = "/run") =>
  exports.default.fetch(new Request(`https://spike.example${path}`, { method, headers }));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("route", () => {
  it("serves nothing but POST /run", async () => {
    expect((await run({ "x-spike-token": "test-spike-token" }, "GET")).status).toBe(404);
    expect((await run({ "x-spike-token": "test-spike-token" }, "POST", "/")).status).toBe(404);
  });

  it("answers 401 without the right x-spike-token, before touching GitHub", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    expect((await run()).status).toBe(401);
    expect((await run({ "x-spike-token": "wrong" })).status).toBe(401);
    expect((await run({ "x-spike-token": "" })).status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("runs the experiment with the right token and reports a failed step as 502", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const response = await run({ "x-spike-token": "test-spike-token" });

    // The test binding holds no key, so the run stops at the first step.
    expect(response.status).toBe(502);
    const report = (await response.json()) as Report;
    expect(report.steps).toEqual([
      {
        name: "sign-app-jwt",
        ok: false,
        ms: expect.any(Number),
        error: expect.stringMatching(/not a PKCS#8 PEM/),
      },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("authorized", () => {
  const request = (token?: string) =>
    new Request("https://spike.example/run", {
      headers: token === undefined ? {} : { "x-spike-token": token },
    });

  it("never matches when SPIKE_TOKEN is empty or missing", async () => {
    expect(await authorized(request(""), "")).toBe(false);
    expect(await authorized(request(), "")).toBe(false);
    expect(await authorized(request("anything"), undefined)).toBe(false);
  });

  it("matches only the exact token", async () => {
    expect(await authorized(request("secret"), "secret")).toBe(true);
    expect(await authorized(request("Secret"), "secret")).toBe(false);
    expect(await authorized(request("secre"), "secret")).toBe(false);
  });
});

type Variables = Record<string, unknown> & {
  input?: {
    expectedHeadOid: string;
    fileChanges: {
      additions?: { path: string; contents: string }[];
      deletions?: { path: string }[];
    };
  };
};

/** An in-memory GitHub: one branch, no history. `enforceHead: false` accepts any expectedHeadOid. */
function fakeGitHub({ enforceHead = true, tokenStatus = 201 } = {}) {
  const files = new Map<string, string>();
  const authorizations: string[] = [];
  let head = "oid-0";
  let commits = 0;

  const handler = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    authorizations.push(request.headers.get("authorization") ?? "");
    if (new URL(request.url).pathname.endsWith("/access_tokens")) {
      return tokenStatus === 201
        ? Response.json(
            {
              token: "ghs_fake_installation_token",
              expires_at: "2026-10-03T13:00:00Z",
              permissions: { contents: "write", metadata: "read" },
              repositories: [{ full_name: "guedesdiogo/kelpie-context-test" }],
            },
            { status: 201 },
          )
        : Response.json({ message: "made-up JWT error" }, { status: tokenStatus });
    }
    const { query, variables } = (await request.json()) as { query: string; variables: Variables };
    if (query.includes("defaultBranchRef")) {
      return Response.json({ data: { repository: { defaultBranchRef: { name: "main" } } } });
    }
    if (query.includes("ref(qualifiedName")) {
      return Response.json({ data: { repository: { ref: { target: { oid: head } } } } });
    }
    if (query.includes("createCommitOnBranch") && variables.input) {
      const { expectedHeadOid, fileChanges } = variables.input;
      if (enforceHead && expectedHeadOid !== head) {
        return Response.json({
          data: { createCommitOnBranch: null },
          errors: [
            {
              type: "STALE_DATA",
              path: ["createCommitOnBranch"],
              locations: [{ line: 2, column: 3 }],
              message: "made-up stale head error",
            },
          ],
        });
      }
      for (const { path, contents } of fileChanges.additions ?? []) {
        files.set(path, decodeBase64Text(contents));
      }
      for (const { path } of fileChanges.deletions ?? []) files.delete(path);
      commits += 1;
      head = `oid-${commits}`;
      return Response.json({
        data: {
          createCommitOnBranch: {
            commit: {
              oid: head,
              url: `https://example/${head}`,
              signature: { isValid: true, state: "VALID" },
            },
          },
        },
      });
    }
    // The read-back: `$eN` is "<oid>:<path>", answered from the current tree.
    const repository = Object.fromEntries(
      Object.entries(variables)
        .filter(([key]) => /^e\d+$/.test(key))
        .map(([key, expression]) => {
          const text = files.get(String(expression).split(":").slice(1).join(":"));
          return [`f${key.slice(1)}`, text === undefined ? null : { text }];
        }),
    );
    return Response.json({ data: { repository } });
  };

  return { handler, files, authorizations };
}

const config = (privateKeyPem: string) => ({
  appId: "5181584",
  installationId: "167691807",
  repository: "guedesdiogo/kelpie-context-test",
  privateKeyPem,
});

const NOW = new Date(Date.UTC(2026, 9, 3, 12, 0, 0, 123));

describe("runExperiment", () => {
  it("commits three files, sees the stale head rejected, then updates and deletes in one commit", async () => {
    const { pem } = await generateAppKey();
    const github = fakeGitHub();
    vi.spyOn(globalThis, "fetch").mockImplementation(github.handler);

    const report = await runExperiment(config(pem), NOW);

    expect(report.completed).toBe(true);
    expect(report.runFolder).toBe("spike-runs/2026-10-03T12-00-00.123Z");
    expect(report.steps.map((step) => [step.name, step.ok])).toEqual([
      ["sign-app-jwt", true],
      ["installation-token", true],
      ["default-branch", true],
      ["read-head", true],
      ["commit-three-files", true],
      ["stale-expected-head-oid", true],
      ["commit-update-and-delete", true],
      ["read-back", true],
    ]);
    expect(report.steps[5]).toMatchObject({
      status: 200,
      rejected: true,
      expectedHeadOid: "oid-0",
      headOidAfter: "oid-1",
      headUnchanged: true,
      errors: [
        { type: "STALE_DATA", path: ["createCommitOnBranch"], message: "made-up stale head error" },
      ],
    });
    expect(report.steps[4]).toMatchObject({
      expectedHeadOid: "oid-0",
      oid: "oid-1",
      signature: { isValid: true, state: "VALID" },
    });
    expect(report.steps[6]).toMatchObject({ expectedHeadOid: "oid-1", oid: "oid-2" });
    expect([...github.files.keys()].sort()).toEqual([
      `${report.runFolder}/a.md`,
      `${report.runFolder}/nested/c.md`,
    ]);
    expect(github.files.get(`${report.runFolder}/a.md`)).toContain("Olá, ✓");
  });

  it("sends the JWT only to the token endpoint and keeps credentials out of the report", async () => {
    const { pem } = await generateAppKey();
    const github = fakeGitHub();
    vi.spyOn(globalThis, "fetch").mockImplementation(github.handler);

    const report = await runExperiment(config(pem), NOW);

    const [jwtAuthorization = "", ...graphqlAuthorizations] = github.authorizations;
    expect(jwtAuthorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(new Set(graphqlAuthorizations)).toEqual(new Set(["Bearer ghs_fake_installation_token"]));
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("ghs_fake_installation_token");
    expect(serialized).not.toContain(jwtAuthorization.slice("Bearer ".length));
    expect(serialized).not.toContain("PRIVATE KEY");
  });

  it("reports an accepted stale commit as the finding instead of failing the run", async () => {
    const { pem } = await generateAppKey();
    vi.spyOn(globalThis, "fetch").mockImplementation(fakeGitHub({ enforceHead: false }).handler);

    const report = await runExperiment(config(pem), NOW);

    expect(report.completed).toBe(true);
    expect(report.steps[5]).toMatchObject({
      name: "stale-expected-head-oid",
      ok: false,
      rejected: false,
      unexpectedCommitOid: "oid-2",
      headUnchanged: false,
    });
    expect(report.steps[6]).toMatchObject({ ok: true, expectedHeadOid: "oid-2", oid: "oid-3" });
  });

  it("stops at the token exchange and keeps GitHub's status and message", async () => {
    const { pem } = await generateAppKey();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(fakeGitHub({ tokenStatus: 401 }).handler);

    const report = await runExperiment(config(pem), NOW);

    expect(report.completed).toBe(false);
    expect(report.steps.at(-1)).toMatchObject({
      name: "installation-token",
      ok: false,
      status: 401,
      error: "made-up JWT error",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
