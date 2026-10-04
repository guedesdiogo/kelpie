import {
  type CommitSpec,
  CREATE_COMMIT_MUTATION,
  createCommitInput,
  DEFAULT_BRANCH_QUERY,
  type GraphqlResult,
  graphql,
  HEAD_QUERY,
  installationTokenRequest,
  readFilesQuery,
  readJson,
} from "./github.ts";
import { importPrivateKey, signAppJwt } from "./jwt.ts";

export interface ExperimentConfig {
  appId: string;
  installationId: string;
  /** `owner/name`. */
  repository: string;
  privateKeyPem: string;
}

/**
 * One step of the run. Only statuses, GitHub's error types and messages, OIDs and timings go in
 * here: never the JWT, the installation token or key material.
 */
export type Step = { name: string; ok: boolean; ms: number } & Record<string, unknown>;

export interface Report {
  /** True when every step ran; the stale-head step may still report an unexpected outcome. */
  completed: boolean;
  repository: string;
  runFolder: string;
  steps: Step[];
}

interface TokenResponse {
  token?: string;
  expires_at?: string;
  permissions?: Record<string, string>;
  repositories?: { full_name: string }[];
  message?: string;
}

type CommitData = {
  createCommitOnBranch: {
    commit: { oid: string; url: string; signature: { isValid: boolean; state: string } | null };
  } | null;
};
type HeadData = { repository: { ref: { target: { oid: string } } | null } | null };
type BranchData = { repository: { defaultBranchRef: { name: string } | null } | null };
type FilesData = { repository: Record<string, { text: string } | null> | null };

/** Thrown after a failed step is recorded, to end the run. */
class Stop extends Error {}

/**
 * The spike: App JWT → installation token → one commit with several files → a commit with a stale
 * `expectedHeadOid` → a commit that updates and deletes in one mutation → read the files back.
 */
