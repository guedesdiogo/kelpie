import { beforeAll, describe, expect, it } from "vitest";
import { base64 } from "../src/github/encoding.ts";
import { GitHubError, GitHubVaultBackend, gitBlobSha } from "../src/index.ts";
import { decodeBase64Text, generateAppKey } from "./helpers.ts";

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const TOKEN = "installation-token-for-tests";

interface Call {
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
}

/** GitHub's API as the adapter uses it, answering from fixed data and recording each call. */
function fakeGitHub(files: Record<string, string>, options: { stale?: boolean } = {}) {
  const calls: Call[] = [];
  let tokens = 0;
  const json = (status: number, body: unknown) => Response.json(body, { status });
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const method = init?.method ?? "GET";
    const path = url.pathname + url.search;
    calls.push({
      method,
      path,
      authorization: new Headers(init?.headers).get("authorization"),
      body,
    });
    if (path === "/app/installations/7/access_tokens") {
      tokens += 1;
      return json(201, { token: TOKEN, expires_at: new Date(NOW + 3_600_000).toISOString() });
    }
    if (path === "/repos/owner/vault") return json(200, { default_branch: "main" });
    if (path === "/repos/owner/vault/git/ref/heads/main")
      return json(200, { object: { sha: HEAD } });
    if (path === "/repos/owner/vault/git/ref/heads/gone")
      return json(404, { message: "Not Found" });
    if (path === `/repos/owner/vault/git/trees/${HEAD}?recursive=1`) {
      return json(200, {
        truncated: false,
        tree: [
          ...Object.keys(files).map((p) => ({ path: p, type: "blob", sha: `sha-${p}`, size: 10 })),
          { path: "memory", type: "tree", sha: "t1" },
          { path: ".obsidian/workspace.md", type: "blob", sha: "s1", size: 10 },
          { path: "photo.png", type: "blob", sha: "s2", size: 10 },
          { path: "huge.md", type: "blob", sha: "s3", size: 2_000_000 },
        ],
      });
    }
    if (path === `/repos/owner/vault/compare/${BASE}...${HEAD}`) {
      return json(200, {
        status: "ahead",
        files: [
          { filename: "memory/notes/a.md", status: "modified", sha: "sha-memory/notes/a.md" },
          { filename: "knowledge/old.md", status: "removed", sha: "x" },
          {
            filename: "memory/notes/b.md",
            status: "renamed",
            sha: "sha-memory/notes/b.md",
            previous_filename: "memory/notes/b-old.md",
          },
          { filename: "photo.png", status: "added", sha: "y" },
        ],
      });
    }
    if (path === `/repos/owner/vault/compare/${HEAD}...${BASE}`) {
      return json(200, { status: "diverged", files: [] });
    }
    if (path === "/repos/owner/vault/git/blobs/sha-long.md") {
      return json(200, {
        encoding: "base64",
        content: base64(new TextEncoder().encode(files["long.md"] ?? "")),
      });
    }
    if (path === "/graphql") {
      const { query, variables } = body as { query: string; variables: Record<string, unknown> };
      if (query.includes("createCommitOnBranch")) {
        if (options.stale) {
          return json(200, {
            data: null,
            errors: [{ type: "STALE_DATA", message: "Expected branch to point to …" }],
          });
        }
        return json(200, { data: { createCommitOnBranch: { commit: { oid: "c".repeat(40) } } } });
      }
      const repository: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(variables)) {
        if (!key.startsWith("e")) continue;
        const filePath = String(value).slice(41);
        const text = files[filePath];
        repository[`f${key.slice(1)}`] =
          text === undefined
            ? null
            : filePath === "long.md"
              ? { text: "cut", isTruncated: true }
              : { text, isTruncated: false };
      }
      return json(200, { data: { repository } });
    }
    if (path === "/repos/owner/vault/git/refs") return json(201, { ref: "refs/heads/x" });
    if (path === "/repos/owner/vault/pulls") {
      return json(201, { number: 12, html_url: "https://github.com/owner/vault/pull/12" });
    }
    return json(404, { message: "Not Found" });
  };
  return { fetch: fetchFn as typeof fetch, calls, tokens: () => tokens };
}

let privateKey = "";
beforeAll(async () => {
  privateKey = (await generateAppKey()).pem;
});

function backend(github: ReturnType<typeof fakeGitHub>, now = () => NOW) {
  return new GitHubVaultBackend({
    appId: "123",
    installationId: "7",
    repository: "owner/vault",
    privateKey,
    fetch: github.fetch,
    now,
  });
}

