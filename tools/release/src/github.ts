const API = "https://api.github.com";

/** Commits per GraphQL query: each one is an aliased field of the same query. */
const BATCH = 50;

/** An issue a pull request closes; it may live in another repository. */
export interface ClosedIssue {
  /** `owner/name`. */
  repo: string;
  number: number;
  title: string;
  url: string;
  labels: string[];
}

export interface MergedPull {
  number: number;
  title: string;
  url: string;
  /** Null for a deleted account. */
  author: string | null;
  closes: ClosedIssue[];
}

export interface IssueComment {
  author: string | null;
  body: string;
  url: string;
}

export interface Release {
  id: number;
  tag: string;
  /** The commit or branch the release's tag is made from. */
  target: string;
  draft: boolean;
  prerelease: boolean;
  url: string;
}

/** A workflow run: its name, what started it, the branch or tag it ran from, and its commit. */
export interface WorkflowRun {
  title: string;
  event: string;
  branch: string | null;
  commit: string;
}

export interface ReleaseFields {
  tag: string;
  target: string;
  name: string;
  body: string;
  draft: boolean;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

/** The parts of GitHub's API that releases and their critical gate use, on one repository. */
export interface GitHub {
  /** The pull requests merged into the default branch that brought these commits, each once. */
  mergedPulls(commits: readonly string[]): Promise<MergedPull[]>;
  comments(repo: string, issue: number): Promise<IssueComment[]>;
  /** Comments on an issue, and returns the comment's URL. */
  comment(repo: string, issue: number, body: string): Promise<string>;
  /** Opens an issue in this repository, and returns its URL. */
  openIssue(issue: {
    title: string;
    body: string;
    assignees: string[];
    labels: string[];
  }): Promise<string>;
  /**
   * How the latest check run with this name ended on a commit: its conclusion, or its status
   * while it runs. Null when it never ran there.
   */
  checkState(commit: string, name: string): Promise<string | null>;
  /** Whether this repository has the label, whatever its case; false only when GitHub says 404. */
  hasLabel(name: string): Promise<boolean>;
  /** A workflow's successful runs, newest first: the most recent 100. */
  successfulRuns(workflow: string): Promise<WorkflowRun[]>;
  /** The most recent releases, drafts included for a token that can push. */
  releases(): Promise<Release[]>;
  createRelease(release: ReleaseFields): Promise<Release>;
  updateRelease(id: number, release: ReleaseFields): Promise<Release>;
}

/** `owner/name` from a GitHub remote's URL, over https or ssh. */
export function repositoryOf(remote: string): string | null {
  const match = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return match?.[1] ?? null;
}

interface RestRelease {
  id: number;
  tag_name: string;
  target_commitish: string;
  draft: boolean;
  prerelease: boolean;
  html_url: string;
}

const release = (raw: RestRelease): Release => ({
  id: raw.id,
  tag: raw.tag_name,
  target: raw.target_commitish,
  draft: raw.draft,
  prerelease: raw.prerelease,
  url: raw.html_url,
});

const releaseBody = (fields: ReleaseFields) =>
  JSON.stringify({
    tag_name: fields.tag,
    target_commitish: fields.target,
    name: fields.name,
    body: fields.body,
    draft: fields.draft,
    prerelease: false,
  });

interface Connection<T> {
  totalCount: number;
  nodes: T[];
}

interface PullNode {
  number: number;
  title: string;
  url: string;
  merged: boolean;
  baseRefName: string;
  author: { login: string } | null;
  closingIssuesReferences: Connection<{
    number: number;
    title: string;
    url: string;
    repository: { nameWithOwner: string };
    labels: Connection<{ name: string }>;
  }>;
}

// GitHub refuses a query that could return more than 500,000 nodes; 50 commits at these sizes
// stay near 116,000. A list longer than its page fails the query instead of losing a `critico`.
const PULL_FIELDS = `associatedPullRequests(first: 3) { totalCount nodes {
  number title url merged baseRefName author { login }
  closingIssuesReferences(first: 25) { totalCount nodes {
    number title url repository { nameWithOwner } labels(first: 30) { totalCount nodes { name } }
  } }
} }`;

/** The whole list, or an error: a page that misses some would miss a `critico` issue. */
function whole<T>(connection: Connection<T>, what: string): T[] {
  if (connection.totalCount > connection.nodes.length) {
    throw new Error(
      `${what} has ${connection.totalCount}, more than the ${connection.nodes.length} one query reads.`,
    );
  }
  return connection.nodes;
}

export function githubApi(token: string, repo: string, fetchImpl: typeof fetch = fetch): GitHub {
  const [owner, name] = repo.split("/");

  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetchImpl(`${API}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "kelpie-release",
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await response.json().catch(() => null)) as {
      message?: string;
      errors?: Array<{ message: string }>;
    } | null;
    const detail = body?.errors?.map((error) => error.message).join("; ") || body?.message;
    if (!response.ok || (path === "/graphql" && body?.errors?.length)) {
      throw new GitHubError(
        `GitHub API ${init.method ?? "GET"} ${path.split("?")[0]} failed (${response.status})${detail ? `: ${detail}` : ""}`,
        response.status,
      );
    }
    return body as T;
  }

  async function pullsOf(commits: readonly string[]): Promise<PullNode[]> {
    const fields = commits
      .map((commit, index) => {
        if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`"${commit}" isn't a full commit id.`);
        return `c${index}: object(oid: "${commit}") { ... on Commit { ${PULL_FIELDS} } }`;
      })
      .join("\n");
    const query = `query ($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {
  defaultBranchRef { name }
  ${fields}
} }`;
    const { data } = await call<{
      data: {
        repository:
          | ({ defaultBranchRef: { name: string } } & Record<
              string,
              { associatedPullRequests: Connection<PullNode> } | null
            >)
          | null;
      } | null;
    }>("/graphql", { method: "POST", body: JSON.stringify({ query, variables: { owner, name } }) });
    const repository = data?.repository;
    if (!repository) throw new Error(`GitHub doesn't show ${repo}.`);
    const base = repository.defaultBranchRef.name;
    return commits.flatMap((commit, index) => {
      // A commit GitHub doesn't know can't say which pull requests it brought.
      const found = repository[`c${index}`];
      if (!found) throw new Error(`GitHub doesn't know the commit ${commit} in ${repo}.`);
      return whole(found.associatedPullRequests, `${commit}'s pull requests`).filter(
        (pull) => pull.merged && pull.baseRefName === base,
      );
    });
  }

  return {
    async mergedPulls(commits) {
      const pulls = new Map<number, MergedPull>();
      for (let start = 0; start < commits.length; start += BATCH) {
        for (const pull of await pullsOf(commits.slice(start, start + BATCH))) {
          pulls.set(pull.number, {
            number: pull.number,
            title: pull.title,
            url: pull.url,
            author: pull.author?.login ?? null,
            closes: whole(pull.closingIssuesReferences, `#${pull.number}'s closing issues`).map(
              (issue) => ({
                repo: issue.repository.nameWithOwner,
                number: issue.number,
                title: issue.title,
                url: issue.url,
                labels: whole(issue.labels, `${issue.url}'s labels`).map((label) => label.name),
              }),
            ),
          });
        }
      }
      return [...pulls.values()].sort((a, b) => a.number - b.number);
    },

    async comments(where, issue) {
      type Raw = { user: { login: string } | null; body: string | null; html_url: string };
      const comments: IssueComment[] = [];
      for (let page = 1; ; page++) {
        const batch = await call<Raw[]>(
          `/repos/${where}/issues/${issue}/comments?per_page=100&page=${page}`,
        );
        comments.push(
          ...batch.map((raw) => ({
            author: raw.user?.login ?? null,
            body: raw.body ?? "",
            url: raw.html_url,
          })),
        );
        if (batch.length < 100) return comments;
      }
    },

    async comment(where, issue, body) {
      const made = await call<{ html_url: string }>(`/repos/${where}/issues/${issue}/comments`, {
        method: "POST",
        body: JSON.stringify({ body }),
      });
      return made.html_url;
    },

    async openIssue(issue) {
      const made = await call<{ html_url: string }>(`/repos/${repo}/issues`, {
        method: "POST",
        body: JSON.stringify(issue),
      });
      return made.html_url;
    },

    async checkState(commit, check) {
      const { check_runs } = await call<{
        check_runs: Array<{ status: string; conclusion: string | null }>;
      }>(
        `/repos/${repo}/commits/${commit}/check-runs?check_name=${encodeURIComponent(check)}&filter=latest`,
      );
      const [latest] = check_runs;
      return latest ? (latest.conclusion ?? latest.status) : null;
    },

    async hasLabel(label) {
      try {
        await call(`/repos/${repo}/labels/${encodeURIComponent(label)}`);
        return true;
      } catch (error) {
        if (error instanceof GitHubError && error.status === 404) return false;
        throw error;
      }
    },

    async successfulRuns(workflow) {
      const { workflow_runs } = await call<{
        workflow_runs: Array<{
          display_title: string;
          event: string;
          head_branch: string | null;
          head_sha: string;
        }>;
      }>(`/repos/${repo}/actions/workflows/${workflow}/runs?status=success&per_page=100`);
      return workflow_runs.map((run) => ({
        title: run.display_title,
        event: run.event,
        branch: run.head_branch,
        commit: run.head_sha,
      }));
    },

    async releases() {
      return (await call<RestRelease[]>(`/repos/${repo}/releases?per_page=100`)).map(release);
    },

    async createRelease(fields) {
      return release(
        await call<RestRelease>(`/repos/${repo}/releases`, {
          method: "POST",
          body: releaseBody(fields),
        }),
      );
    },

    async updateRelease(id, fields) {
      return release(
        await call<RestRelease>(`/repos/${repo}/releases/${id}`, {
          method: "PATCH",
          body: releaseBody(fields),
        }),
      );
    },
  };
}
