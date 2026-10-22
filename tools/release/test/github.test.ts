import { describe, expect, it } from "vitest";
import { GitHubError, githubApi, repositoryOf } from "../src/github.ts";

const REPO = "guedesdiogo/kelpie";

function recorder(answer: (url: URL, init: RequestInit) => Response) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return answer(url, init);
  }) as typeof fetch;
  return { calls, github: githubApi("token", REPO, fetchImpl) };
}

const sha = (n: number) => n.toString(16).padStart(40, "0");

const pullNode = (number: number, overrides: Record<string, unknown> = {}) => ({
  number,
  title: `Pull request ${number}`,
  url: `https://github.com/${REPO}/pull/${number}`,
  merged: true,
  baseRefName: "main",
  author: { login: "mentee" },
  closingIssuesReferences: {
    totalCount: 1,
    nodes: [
      {
        number: 1,
        title: "Issue 1",
        url: `https://github.com/${REPO}/issues/1`,
        repository: { nameWithOwner: REPO },
        labels: { totalCount: 1, nodes: [{ name: "critico" }] },
      },
    ],
  },
  ...overrides,
});

describe("repositoryOf", () => {
  it.each([
    ["https://github.com/guedesdiogo/kelpie.git", REPO],
    ["https://github.com/guedesdiogo/kelpie", REPO],
    ["git@github.com:guedesdiogo/kelpie.git\n", REPO],
    ["ssh://git@github.com/guedesdiogo/kelpie.git", REPO],
    ["https://gitlab.com/guedesdiogo/kelpie.git", null],
  ])("reads %j", (remote, repo) => {
    expect(repositoryOf(remote)).toBe(repo);
  });
});