describe("GitHubVaultBackend", () => {
  it("authenticates once as the App, then with a cached installation token narrowed to the vault", async () => {
    const github = fakeGitHub({});
    const vault = backend(github);
    expect(await vault.defaultBranch()).toBe("main");
    expect(await vault.branchHead("main")).toBe(HEAD);
    expect(await vault.branchHead("gone")).toBeNull();
    expect(github.tokens()).toBe(1);
    const [tokenCall, ...rest] = github.calls;
    expect(tokenCall?.body).toEqual({ repositories: ["vault"] });
    const jwt = tokenCall?.authorization?.replace("Bearer ", "") ?? "";
    expect(JSON.parse(decodeBase64Text(jwt.split(".")[1] ?? ""))).toMatchObject({ iss: "123" });
    for (const call of rest) expect(call.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("renews the token five minutes before it expires", async () => {
    const github = fakeGitHub({});
    let now = NOW;
    const vault = backend(github, () => now);
    await vault.defaultBranch();
    now = NOW + 54 * 60_000;
    await vault.defaultBranch();
    expect(github.tokens()).toBe(1);
    now = NOW + 56 * 60_000;
    await vault.defaultBranch();
    expect(github.tokens()).toBe(2);
  });

  it("snapshots the vault's Markdown, skipping hidden folders, attachments and huge files", async () => {
    const files = {
      "memory/notes/a.md": "# A",
      "agents/kelpie/SOUL.md": "# Soul",
      "long.md": "x".repeat(10),
    };
    const vault = backend(fakeGitHub(files));
    const snapshot = await vault.snapshot(HEAD);
    expect(snapshot.files).toEqual([
      { path: "memory/notes/a.md", content: "# A", blobSha: "sha-memory/notes/a.md" },
      { path: "agents/kelpie/SOUL.md", content: "# Soul", blobSha: "sha-agents/kelpie/SOUL.md" },
      // GraphQL truncated it, so it came from the blob API.
      { path: "long.md", content: "x".repeat(10), blobSha: "sha-long.md" },
    ]);
  });

  it("diffs two commits: changes with their content, removals and renames", async () => {
    const vault = backend(fakeGitHub({ "memory/notes/a.md": "# A2", "memory/notes/b.md": "# B" }));
    expect(await vault.diff(BASE, HEAD)).toEqual({
      from: BASE,
      to: HEAD,
      changes: [
        { path: "knowledge/old.md", content: null },
        { path: "memory/notes/a.md", content: "# A2", blobSha: "sha-memory/notes/a.md" },
        { path: "memory/notes/b-old.md", content: null },
        { path: "memory/notes/b.md", content: "# B", blobSha: "sha-memory/notes/b.md" },
      ],
    });
    // A force-push: the caller takes a snapshot.
    expect(await vault.diff(HEAD, BASE)).toBeNull();
  });

  it("commits writes and deletions on the expected head, with the body for trailers", async () => {
    const github = fakeGitHub({});
    const outcome = await backend(github).commit({
      branch: "main",
      expectedHead: HEAD,
      headline: "Remember Ana's new city",
      body: "Kelpie-Agent: kelpie",
      writes: [{ path: "memory/people/ana.md", content: "Ação" }],
      deletions: ["memory/old.md"],
    });
    expect(outcome).toEqual({ kind: "committed", commit: "c".repeat(40) });
    const last = github.calls.at(-1);
    if (!last) throw new Error("no request was made");
    const input = (last.body as { variables: { input: Record<string, unknown> } }).variables.input;
    expect(input).toEqual({
      branch: { repositoryNameWithOwner: "owner/vault", branchName: "main" },
      message: { headline: "Remember Ana's new city", body: "Kelpie-Agent: kelpie" },
      expectedHeadOid: HEAD,
      fileChanges: {
        additions: [
          { path: "memory/people/ana.md", contents: base64(new TextEncoder().encode("Ação")) },
        ],
        deletions: [{ path: "memory/old.md" }],
      },
    });
  });

  it("reports a stale head as such, not as an error", async () => {
    const outcome = await backend(fakeGitHub({}, { stale: true })).commit({
      branch: "main",
      expectedHead: BASE,
      headline: "x",
      writes: [],
      deletions: [],
    });
    expect(outcome).toEqual({ kind: "stale" });
  });

  it("opens a pull request from a new branch", async () => {
    const github = fakeGitHub({});
    const vault = backend(github);
    await vault.createBranch("kelpie/skill-x", HEAD);
    expect(
      await vault.openPullRequest({
        branch: "kelpie/skill-x",
        base: "main",
        title: "t",
        body: "b",
      }),
    ).toEqual({ number: 12, url: "https://github.com/owner/vault/pull/12" });
    expect(github.calls.at(-2)?.body).toEqual({ ref: "refs/heads/kelpie/skill-x", sha: HEAD });
    expect(github.calls.at(-1)?.body).toEqual({
      title: "t",
      body: "b",
      head: "kelpie/skill-x",
      base: "main",
    });
  });

  it("names the failed call without the token", async () => {
    const failing = (async () => new Response("<html>", { status: 502 })) as typeof fetch;
    const vault = new GitHubVaultBackend({
      appId: "123",
      installationId: "7",
      repository: "owner/vault",
      privateKey,
      fetch: failing,
    });
    const error = await vault.defaultBranch().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as Error).message).toBe("GitHub installation token answered 502");
    expect(
      () =>
        new GitHubVaultBackend({
          appId: "1",
          installationId: "1",
          repository: "vault",
          privateKey,
          fetch: failing,
        }),
    ).toThrow("owner/name");
  });

  it("hashes text like git", async () => {
    expect(await gitBlobSha("# Plain\n")).toBe("adf3919bcec218dd4aabbca517159195c3d04d3f");
  });
});
