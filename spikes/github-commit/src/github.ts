import { base64 } from "./encoding.ts";

const API = "https://api.github.com";

/** Sent on every call. GitHub rejects requests without a User-Agent, and Workers' fetch sets none. */
export const GITHUB_HEADERS = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "kelpie-spike-github-commit",
} as const;

/** Exchanges the App JWT for an installation token, narrowed to one repository of the installation. */
export function installationTokenRequest(
  jwt: string,
  installationId: string,
  repositoryName: string,
): Request {
  return new Request(`${API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      ...GITHUB_HEADERS,
      authorization: `Bearer ${jwt}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ repositories: [repositoryName] }),
  });
}

export function graphqlRequest(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Request {
  return new Request(`${API}/graphql`, {
    method: "POST",
    headers: {
      ...GITHUB_HEADERS,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
}

export interface GraphqlError {
  type?: string;
  message: string;
  path?: (string | number)[];
}

/** GraphQL reports most failures as HTTP 200 with `errors`, so callers decide what failure means. */
export interface GraphqlResult<T> {
  status: number;
  data: T | null;
  errors: GraphqlError[];
}

export async function graphql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<GraphqlResult<T>> {
  const response = await fetch(graphqlRequest(token, query, variables));
  const body = await readJson<{ data?: T | null; errors?: GraphqlError[]; message?: string }>(
    response,
  );
  const errors = (body?.errors ?? []).map(({ type, message, path }) => ({
    ...(type === undefined ? {} : { type }),
    message,
    ...(path === undefined ? {} : { path }),
  }));
  if (!response.ok && errors.length === 0) {
    errors.push({ message: body?.message ?? `HTTP ${response.status} without a JSON body` });
  }
  return { status: response.status, data: body?.data ?? null, errors };
}

/** Parses a JSON body, or returns null when GitHub answered with something else (an HTML 5xx). */
export async function readJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export const DEFAULT_BRANCH_QUERY = `query ($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { defaultBranchRef { name } }
}`;

export const HEAD_QUERY = `query ($owner: String!, $name: String!, $ref: String!) {
  repository(owner: $owner, name: $name) { ref(qualifiedName: $ref) { target { oid } } }
}`;

export const CREATE_COMMIT_MUTATION = `mutation ($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) { commit { oid url signature { isValid state } } }
}`;

/** Reads several blobs in one query: `f0`, `f1`… are null when the path doesn't exist. */
export function readFilesQuery(count: number): string {
  const variables = Array.from({ length: count }, (_, i) => `$e${i}: String!`).join(", ");
  const fields = Array.from(
    { length: count },
    (_, i) => `f${i}: object(expression: $e${i}) { ... on Blob { text } }`,
  ).join("\n    ");
  return `query ($owner: String!, $name: String!, ${variables}) {
  repository(owner: $owner, name: $name) {
    ${fields}
  }
}`;
}

export interface CommitSpec {
  /** `owner/name`. */
  repository: string;
  branch: string;
  expectedHeadOid: string;
  headline: string;
  /** File contents as text; they are sent as base64 of their UTF-8 bytes. */
  additions?: { path: string; contents: string }[];
  deletions?: string[];
}

/** The `createCommitOnBranch` input: one commit, any number of additions and deletions. */
export function createCommitInput(spec: CommitSpec) {
  const additions = (spec.additions ?? []).map(({ path, contents }) => ({
    path,
    contents: base64(new TextEncoder().encode(contents)),
  }));
  const deletions = (spec.deletions ?? []).map((path) => ({ path }));
  return {
    branch: { repositoryNameWithOwner: spec.repository, branchName: spec.branch },
    message: { headline: spec.headline },
    expectedHeadOid: spec.expectedHeadOid,
    fileChanges: {
      ...(additions.length > 0 ? { additions } : {}),
      ...(deletions.length > 0 ? { deletions } : {}),
    },
  };
}