describe("githubApi", () => {
  it("asks GraphQL for 50 commits at a time, and keeps each pull request merged into main once", async () => {
    const commits = Array.from({ length: 60 }, (_, index) => sha(index + 1));
    const { calls, github } = recorder((_, init) => {
      const { query } = JSON.parse(String(init.body)) as { query: string };
      const count = (query.match(/object\(oid:/g) ?? []).length;
      const repository: Record<string, unknown> = { defaultBranchRef: { name: "main" } };
      for (let index = 0; index < count; index++) {
        repository[`c${index}`] = { associatedPullRequests: { totalCount: 0, nodes: [] } };
      }
      repository.c0 = {
        associatedPullRequests: {
          totalCount: 3,
          nodes: [
            pullNode(count === 50 ? 12 : 11),
            pullNode(99, { merged: false }),
            pullNode(98, { baseRefName: "release" }),
          ],
        },
      };
      repository.c1 = {
        associatedPullRequests: { totalCount: 1, nodes: [pullNode(12, { author: null })] },
      };
      return Response.json({ data: { repository } });
    });
    const pulls = await github.mergedPulls(commits);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url.href).toBe("https://api.github.com/graphql");
    expect(calls[0]?.init.method).toBe("POST");
    const first = JSON.parse(String(calls[0]?.init.body)) as {
      query: string;
      variables: Record<string, string>;
    };
    expect(first.variables).toEqual({ owner: "guedesdiogo", name: "kelpie" });
    expect(first.query).toContain(`c49: object(oid: "${sha(50)}")`);
    expect(first.query).not.toContain(sha(51));
    expect(JSON.parse(String(calls[1]?.init.body)).query).toContain(
      `c9: object(oid: "${sha(60)}")`,
    );
    expect(pulls).toEqual([
      {
        number: 11,
        title: "Pull request 11",
        url: `https://github.com/${REPO}/pull/11`,
        author: "mentee",
        closes: [
          {
            repo: REPO,
            number: 1,
            title: "Issue 1",
            url: `https://github.com/${REPO}/issues/1`,
            labels: ["critico"],
          },
        ],
      },
      expect.objectContaining({ number: 12, author: null }),
    ]);
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer token");
    expect(headers.get("user-agent")).toBe("kelpie-release");
  });

  it("asks nothing for no commits, and refuses anything but a full commit id", async () => {
    const { calls, github } = recorder(() => Response.json({}));
    expect(await github.mergedPulls([])).toEqual([]);
    expect(calls).toEqual([]);
    await expect(github.mergedPulls(['abc") { id } x: object(oid: "'])).rejects.toThrow(
      "isn't a full commit id",
    );
  });

  it("fails rather than miss a pull request, an issue or a label", async () => {
    const answer = (c0: unknown) => () =>
      Response.json({ data: { repository: { defaultBranchRef: { name: "main" }, c0 } } });
    const cases: Array<[unknown, string]> = [
      [null, `GitHub doesn't know the commit ${sha(1)}`],
      [{ associatedPullRequests: { totalCount: 4, nodes: [] } }, "more than the 0 one query reads"],
      [
        {
          associatedPullRequests: {
            totalCount: 1,
            nodes: [pullNode(5, { closingIssuesReferences: { totalCount: 26, nodes: [] } })],
          },
        },
        "#5's closing issues has 26",
      ],
      [
        {
          associatedPullRequests: {
            totalCount: 1,
            nodes: [
              pullNode(5, {
                closingIssuesReferences: {
                  totalCount: 1,
                  nodes: [
                    {
                      number: 1,
                      title: "t",
                      url: "https://github.com/x/y/issues/1",
                      repository: { nameWithOwner: "x/y" },
                      labels: { totalCount: 31, nodes: [] },
                    },
                  ],
                },
              }),
            ],
          },
        },
        "https://github.com/x/y/issues/1's labels has 31",
      ],
    ];
    for (const [c0, message] of cases) {
      await expect(recorder(answer(c0)).github.mergedPulls([sha(1)])).rejects.toThrow(message);
    }
    const missing = recorder(() => Response.json({ data: { repository: null } }));
    await expect(missing.github.mergedPulls([sha(1)])).rejects.toThrow(
      `GitHub doesn't show ${REPO}.`,
    );
  });

  it("tells whether a label exists, failing on anything but a 404", async () => {
    const answers = [
      Response.json({ name: "critico" }),
      Response.json({ message: "Not Found" }, { status: 404 }),
      Response.json({ message: "Bad credentials" }, { status: 401 }),
    ];
    const { calls, github } = recorder(() => answers.shift() as Response);
    expect(await github.hasLabel("critico")).toBe(true);
    expect(await github.hasLabel("critico")).toBe(false);
    await expect(github.hasLabel("critico")).rejects.toThrow("failed (401): Bad credentials");
    expect(calls[0]?.url.pathname).toBe(`/repos/${REPO}/labels/critico`);
  });

  it("reads a workflow's successful runs: name, event, branch and commit", async () => {
    const { calls, github } = recorder(() =>
      Response.json({
        workflow_runs: [
          {
            display_title: "Production v0.2.0",
            event: "release",
            head_branch: "v0.2.0",
            head_sha: sha(2),
          },
          {
            display_title: "Production v0.1.0",
            event: "workflow_dispatch",
            head_branch: null,
            head_sha: sha(1),
          },
        ],
      }),
    );
    expect(await github.successfulRuns("deploy.yml")).toEqual([
      { title: "Production v0.2.0", event: "release", branch: "v0.2.0", commit: sha(2) },
      { title: "Production v0.1.0", event: "workflow_dispatch", branch: null, commit: sha(1) },
    ]);
    expect(calls[0]?.url.pathname).toBe(`/repos/${REPO}/actions/workflows/deploy.yml/runs`);
    expect(calls[0]?.url.search).toBe("?status=success&per_page=100");
  });

  it("raises GraphQL's errors", async () => {
    const { github } = recorder(() =>
      Response.json({ data: null, errors: [{ message: "Something went wrong" }] }),
    );
    await expect(github.mergedPulls([sha(1)])).rejects.toThrow(
      "GitHub API POST /graphql failed (200): Something went wrong",
    );
  });

  it("reads every page of an issue's comments", async () => {
    const page = (count: number, from: number) =>
      Array.from({ length: count }, (_, index) => ({
        user: index === 0 ? null : { login: "guedesdiogo" },
        body: index === 1 ? null : `comment ${from + index}`,
        html_url: `https://github.com/${REPO}/issues/1#issuecomment-${from + index}`,
      }));
    const { calls, github } = recorder((url) =>
      Response.json(url.searchParams.get("page") === "1" ? page(100, 0) : page(2, 100)),
    );
    const comments = await github.comments("guedesdiogo/prumo", 7);
    expect(calls.map((call) => call.url.pathname + call.url.search)).toEqual([
      "/repos/guedesdiogo/prumo/issues/7/comments?per_page=100&page=1",
      "/repos/guedesdiogo/prumo/issues/7/comments?per_page=100&page=2",
    ]);
    expect(comments).toHaveLength(102);
    expect(comments[0]).toEqual({
      author: null,
      body: "comment 0",
      url: `https://github.com/${REPO}/issues/1#issuecomment-0`,
    });
    expect(comments[1]?.body).toBe("");
  });

  it("comments, and opens issues in its repository", async () => {
    const { calls, github } = recorder((url) =>
      Response.json({ html_url: `https://github.com${url.pathname}/1` }, { status: 201 }),
    );
    expect(await github.comment("guedesdiogo/prumo", 7, "hi")).toBe(
      "https://github.com/repos/guedesdiogo/prumo/issues/7/comments/1",
    );
    const issue = { title: "t", body: "b", assignees: ["guedesdiogo"], labels: ["critico"] };
    expect(await github.openIssue(issue)).toBe(`https://github.com/repos/${REPO}/issues/1`);
    expect(calls.map((call) => [call.init.method, JSON.parse(String(call.init.body))])).toEqual([
      ["POST", { body: "hi" }],
      ["POST", issue],
    ]);
  });

  it("reads the latest run of a check, by name", async () => {
    const answers = [
      { check_runs: [{ status: "completed", conclusion: "success" }] },
      { check_runs: [{ status: "in_progress", conclusion: null }] },
      { check_runs: [] },
    ];
    const { calls, github } = recorder(() => Response.json(answers.shift()));
    expect(await github.checkState(sha(1), "CI passed")).toBe("success");
    expect(await github.checkState(sha(1), "CI passed")).toBe("in_progress");
    expect(await github.checkState(sha(1), "CI passed")).toBeNull();
    expect(calls[0]?.url.pathname).toBe(`/repos/${REPO}/commits/${sha(1)}/check-runs`);
    expect(calls[0]?.url.search).toBe("?check_name=CI%20passed&filter=latest");
  });

  it("lists, creates and updates releases", async () => {
    const raw = {
      id: 3,
      tag_name: "v0.2.0",
      target_commitish: sha(1),
      draft: true,
      prerelease: false,
      html_url: `https://github.com/${REPO}/releases/tag/untagged-1`,
    };
    // Only the list has a query string.
    const { calls, github } = recorder((url) => Response.json(url.search ? [raw] : raw));
    const release = {
      id: 3,
      tag: "v0.2.0",
      target: sha(1),
      draft: true,
      prerelease: false,
      url: raw.html_url,
    };
    expect(await github.releases()).toEqual([release]);
    const fields = { tag: "v0.2.0", target: sha(1), name: "v0.2.0", body: "notes", draft: false };
    expect(await github.createRelease(fields)).toEqual(release);
    expect(await github.updateRelease(3, fields)).toEqual(release);
    expect(calls.map((call) => `${call.init.method ?? "GET"} ${call.url.pathname}`)).toEqual([
      `GET /repos/${REPO}/releases`,
      `POST /repos/${REPO}/releases`,
      `PATCH /repos/${REPO}/releases/3`,
    ]);
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      tag_name: "v0.2.0",
      target_commitish: sha(1),
      name: "v0.2.0",
      body: "notes",
      draft: false,
      prerelease: false,
    });
  });

  it("raises REST errors with GitHub's message, without the query", async () => {
    const { github } = recorder(() => Response.json({ message: "Not Found" }, { status: 404 }));
    const error = await github.releases().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).status).toBe(404);
    expect((error as GitHubError).message).toBe(
      `GitHub API GET /repos/${REPO}/releases failed (404): Not Found`,
    );
    const { github: silent } = recorder(() => new Response("oops", { status: 502 }));
    await expect(silent.comment(REPO, 1, "b")).rejects.toThrow(
      `GitHub API POST /repos/${REPO}/issues/1/comments failed (502)`,
    );
  });
});