export async function runExperiment(config: ExperimentConfig, now = new Date()): Promise<Report> {
  const [owner = "", name = ""] = config.repository.split("/");
  const runFolder = `spike-runs/${now.toISOString().replaceAll(":", "-")}`;
  const report: Report = { completed: false, repository: config.repository, runFolder, steps: [] };

  let current = "";
  let started = 0;
  function begin(step: string): void {
    current = step;
    started = performance.now();
  }
  /** Records the current step; a step that isn't ok ends the run. */
  function end(ok: unknown, details: Record<string, unknown> = {}): asserts ok {
    report.steps.push({ name: current, ok: Boolean(ok), ms: elapsed(started), ...details });
    if (!ok) throw new Stop();
  }

  const files = {
    a: {
      path: `${runFolder}/a.md`,
      contents: `# ${runFolder}\n\nWritten in one commit with b.md and nested/c.md. Olá, ✓.\n`,
    },
    b: { path: `${runFolder}/b.md`, contents: "Deleted by the second commit.\n" },
    c: {
      path: `${runFolder}/nested/c.md`,
      contents: "A nested path: the commit creates the tree.\n",
    },
  };
  const updatedA = `${files.a.contents}\nUpdated in the commit that deleted b.md.\n`;

  try {
    begin("sign-app-jwt");
    const jwt = await signAppJwt(await importPrivateKey(config.privateKeyPem), config.appId);
    end(true);

    begin("installation-token");
    const tokenResponse = await fetch(installationTokenRequest(jwt, config.installationId, name));
    const tokenBody = await readJson<TokenResponse>(tokenResponse);
    const token = tokenResponse.status === 201 ? tokenBody?.token : undefined;
    end(token, {
      status: tokenResponse.status,
      ...(token
        ? {
            expiresAt: tokenBody?.expires_at,
            permissions: tokenBody?.permissions,
            repositories: tokenBody?.repositories?.map((repository) => repository.full_name),
          }
        : { error: tokenBody?.message ?? "no JSON body" }),
    });

    const commit = (spec: Omit<CommitSpec, "repository">) =>
      graphql<CommitData>(token, CREATE_COMMIT_MUTATION, {
        input: createCommitInput({ repository: config.repository, ...spec }),
      });
    const readHead = async (branch: string) => {
      const result = await graphql<HeadData>(token, HEAD_QUERY, {
        owner,
        name,
        ref: `refs/heads/${branch}`,
      });
      return { result, oid: result.data?.repository?.ref?.target.oid };
    };

    begin("default-branch");
    const branchResult = await graphql<BranchData>(token, DEFAULT_BRANCH_QUERY, { owner, name });
    const branch = branchResult.data?.repository?.defaultBranchRef?.name;
    end(branch, { ...outcome(branchResult), branch });

    begin("read-head");
    const before = await readHead(branch);
    end(before.oid, { ...outcome(before.result), oid: before.oid });

    begin("commit-three-files");
    const first = await commit({
      branch,
      expectedHeadOid: before.oid,
      headline: `spike: add a.md, b.md and nested/c.md under ${runFolder}`,
      additions: [files.a, files.b, files.c],
    });
    const firstCommit = first.data?.createCommitOnBranch?.commit;
    end(firstCommit, {
      ...outcome(first),
      expectedHeadOid: before.oid,
      oid: firstCommit?.oid,
      url: firstCommit?.url,
      signature: firstCommit?.signature,
    });

    // The head has moved to firstCommit, so `before.oid` is now stale.
    begin("stale-expected-head-oid");
    const stale = await commit({
      branch,
      expectedHeadOid: before.oid,
      headline: `spike: this commit must be rejected (${runFolder})`,
      additions: [{ path: `${runFolder}/stale.md`, contents: "Must not exist.\n" }],
    });
    const staleMs = elapsed(started);
    const staleCommit = stale.data?.createCommitOnBranch?.commit;
    const afterStale = await readHead(branch);
    // Not `end`: an accepted stale commit is a finding to report, and the run goes on.
    report.steps.push({
      name: current,
      ok: !staleCommit && afterStale.oid === firstCommit.oid,
      ms: elapsed(started),
      mutationMs: staleMs,
      ...outcome(stale),
      rejected: !staleCommit,
      ...(staleCommit ? { unexpectedCommitOid: staleCommit.oid } : {}),
      expectedHeadOid: before.oid,
      headOidAfter: afterStale.oid,
      headUnchanged: afterStale.oid === firstCommit.oid,
    });

    begin("commit-update-and-delete");
    if (!afterStale.oid) end(false, { ...outcome(afterStale.result), error: "head not readable" });
    const second = await commit({
      branch,
      expectedHeadOid: afterStale.oid,
      headline: `spike: update a.md and delete b.md under ${runFolder}`,
      additions: [{ path: files.a.path, contents: updatedA }],
      deletions: [files.b.path],
    });
    const secondCommit = second.data?.createCommitOnBranch?.commit;
    end(secondCommit, {
      ...outcome(second),
      expectedHeadOid: afterStale.oid,
      oid: secondCommit?.oid,
      url: secondCommit?.url,
      signature: secondCommit?.signature,
    });

    begin("read-back");
    const paths = [files.a.path, files.b.path, files.c.path];
    const read = await graphql<FilesData>(token, readFilesQuery(paths.length), {
      owner,
      name,
      ...Object.fromEntries(paths.map((path, i) => [`e${i}`, `${secondCommit.oid}:${path}`])),
    });
    const blobs = read.data?.repository;
    const checks = {
      aUpdated: blobs?.f0?.text === updatedA,
      bDeleted: !!blobs && blobs.f1 === null,
      cUnchanged: blobs?.f2?.text === files.c.contents,
    };
    end(Object.values(checks).every(Boolean), { ...outcome(read), ...checks });

    report.completed = true;
  } catch (error) {
    if (!(error instanceof Stop)) {
      report.steps.push({
        name: current,
        ok: false,
        ms: elapsed(started),
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
    }
  }
  return report;
}

/** What a GraphQL call reported: its HTTP status and, when present, GitHub's errors verbatim. */
function outcome(result: GraphqlResult<unknown>): Record<string, unknown> {
  return { status: result.status, ...(result.errors.length > 0 ? { errors: result.errors } : {}) };
}

/** Workers advance the clock only on I/O, so a CPU-only step reads as 0 ms. */
function elapsed(since: number): number {
  return Math.round(performance.now() - since);
}
