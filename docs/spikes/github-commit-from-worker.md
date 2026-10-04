# Spike: can a Worker commit to GitHub through a GitHub App?

- **Date:** 2026-10-03
- **Issue:** [#28](https://github.com/guedesdiogo/kelpie/issues/28)
- **Status:** code ready; results pending the owner's run

## Question

[ADR-0005](../adr/0005-context-store.md) has the Context Store write agent context to a private GitHub repository with GraphQL `createCommitOnBranch`, from a Worker, authenticated as a GitHub App. Research note 08 recommends the mutation, but nobody has run it from a Worker yet. The spike answers five questions:

1. Can a Worker sign the App's JWT (RS256) with WebCrypto alone, with no Node `crypto` and no JWT library?
2. Can it exchange that JWT for an installation access token?
3. Does one `createCommitOnBranch` mutation commit several files, guarded by `expectedHeadOid`?
4. What exactly does GitHub return when `expectedHeadOid` is stale? This is the conflict signal the Context Store will act on.
5. Can the same mutation delete a file alongside an addition? The Context Store has to handle removals.

## Setup

- **GitHub App:** App ID `5181584`, on the owner's account. It is installed on the private repository `guedesdiogo/kelpie-context-test` (installation `167691807`) and needs the **Contents: read and write** repository permission.
- **Worker:** `spikes/github-commit/` (workspace `@kelpie/spike-github-commit`), run locally with `wrangler dev`. Local workerd reaches `api.github.com` directly, so nothing has to be deployed.
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
- **Offline tests:** `bun run --filter @kelpie/spike-github-commit test` needs no network and no key. It covers:
  - signing and verifying a JWT with a key pair generated in the test, and the claims;
  - refusing a PKCS#1 key;
  - standard base64 for file contents versus base64url for JWT segments;
  - the request bodies and headers;
  - the token check;
  - a whole run against an in-memory fake of GitHub, whose stale-head error is made up.

## Running it

The owner runs this on their own machine. It needs Bun, Node 22 or later, `bun install` at the repository root, and the private key file downloaded from the App's settings page. `jq` is optional.

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

_Pending the run._ Fill these in from the report:

- **Token flow:** status and timing of `installation-token`, plus the returned `permissions` and `expiresAt`.
- **Multi-file commit:** OID, URL, signature and timing of `commit-three-files`.
- **Conflict behavior:** the status and verbatim `errors[]` of `stale-expected-head-oid`. Note in particular the error `type`, which the Context Store can match on instead of the message. Also record whether `headUnchanged` is true.
- **Deletion in the same mutation:** `commit-update-and-delete` and the `read-back` checks.
- **Timings:** `ms` per step.

## Consequences

_Pending the run._
