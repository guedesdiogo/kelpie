# Spike: can a Worker commit to GitHub through a GitHub App?

- **Date:** 2026-10-03 (code), 2026-10-04 (run)
- **Issue:** [#28](https://github.com/guedesdiogo/kelpie/issues/28)
- **Status:** answered: all five questions, yes
- **Source:** [`spikes/github-commit/` at `c412388`](https://github.com/guedesdiogo/kelpie/tree/c412388/spikes/github-commit), on branch `spike/github-commit-from-worker`. Like the previous spike's Worker, it isn't merged: [ADR-0010](../adr/0010-monorepo-tooling.md) keeps workspaces to `apps/*` and `packages/*`.

## Question

[ADR-0005](../adr/0005-context-store.md) has the Context Store write agent context to a private GitHub repository with GraphQL `createCommitOnBranch`, from a Worker, authenticated as a GitHub App. Research note 08 recommends the mutation, but nobody has run it from a Worker yet. The spike answers five questions:

1. Can a Worker sign the App's JWT (RS256) with WebCrypto alone, with no Node `crypto` and no JWT library?
2. Can it exchange that JWT for an installation access token?
3. Does one `createCommitOnBranch` mutation commit several files, guarded by `expectedHeadOid`?
4. What exactly does GitHub return when `expectedHeadOid` is stale? This is the conflict signal the Context Store will act on.
5. Can the same mutation delete a file alongside an addition? The Context Store has to handle removals.

## Setup

- **GitHub App:** App ID `5181584`, on the owner's account. It is installed on the private repository `guedesdiogo/kelpie-context-test` (installation `167691807`) and needs the **Contents: read and write** repository permission.
- **Worker:** `spikes/github-commit/` on the spike branch, where `spikes/*` is a workspace, run locally with `wrangler dev`. Local workerd reaches `api.github.com` directly, so nothing has to be deployed.
  - `src/jwt.ts` imports the key and signs the JWT.
  - `src/github.ts` builds the REST and GraphQL requests.
  - `src/experiment.ts` runs the steps.
  - `src/index.ts` has the route and the token check.
- **Configuration:** the App ID, installation ID and repository are plain `vars` in `wrangler.jsonc`. The two secrets, `GITHUB_APP_PRIVATE_KEY` and `SPIKE_TOKEN`, are declared in `secrets.required`. Wrangler uses that declaration to generate their types, and `wrangler dev` warns when they are missing.
- **Key format:** GitHub issues the private key as PKCS#1 (`BEGIN RSA PRIVATE KEY`), and WebCrypto only imports PKCS#8.
  - The owner converts the key once with `openssl pkcs8 -topk8 -nocrypt`. The alternative, wrapping PKCS#1 in a PKCS#8 envelope in code, means hand-written ASN.1 for a step that happens once.
  - If it gets a PKCS#1 key, the Worker refuses it with a message that names the command.
- **Access:** the route is `POST /run`, and it requires an `x-spike-token` header equal to `SPIKE_TOKEN`.
  - The check compares SHA-256 digests with `crypto.subtle.timingSafeEqual`, so it runs in constant time.
  - An empty or missing value never matches.
  - Every other path answers 404.

## Method

`POST /run` performs these steps in order and returns a JSON report with one entry per step. A failed step ends the run and answers 502. A run where every step executed answers 200.

| Step | What it does | `ok` when |
|---|---|---|
| `sign-app-jwt` | Imports the key and signs `{ iat: now − 60 s, exp: iat + 600 s, iss: "5181584" }` with RS256 | Signing works |
| `installation-token` | `POST /app/installations/167691807/access_tokens` with the JWT. The token is narrowed to the test repository | HTTP 201 |
| `default-branch` | GraphQL `repository.defaultBranchRef.name`, instead of assuming `main` | A branch name |
| `read-head` | GraphQL `repository.ref(qualifiedName: "refs/heads/<branch>").target.oid` | An OID |
| `commit-three-files` | `createCommitOnBranch` adding `a.md`, `b.md` and `nested/c.md` under the run folder, with `expectedHeadOid` = that OID | A commit OID |
| `stale-expected-head-oid` | `createCommitOnBranch` again with the same OID, which the previous commit made stale, then re-reads the head | GitHub rejected it and the branch did not move |
| `commit-update-and-delete` | `createCommitOnBranch` with the re-read head: rewrites `a.md` and deletes `b.md` in one mutation | A commit OID |
| `read-back` | Reads the three paths at the new commit | `a.md` updated, `b.md` gone, `nested/c.md` intact |

- **Run folder:** each run writes under its own folder, `spike-runs/<ISO timestamp, with - instead of :>/`, so runs don't collide. If GitHub accepted the stale commit, it would add `stale.md` there.
- **Recorded:**
  - Each step records `ms`.
  - The stale step also records `mutationMs`, the time of the mutation alone.
  - Commits record `signature`. Research note 08 says commits made with this mutation are signed and verified automatically.
  - Workers advance the clock only on I/O, so `sign-app-jwt` reads close to 0 ms.
- **What goes in the report:** HTTP statuses, GitHub's error `type`, `message` and `path` verbatim, OIDs, commit URLs, the token's expiry and permissions, and timings.
  - The key, the JWT and the installation token never appear in the report. A unit test checks this.
  - The Worker writes no logs.
- **Offline tests:** `bun run --filter @kelpie/spike-github-commit test` on the spike branch (20 tests) needs no network and no key. It covers:
  - signing and verifying a JWT with a key pair generated in the test, and the claims;
  - refusing a PKCS#1 key;
  - standard base64 for file contents versus base64url for JWT segments;
  - the request bodies and headers;
  - the token check;
  - a whole run against an in-memory fake of GitHub, whose stale-head error is made up.

## Running it

It runs on the owner's machine, from a checkout of the spike branch (for example `git worktree add ../kelpie-spike-28 spike/github-commit-from-worker`, then `bun install`). It needs Bun, Node 22 or later, and the private key file downloaded from the App's settings page. `jq` is optional.

**1. Write `.dev.vars` without printing the key.** Run this from `spikes/github-commit/`, with `KEY_PEM` set to the file GitHub gave you:

```bash
KEY_PEM=~/Downloads/<app-name>.<date>.private-key.pem
SPIKE_TOKEN="$(openssl rand -hex 32)"
(
  umask 077
  {
    printf 'GITHUB_APP_PRIVATE_KEY="%s"\n' "$(openssl pkcs8 -topk8 -nocrypt -in "$KEY_PEM" | awk '{printf "%s\\n", $0}')"
    printf 'SPIKE_TOKEN="%s"\n' "$SPIKE_TOKEN"
  } > .dev.vars
)
```

What the block does:
- `openssl pkcs8 -topk8 -nocrypt` converts PKCS#1 to PKCS#8.
- `awk` writes each line break as the two characters `\n`, inside a double-quoted value. Wrangler's `.dev.vars` parser (dotenv) turns `\n` back into line breaks in double-quoted values. The Worker also accepts literal `\n`, so an unquoted value works too.
- The file is created with mode 600.
- The block prints nothing, and the converted key never touches the disk outside `.dev.vars`.
- `.dev.vars*` is already in `.gitignore`.

Don't `cat` the file. To check it without printing it, run the commands below. The first should print `1`. When `wrangler dev` starts, it should list both secrets as `(hidden)`.

```bash
grep -c '^GITHUB_APP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\n' .dev.vars
ls -l .dev.vars   # -rw-------
```

**2. Start the Worker.** In terminal A, from `spikes/github-commit/`:

```bash
bunx wrangler dev
```

If it warns `Missing required secrets`, it didn't find `.dev.vars` in that folder.

**3. Trigger the run.** In terminal B, from `spikes/github-commit/`:

```bash
SPIKE_TOKEN="$(sed -n 's/^SPIKE_TOKEN="\(.*\)"$/\1/p' .dev.vars)"
curl -sS -X POST -H "x-spike-token: $SPIKE_TOKEN" http://localhost:8787/run | jq .
```

The `sed` reads only the `SPIKE_TOKEN` line. Drop `| jq .` if jq isn't installed. Run it once: every run makes two commits in the test repository (three if GitHub accepted the stale commit). Paste the JSON into Results below.

**4. Clean up.** Run `rm .dev.vars`. The `spike-runs/` folders stay in the test repository, which the owner may delete together with the App.

**Optional: running it deployed.** Nothing requires this. Wrangler names this command itself for creating a Worker with required secrets; it was not run here.

```bash
bunx wrangler deploy --secrets-file .dev.vars
curl -sS -X POST -H "x-spike-token: $SPIKE_TOKEN" https://kelpie-spike-github-commit.<subdomain>.workers.dev/run | jq .
bunx wrangler delete
```

## Results

One run on 2026-10-04 at 03:38 UTC. The owner wrote `.dev.vars` and started `wrangler dev`; the request came from the same machine. Every step passed (`completed: true`), in run folder `spike-runs/2026-10-04T03-38-41.103Z`.

| Step | Result | Time |
|---|---|---|
| `sign-app-jwt` | Signed with WebCrypto, from the PKCS#8 key | 10 ms |
| `installation-token` | HTTP 201. Permissions `contents: write` and `metadata: read`, narrowed to `guedesdiogo/kelpie-context-test`. Expires one hour later (`2026-10-04T04:38:41Z`) | 474 ms |
| `default-branch` | `main` | 357 ms |
| `read-head` | `d26ffa1` | 4,697 ms |
| `commit-three-files` | Commit [`8685b9d`](https://github.com/guedesdiogo/kelpie-context-test/commit/8685b9d159ca59425fd84057fc9e539f43678f6d), signature `VALID` | 2,563 ms |
| `stale-expected-head-oid` | Rejected, and the branch stayed at `8685b9d` (`headUnchanged: true`) | 2,130 ms (mutation 1,744 ms) |
| `commit-update-and-delete` | Commit [`211179e`](https://github.com/guedesdiogo/kelpie-context-test/commit/211179e4ddc213355cc6e12c0e025b3f7483fd19), signature `VALID` | 1,842 ms |
| `read-back` | `a.md` updated, `b.md` deleted, `nested/c.md` unchanged | 1,249 ms |

**The conflict signal.** A stale `expectedHeadOid` answers HTTP 200, with a GraphQL error instead of data:

```json
{
  "type": "STALE_DATA",
  "message": "Expected branch to point to \"d26ffa1cd5788bf67972a4be0db928d384472362\" but it did not.  Pull and try again.",
  "path": ["createCommitOnBranch"]
}
```

The answers to the five questions:
1. WebCrypto alone signs the App's JWT.
2. The installation token comes back narrowed to one repository.
3. One mutation commits three files, guarded by `expectedHeadOid`.
4. A stale head is refused with `STALE_DATA`, and the branch doesn't move.
5. An update and a deletion go through in the same mutation.

## Consequences

- **ADR-0005's write path works from a Worker,** with no Node APIs and no libraries. Story 3.8 (#41) can start from the spike's `src/jwt.ts` and `src/github.ts`.
- **Detecting a conflict:**
  - the Context Store checks for `errors[].type === "STALE_DATA"` on an HTTP 200, never the message text;
  - on that error it re-reads the head, reconciles (ADR-0005, ADR-0016) and commits again;
  - a rejected commit leaves the branch untouched, so retrying is safe.
- **Commits come out signed and verified,** which confirms research note 08. They appear as the App's. The spike's commits carried no trailer, so the per-agent trailer from [ADR-0016](../adr/0016-vault-second-brain.md) goes in the commit message body, which the mutation accepts.
- **Latency.** A mutation takes about 1.7 to 2.6 s, and the first GraphQL read took 4.7 s. Writes have to stay off the hot path and be batched, as ADR-0005 has it, which also keeps them within GitHub's ~80 content-creating requests a minute.
- **Credentials:**
  - the installation token lasts an hour, so the Context Store caches it and renews it before it expires;
  - the App key needs the same one-time PKCS#8 conversion when Story 3.8 stores it as a secret.
