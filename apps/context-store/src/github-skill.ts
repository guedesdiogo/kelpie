// A skill fetched from a public GitHub repository (ADR-0058 §5). The address names a repository and,
// maybe, a branch, a tag or a commit and a folder; nothing else of it is ever fetched. A branch or
// tag resolves to its commit through git's own ref listing on github.com, which needs no token and
// isn't the REST API's 60 calls an hour, and the files come from the repository's archive at that
// commit on codeload.github.com. No redirect is followed, and no answer is read past its limit.

/** The ref listing of a repository with many branches and tags fits; past this it isn't read. */
export const MAX_REFS_BYTES = 8_000_000;
/** A repository's archive at one commit, compressed. */
export const MAX_ARCHIVE_BYTES = 20_000_000;
const FETCH_TIMEOUT_MS = 20_000;

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
/** A ref's name as git allows it, kept to what an address can carry. */
const REF_SEGMENT = /^[A-Za-z0-9._+-]{1,100}$/;

/** What an address names, before anything is fetched. */
export interface GitHubAddress {
  owner: string;
  repo: string;
  /** The ref and folder segments after `tree/` or `blob/`, still to tell apart; empty for HEAD. */
  rest: string[];
}

/** Where a skill came from, as the vault's commit and the Vault object record it. */
export interface GitHubSource {
  kind: "github";
  owner: string;
  repo: string;
  /** The branch or tag it was asked at, the commit an address named, or null for the default branch. */
  ref: string | null;
  /** The folder in the repository, "" for its root. */
  path: string;
  commit: string;
}

export type FetchProblem = "invalid_address" | "not_found" | "too_large" | "unreachable";

export class GitHubFetchError extends Error {
  constructor(readonly reason: FetchProblem) {
    super(reason);
    this.name = "GitHubFetchError";
  }
}

/**
 * A GitHub address: `github.com/<owner>/<repo>`, maybe followed by `/tree/<ref>/<folder>` or
 * `/blob/<ref>/<folder>/SKILL.md`, with or without `https://`. Null for anything else.
 */
export function parseGitHubAddress(input: string): GitHubAddress | null {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > 1_000) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    (url.hostname !== "github.com" && url.hostname !== "www.github.com") ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return null;
  }
  let segments: string[];
  try {
    segments = url.pathname
      .split("/")
      .filter((segment) => segment !== "")
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
  const [owner, repoSegment, kind, ...rest] = segments;
  const repo = repoSegment?.replace(/\.git$/, "");
  if (!owner || !repo || !OWNER.test(owner) || !REPO.test(repo) || repo === "." || repo === "..") {
    return null;
  }
  if (kind === undefined) return { owner, repo, rest: [] };
  if ((kind !== "tree" && kind !== "blob") || rest.length === 0) return null;
  if (!rest.every((segment) => REF_SEGMENT.test(segment) && segment !== "." && segment !== "..")) {
    return null;
  }
  // A link to the skill's own file names its folder.
  if (kind === "blob") {
    if (rest.at(-1) !== "SKILL.md" || rest.length < 2) return null;
    return { owner, repo, rest: rest.slice(0, -1) };
  }
  return { owner, repo, rest };
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The address's commit and folder: a full commit SHA stands as it is; otherwise the longest leading
 * segments that name a branch or tag, from git's ref listing, and the rest is the folder.
 */
export async function resolveAddress(
  address: GitHubAddress,
  fetcher: Fetch,
): Promise<Omit<GitHubSource, "kind"> & { kind: "github" }> {
  const { owner, repo, rest } = address;
  const first = rest[0];
  if (first !== undefined && SHA.test(first)) {
    return {
      kind: "github",
      owner,
      repo,
      ref: first,
      path: rest.slice(1).join("/"),
      commit: first,
    };
  }
  const refs = await listRefs(owner, repo, fetcher);
  if (rest.length === 0) {
    const head = refs.get("HEAD");
    if (!head) throw new GitHubFetchError("not_found");
    return { kind: "github", owner, repo, ref: null, path: "", commit: head };
  }
  for (let take = rest.length; take > 0; take -= 1) {
    const name = rest.slice(0, take).join("/");
    const commit = refs.get(`refs/heads/${name}`) ?? refs.get(`refs/tags/${name}`);
    if (commit) {
      return { kind: "github", owner, repo, ref: name, path: rest.slice(take).join("/"), commit };
    }
  }
  throw new GitHubFetchError("not_found");
}

/**
 * A source's branch or tag again, for "Look for an update": the commit it names now. A commit the
 * address named stays that commit.
 */
export async function resolveRef(
  source: Pick<GitHubSource, "owner" | "repo" | "ref">,
  fetcher: Fetch,
): Promise<string> {
  if (source.ref !== null && SHA.test(source.ref)) return source.ref;
  const refs = await listRefs(source.owner, source.repo, fetcher);
  const commit =
    source.ref === null
      ? refs.get("HEAD")
      : (refs.get(`refs/heads/${source.ref}`) ?? refs.get(`refs/tags/${source.ref}`));
  if (!commit) throw new GitHubFetchError("not_found");
  return commit;
}

/** The repository's archive at a commit, as bytes. */
export async function fetchArchive(
  source: Pick<GitHubSource, "owner" | "repo" | "commit">,
  fetcher: Fetch,
): Promise<Uint8Array> {
  if (!SHA.test(source.commit)) throw new GitHubFetchError("invalid_address");
  const response = await get(
    fetcher,
    `https://codeload.github.com/${source.owner}/${source.repo}/zip/${source.commit}`,
  );
  return bounded(response, MAX_ARCHIVE_BYTES);
}

/**
 * The repository's refs, from git's smart HTTP listing: each name with its commit, peeled for an
 * annotated tag, and HEAD as the default branch's commit.
 */
async function listRefs(owner: string, repo: string, fetcher: Fetch): Promise<Map<string, string>> {
  const response = await get(
    fetcher,
    `https://github.com/${owner}/${repo}.git/info/refs?service=git-upload-pack`,
  );
  const body = await bounded(response, MAX_REFS_BYTES);
  return parseRefs(body);
}

/** git's pkt-lines: four hex digits of length, then the line; `0000` ends a section. */
export function parseRefs(body: Uint8Array): Map<string, string> {
  // Lengths count bytes, so the lines are cut from the bytes and only then read as text.
  const decoder = new TextDecoder();
  const refs = new Map<string, string>();
  let at = 0;
  let sections = 0;
  while (at + 4 <= body.length) {
    const digits = decoder.decode(body.subarray(at, at + 4));
    const length = /^[0-9a-f]{4}$/i.test(digits) ? Number.parseInt(digits, 16) : Number.NaN;
    if (Number.isNaN(length)) throw new GitHubFetchError("unreachable");
    if (length === 0) {
      at += 4;
      sections += 1;
      if (sections === 2) break;
      continue;
    }
    if (length < 4 || at + length > body.length) throw new GitHubFetchError("unreachable");
    const line = decoder.decode(body.subarray(at + 4, at + length)).replace(/\n$/, "");
    at += length;
    if (line.startsWith("#")) continue;
    const [ref] = line.split("\0");
    const match = /^([0-9a-f]{40}) (\S+)$/.exec(ref ?? "");
    if (!match?.[1] || !match[2]) continue;
    const [, sha, name] = match;
    // An annotated tag's peeled line names the commit it points to.
    if (name.endsWith("^{}")) refs.set(name.slice(0, -3), sha);
    else if (!refs.has(name)) refs.set(name, sha);
  }
  return refs;
}

async function get(fetcher: Fetch, url: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetcher(url, {
      redirect: "manual",
      headers: { "user-agent": "kelpie-context-store" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new GitHubFetchError("unreachable");
  }
  if (response.status === 200) return response;
  await response.body?.cancel();
  // A private or missing repository answers 401 or 404; a moved one redirects, which isn't followed.
  if ([301, 302, 307, 308, 401, 403, 404, 410].includes(response.status)) {
    throw new GitHubFetchError("not_found");
  }
  throw new GitHubFetchError("unreachable");
}

/** The body's bytes, refused once they pass `most`, whatever length the answer names. */
async function bounded(response: Response, most: number): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length") ?? 0) > most) {
    await response.body?.cancel();
    throw new GitHubFetchError("too_large");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > most) {
        await reader.cancel();
        throw new GitHubFetchError("too_large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof GitHubFetchError) throw error;
    throw new GitHubFetchError("unreachable");
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
