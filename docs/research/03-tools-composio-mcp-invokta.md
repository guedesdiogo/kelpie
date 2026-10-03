> Research note written on 2026-10-03 for the Kelpie viability study, translated from Portuguese. Corrections across notes are tracked in [00-cross-check.md](00-cross-check.md).

# 03 — Tools: Composio, MCP without containers, and invokta

Research done on 2026-10-03. Read-only: no account, resource or issue was created on Composio, Cloudflare, GitHub or TypeSafe.

**Conventions**
- The source of each claim appears in square brackets, in the format `[id]`. The full list is in **Sources**, at the end.
- **(unverified)**: I did not confirm it in a primary source.
- **(inference)**: my own conclusion from the sources.
- **(measured)**: I ran the command or script in this session. The environment was a local temporary directory.
- For an in-depth look at Jev (price, latency, Workers AI binding, Portuguese), see `04-jev.md`. Here it appears only as a qualifier in tool selection.

---

## TL;DR

### Composio: use it as an adapter, not as the core
**What speaks in its favor**
- Catalog of more than 1,500 toolkits [cx-index].
- Managed OAuth, isolated per `user_id`, with a prefixed tenant ID for B2B (`org_42:user_7`, `org_42:integration`) [cx-b2b].
- The TypeScript SDK runs on Workers with `nodejs_compat`, according to an official guide [cx-cfw].
- Exposes the session over MCP [cx-mcp].
- Has an official Jev provider (`@composio/typesafe`) [cx-ts].

**What speaks against it**
- Composio holds custody of the tokens, and exporting them "is not a supported token-export workflow" [cx-custody]. Leaving Composio means every user reconnects their accounts.
- The rate limit is per organization and all its tenants share the same limit: 2,000/min on Hobby, 10,000/min on Pro [cx-rl].
- An SLA exists only on Enterprise [cx-price].
- The SDK never retries executions [cx-prod].

**How to use it:** through the "harness integration" mode, in which our loop decides and Composio only authenticates and executes [cx-harness].

### invokta: inspiration, not a dependency
- **It solves the inverse problem.** invokta publishes its own capabilities as an MCP server, CLI or direct API (*inbound*). What we need is to consume third-party tools (*outbound*) [ik-readme].
- **Low maturity:**
  - repo created on 2026-07-27, version 0.9.0;
  - one main human maintainer;
  - recent commits almost all from dependabot;
  - about 2.1k downloads/week of `@invokta/core` (measured).
- **Workers:**
  - `@invokta/core` ran on local workerd (measured).
  - `@invokta/mcp` serves HTTP with `node:http.listen(port)`, which does not fit the Workers `fetch` handler.
- **Worth copying:**
  - the single pipeline (validate → authorize → execute → validate output);
  - the closed error taxonomy;
  - **a missing grant becomes `FORBIDDEN` + `authorizationUrl`, not a 401**;
  - the `CredentialSource` port resolved on every invocation, with explicit mapping from *principal* to *subject*. It is still only a proposal.

### MCP without containers: viable for most of the market
- **Measurement on the official MCP Registry (2026-10-03):**
  - 62.7% of active entries have a remote endpoint, almost all Streamable HTTP;
  - 36.1% are package-only, usually stdio (measured).
- **MCP client:** use the one from the Agents SDK (`addMcpServer`) [cf-client]. It detects the transport (Streamable HTTP or SSE), does OAuth with DCR, stores the connection and token in the DO's SQLite, and tries to reconnect 3 times.
  - **Warning:** it writes tokens and headers **without application-level encryption** [cf-src-oauth][cf-src-storage]. Therefore: **one DO per `tenant:user`**.
- **Code Mode + Dynamic Workers:** save tokens and provide a sandbox with no network [cf-codemode-how].
  - Status: Dynamic Workers are in **open beta, Paid plan only**, and I found no GA announcement.
  - Cost: you are billed per unique Dynamic Worker created per day [cf-dw-price].
- **MCP Server Portals:** GA since 2026-09-24 [cf-portals-ga], but they require a Cloudflare Access IdP [cf-portals]. They suit internal use and administration, not a gateway for SaaS end users (inference).
- **stdio:** only through a bridge hosted elsewhere (supergateway, mcp-proxy, Smithery Uplink). Treat it as a "generic remote MCP".

### Recommendation
- Our own `ToolProvider` interface with three adapters: **remote MCP**, **Composio** and **native Workers tools**.
- One `CredentialVault` (DO) per `tenant:user`, with *envelope encryption*.
- Tool selection in 3 stages:
  1. BM25 or embeddings prefilter;
  2. Jev to qualify, abstain and flag risk;
  3. `defer_loading` / `tool_reference` (Anthropic) or Code Mode.

---

## Composio

### Identity and authentication model (state in 2026)
- **User.** The `user_id` is a stable identifier from your app, and Composio keeps the connections under it.
  - Recommended: the database UUID. To avoid: email. Never: `default` in production [cx-session].
  - The old terminology changed: "entity ID" became `user_id`, "integration" became *auth config* and "connection" became *connected account* [cx-ts-ex] (footer "Terminology Migration").
- **Session.** `composio.create(userId)` scopes four things: the user, the available tools, the authentication and the execution state (logs and sandbox files).
  - Sessions live on the server and **do not expire**.
  - To continue, use `composio.use(sessionId)`. Calling `create()` again creates another session [cx-session].
  - The old "Tool Router" became the sessions paradigm, and there is a migration guide "Migrating from Experimental Tool Router" [cx-index].
  - I did not find "Rube" in the current docs (unverified).
- **B2B multi-tenant, according to Composio itself** [cx-b2b]:
  - each member's account: `user_id = "org_42:user_7"`;
  - the workspace account (service account): `user_id = "org_42:integration"`;
  - **one project per environment** (dev, staging, prod), with the tenant boundary in your `user_id`;
  - one project per customer only when there is a contractual or regulatory requirement, or the customer's own OAuth credentials;
  - "Shared connections" (one account for several users, with ACL) exist, but are *experimental* [cx-b2b].
- **Connection flow.**
  - The meta tool `COMPOSIO_MANAGE_CONNECTIONS` or `session.authorize(toolkit, { callbackUrl })` generate a hosted *Connect Link*.
  - Composio does the redirect, the code exchange and the refresh [cx-auth].
  - In a web app, do not hold the request in `waitForConnection`. Confirm the connection in the callback with `session.toolkits({ isConnected: true })` [cx-harness].
- **Managed or own OAuth app.**
  - The default is Composio's managed app.
  - Your own *auth config* gives you your branding on the consent screen, custom scopes and your own quota at the provider [cx-managed].
  - With managed auth, trigger polling has a 15-minute minimum [cx-managed].
  - Full white-label combines your own OAuth app with white-labeling. It costs US$ 0.30 per connection on Pro and is already included in Enterprise [cx-price].
- **Token custody** [cx-custody]:
  - On Composio Cloud, credentials are encrypted at rest with AES-256-GCM, and the account-read APIs return them *redacted*.
  - Reading the account state "is not a supported token-export workflow".
  - **Having your own OAuth app does not take the tokens out of Composio.**
  - For Composio to be unable to decrypt, only three Enterprise arrangements work: private VPC, self-host (Helm) or *customer-managed key* (AWS KMS, GCP KMS, Vault Transit).
  - Credential import exists only in the inbound direction [cx-import].
- **Proxy Execute.** Calls any provider endpoint with the credential injected. It requires a dedicated permission on the API key and restricts the destination to the same eTLD+1 [cx-custody].
- **Retention.** Arguments and results stay in the execution logs by default. The project's *Zero Data Retention* option stops recording new *payloads* [cx-custody].

### TypeScript SDK on Cloudflare Workers
- **There is an official guide** [cx-cfw]:
  - "Run a Composio agent on Cloudflare Workers" uses `@composio/core` + `@composio/openai` with `compatibility_flags: ["nodejs_compat"]` and `compatibility_date: "2026-09-21"`;
  - creates and deletes a session per request;
  - calls `ctx.waitUntil(composio.flush())` for telemetry;
  - asks for Node ≥ 22.22.3 only for local tooling.
- For `compatibility_date` ≥ 2026-08-04, `nodejs_compat` is already on by default [cf-node].
- **Package** (measured, `npm view`): `@composio/core` 0.22.0, published on 2026-09-29.
  - Dependencies: `openai`, `undici`, `pusher-js`, `@composio/client`, `zod-to-json-schema` and others.
  - `pusher-js` is for subscribing to triggers locally. On Workers, use webhooks [cx-index] ("Receiving events"). I do not know whether `pusher-js` works on Workers (unverified).
- A package `@composio/cloudflare` 0.11.0 exists, with a peer `@cloudflare/workers-types` (measured), but it has no page in the docs. Its purpose was not verified.
- `@composio/typesafe` requires Node ≥ 24.17 (measured). I do not know whether it runs on Workers (unverified).

### MCP offering
- **Session via MCP.** With `composio.create(userId, { mcp: true })` you get `session.mcp.url` and `session.mcp.headers` [cx-mcp].
  - **The header carries the project's `x-api-key`**, which is valid for the whole project, or the user key, which is valid for the whole organization.
  - Over MCP, the `beforeExecute`/`afterExecute` hooks and local custom tools **do not run** [cx-mcp].
- **Fixed tool set.** The `DIRECT_TOOLS` preset with `mcp: true` gives a URL that serves only the listed tools [cx-mcp].
- **Custom MCP.** Brings your own remote MCP server into the Composio session.
  - It is **experimental** and exists only via API.
  - Auth modes: `NO_AUTH`, `API_KEY` and `DCR_OAUTH`.
  - Once registered, `app_url` and `auth_schemes` cannot change [cx-custom-mcp].

### Tool search and routing
- **Default mode.**
  - The meta tools search, authenticate and execute: `COMPOSIO_SEARCH_TOOLS`, `COMPOSIO_MANAGE_CONNECTIONS` and the remote Python sandbox.
  - The search returns *skills*, which are playbooks derived from real usage [cx-session].
  - The meta tools only run through `session.execute()` [cx-session].
- **"Harness integration" mode** (recommended for us) [cx-harness]:
  - `composio.toolkits.get()` gives the catalog;
  - `session.authorize(slug)` connects;
  - `composio.tools.getRawComposioTools({ toolkits })` brings raw JSON Schema into **our** index;
  - `session.execute(slug, args)` executes;
  - create the session with `manageConnections: false` and `sandbox: { enable: false }`;
  - "Nothing here asks a model to make a decision".
- **TypeSafe/Jev provider.** `provider.decide(toolSet, request)` returns `kind` (`call`, `partial` or `abstain`), plus `risk`, `confidence`, `missing` and `suggestions`. `typesafe.shortlistTools(raw, request, { k })` does the pre-selection [cx-ts][cx-ts-ex].
  - Jev fills in enums and booleans. Free text, IDs and dates stay with our code.
  - A destructive decision requires `confirm: true` on execute.
  - The provider sends TypeSafe the request, the context, and the tools' names, descriptions and enums. It does not send the Composio API key [cx-ts].

### Price, limits and latency
- **Plans** [cx-price] (read via WebFetch from the pricing page):

  | Plan | Price | Tool calls/month | Triggers/month | Overage | Other |
  | --- | --- | --- | --- | --- | --- |
  | Hobby | free, no card | 100k | 50k | US$ 0.0003/call | 3 members, unlimited connected accounts, "custom tools & MCP" |
  | Pro | US$ 29/month | 100k | 50k | US$ 0.0003/call; **US$ 0.003/trigger event** (10× a call) | 10k req/min, US$ 29/month usage credit (does not roll over), advanced white-label, DPA |
  | Enterprise | on request | — | — | — | SSO/SCIM, CMK, **SLA** |

- **Rate limit** [cx-rl]:
  - it is **per organization**, over a 1-minute window: Hobby 2,000, Pro 10,000, Enterprise custom;
  - "Every authenticated endpoint draws from the same budget", that is, creating a session and listing tools also consume it;
  - a 429 comes with `Retry-After`.
- **Retries.** The SDK retries only reads and **never executions**, because the backend does not deduplicate [cx-prod].
- **Latency.** There is no published number (unverified). Each execution makes two hops: Worker → `backend.composio.dev` → provider. Creating the session is one more call, so reuse the session ID per user (inference from [cx-session]).

### Lock-in and "what if Composio goes down?"
**During an outage**
- Every Composio tool stops, including OAuth and refresh, because the tokens exist only there [cx-custody].
- There is no SLA below Enterprise [cx-price].
- Mitigation (inference):
  - circuit breaker in the `ComposioProvider`;
  - hide the Composio tools from the catalog while the breaker is open;
  - the product's critical tools (the ones connected to chat, for example) **never** depend on Composio.

**To leave**
- There is no token export [cx-custody], so each user has to consent again.
- With your own OAuth app, the new flow shows the same consent screen (your brand's). Even so, the tokens have to be obtained again (inference).

**API lock-in**
- It is low if Composio stays behind the `ToolProvider`: the contract is slug + JSON Schema + execute.
- It is high if the agent depends on the meta tools and the remote sandbox.

---

## invokta (verdict)

### What it is
- A TypeScript framework for **Action Engines**: "versioned, headless capabilities" that you define once and publish through direct call, CLI, MCP stdio and stateless MCP Streamable HTTP [ik-readme].
- The README itself says what it is **not**: "not an identity provider, model router, agent harness, workflow engine, provider catalog" [ik-readme].
- **Core abstraction** [ik-vision]:
  - a *capability* has exactly `description`, `input`, `output`, `access` and `run`;
  - `createEngine({ name, version, capabilities })` exposes `invoke`, `list` and `describe`;
  - the `ExecutionContext` is closed at five fields: `requestId`, `source`, `principal`, `signal` and `logger`;
  - the `Principal` is minimal: `{ id, attributes? }`.
- **Outbound.**
  - *Outbound connectors* are implementations of engine *ports*, injected at composition, with no registry or service locator (ADR 0036) [ik-adr36].
  - `defineConnector` validates configuration synchronously and does no I/O on construction (ADR 0037) [ik-adr37].
- **Per-user credentials and brokers.** The "Connector brokers" note proposes:
  - `CredentialSource.get({ principal, signal })` resolved on every invocation;
  - explicit mapping from *principal* to *subject*;
  - a missing grant returned as `FORBIDDEN` with `publicDetails.authorizationUrl`;
  - a cache whose key includes the subject;
  - Composio (entity id) appears as a case that "Fits `CredentialSource`".
  - **Status: "Proposal, not delivered behavior"** [ik-brokers].

### Maturity (measured via `gh` and npm on 2026-10-03)

| Item | Value |
| --- | --- |
| Repo creation | 2026-07-27 |
| License | MIT |
| Stars / forks | 136 / 18 |
| Open issues | 2 (the GitHub counter sums issues and PRs) |
| Last push | 2026-10-03; the 12 most recent commits are from dependabot |
| Last human commit | 2026-09-06 |
| Version | 0.9.0, from 2026-09-05; it is pre-1.0 |
| Commits on `main` | about 50 (squashed history) |
| Contributors | `vinilana` and one more human; the rest are bots and agents (claude, cursoragent, Copilot, dependabot) |
| Downloads/week | `@invokta/core` 2,132; `@invokta/mcp` 760 |
| Tests | 135 test **files** in `packages/`; **I did not run the suite** |
| Quality and process | `yarn check` gate (typecheck, Biome, vitest with coverage); 41 ADRs |
| Declared runtime | Node ≥ 22.20 |

### Does it run on Workers?
- **`@invokta/core` 0.9.0 — yes, locally** (measured).
  - The code imports `node:util` (`types`), `node:crypto` (`randomUUID`) and `node:perf_hooks`.
  - All three exist on Workers: `perf_hooks` is partial, enabled by default since 2026-03-17 with `nodejs_compat` [cf-node][cf-flags].
  - I put together a Worker with `createEngine` + `defineCapability` + zod 4.6.5.
  - `wrangler deploy --dry-run`: 793 KiB bundle (125 KiB gzipped).
  - `wrangler dev` (local workerd, compat date 2026-09-30) answered `{"message":"Welcome, Lin! (source=direct)"}`, with input validation working.
  - **No deploy was made to Cloudflare.**
- **`@invokta/mcp` 0.9.0 — it loads, but the model does not fit** (measured).
  - The module imports in workerd, with a 2.1 MiB bundle, and `serveMcpHttp(...)` does not throw.
  - However, it uses `node:http.createServer().listen(port)`.
  - On Workers, a `node:http` server only receives traffic if it is wired through `httpServerHandler({ port })` from `cloudflare:node` [cf-express]. I did not test that.
  - Its MCP client (`connectMcpClient`) also supports stdio by spawn, which makes no sense on Workers.
  - To publish MCP on Workers, the native path is `createMcpHandler` from the Agents SDK [cf-transport].

### Verdict: learn from it, do not depend on it
1. **Wrong problem.** It publishes capabilities (server). Our bottleneck is consuming third-party tools with per-user credentials (client). The most useful part, the brokers and per-invocation credentials, **is not implemented** [ik-brokers].
2. **Maintenance risk.** A 2-month-old project, pre-1.0, with a single maintainer and small adoption (inference from the table above).
3. **Partial fit on Workers.** The core runs; the HTTP adapter does not.
4. **Where it may help in the future.** If the product wants to *expose* its own capabilities as MCP (for example, "schedule a meeting in the harness"), it is worth looking at its design. Even in that case, I would use `createMcpHandler` from the Agents SDK.

### Concepts worth copying
- **Capability IDs, not infrastructure IDs.** `crm.create-lead` instead of `http.post` [ik-vision].
  - For us: tool names *namespaced* by provider (`github.create_issue`, `composio.GMAIL_SEND_EMAIL`).
  - See also ADR 0025, "portable MCP tool names".
- **Single pipeline:** validate input → `access` → `run` → validate output. The same pipeline applies to every channel, and `access` runs before any credential is resolved [ik-vision][ik-brokers].
- **Closed error taxonomy.** There are seven codes [ik-brokers]:
  - a missing grant becomes **`FORBIDDEN` + `authorizationUrl`**;
  - reason: "`UNAUTHENTICATED` travels to an MCP HTTP client as a 401 with a Bearer challenge", which makes the client reauthenticate against the **wrong server**, in an infinite loop;
  - **this is the best idea in the repo for us:** in chat, `AUTH_REQUIRED` becomes "connect your account here".
- **`CredentialSource` resolved on every invocation**, with these rules [ik-brokers]:
  - never pass `principal.id` without mapping it;
  - an app or workspace credential never serves a public capability;
  - the cache key **always** includes the subject;
  - do not put a second cache around a broker that already caches.
- **Connector rules** [ik-adr36]:
  - no I/O on construction;
  - configuration validated synchronously;
  - `AbortSignal` on every operation;
  - finite timeouts and limits;
  - retry only opt-in and only for idempotent operations;
  - no raw provider payload in public errors;
  - credentials never enter input, output, logs or events.
- **Closed context.** The `ExecutionContext` has no service locator or "metadata bag" [ik-vision]. It is a good brake against the context turning into a bag of dependencies.

---

## MCP without containers

### Transports
- The specification defines two transports: **stdio** (local) and **Streamable HTTP** (remote). SSE is deprecated [cf-transport].
- The **2026-07-28** MCP specification introduces *stateless* requests. Cloudflare's own servers already support it and also accept 2025 Streamable HTTP clients [cf-mcp-0728].
- Workers do not execute processes, so **stdio is out** of the runtime (inference; Workers have no functional `child_process`).

### How much of the "market MCP" is already remote (measured)
I used the official registry API (`registry.modelcontextprotocol.io/v0/servers?version=latest`, paginated), with these criteria:
- **Status:** only `active` servers.
- **Deduplication:** by `name`. It is approximate, because the registry has duplicate and low-quality entries.
- **Moment:** 2026-10-03, around 18:40 UTC.

**Result:** 38,488 servers.

| Slice | Count | Percentage |
| --- | --- | --- |
| With `remotes` | 24,125 | **62.7%** |
| Remote only | 22,257 | — |
| Package only | 13,904 | **36.1%** |
| Remote and package | 1,868 | — |
| Neither | 459 | — |

- **Remote types:** `streamable-http` 23,633; `sse` 1,101.
- **Packages by registry:** npm 10,383, pypi 4,087, mcpb 1,400, oci 1,037, nuget 132, cargo 67.
- **Package transport:** stdio 16,609.

**Sample of known vendors** (measured, search by namespace prefix):
- **With a remote in the registry:**
  - GitHub (`io.github.github/github-mcp-server`), Notion, Linear, Atlassian, Stripe;
  - Figma, Zapier, Cloudflare, Supabase, Vercel, PayPal;
  - monday.com, Canva, Neon, Wix, Microsoft Learn;
  - several Google APIs (`com.googleapis.*`).
- **Not found by the search:** Slack, HubSpot, Salesforce, Sentry, Asana, Shopify, Intercom, Twilio, MongoDB, Square, Plaid. **This does not mean they have no remote server**, only that they did not show up under that namespace in the search.
- The numbers above measure registry entries, not "the relevant market". Many entries are personal projects (inference).

**Other catalogs**
- **Smithery** [sm-index][sm-connect][sm-publish]:
  - its own registry with semantic search;
  - **Smithery Connect**: a REST API that manages MCP connections, with zero-config OAuth, automatic refresh and credentials "encrypted and write-only", on top of the open-source `agent.pw`;
  - service tokens scoped per user or workspace;
  - publishing by URL requires Streamable HTTP;
  - it is an MCP-native alternative broker to Composio (inference).

### Cloudflare Agents SDK MCP client
- **Basic API** [cf-client]:
  - `this.addMcpServer(name, url, { transport: { type: "auto" | "streamable-http" | "sse", headers }, callbackPath, retry, id })`;
  - the tools arrive through `this.mcp.getAITools()` (AI SDK) or `listTools()` (raw catalog), both with a per-server filter;
  - there is also an **RPC transport** for an `McpAgent` via a Durable Object binding, without HTTP. It fits well for native tools exposed as MCP [cf-client].
- **Versions.** Agents SDK v0.20.0 uses `@modelcontextprotocol/client` (MCP SDK v2) and negotiates between stateless and legacy by itself [cf-client]. On npm, `agents` is at 0.26.0, from 2026-10-02 (measured).
- **OAuth** [cf-client][cf-v040]:
  - if the server requires OAuth, the response is `{ state: "authenticating", authUrl }`;
  - the default callback is `/agents/{agent}/{instance}/callback`;
  - the default provider uses **Dynamic Client Registration**;
  - `createMcpOAuthProvider(callbackUrl)` accepts pre-registered client ID/secret;
  - `callbackPath` avoids leaking the instance name, such as a user ID.
- **Persistence** [cf-client]:
  - the doc says "OAuth tokens are securely stored in SQLite";
  - **in the code**, `DurableObjectOAuthClientProvider.saveTokens` does `storage.put(tokenKey, tokens)` without application-level encryption; `crypto.subtle` appears only for digests [cf-src-oauth];
  - the transport options, **including `headers`**, are written as JSON to the `cf_agents_mcp_servers.server_options` column [cf-src-storage];
  - there is an adapter to swap the storage backend and keep the OAuth logic (PKCE, state, nonce) [cf-client].
- **Reconnection.** By default, 3 attempts with a 500 ms base and 5 s maximum. The configuration persists and is used when restoring after hibernation or at the end of OAuth. `waitForConnections()` waits for everything to settle [cf-client].
- **Connection states:** `authenticating`, `connecting`, `connected`, `discovering`, `ready`, `failed`, reported through `onMcpUpdate` [cf-client].
- **SSRF.** URLs with RFC 1918, link-local and metadata endpoints are blocked; loopback is allowed for development [cf-client].
- **Implication for multi-tenant** (inference from [cf-src-oauth][cf-src-storage]):
  - Connections and tokens live in the storage **of the DO instance** that called `addMcpServer`.
  - If one agent DO serves several end users, everyone's tokens sit together.
  - Rule: **one DO per `tenant:user`** (or `tenant:integration`, for workspace accounts), using the same `user_id` convention as Composio [cx-b2b]. The agent DOs talk to that DO over RPC.
  - **Never** pass Composio's `session.mcp.headers` (the project's `x-api-key`) to `addMcpServer`: it would be stored in the clear in every DO [cx-mcp][cf-src-storage].

### MCP Server Portals
- **GA on 2026-09-24.** Since the beta it gained [cf-portals-ga]:
  - routing through the Gateway, with HTTP logging and DLP;
  - Code Mode policies;
  - static OAuth credentials, for providers without DCR;
  - *service tokens*;
  - Logpush.
- **How it works** [cf-portals]:
  - a `/mcp` endpoint aggregates up to **80 MCP servers per portal**;
  - the admin chooses which tools and prompts to expose;
  - "Require user auth" on makes each user do their own OAuth with the upstream; off uses the admin's credential;
  - **service tokens do not support per-user OAuth**;
  - **requires an IdP configured in Cloudflare Zero Trust/Access**;
  - independent MFA, *purpose justification* and *temporary auth* do not apply to servers authorized through the portal.
- **Relevance for the project** (inference):
  - **Good** for internal operators and admins to access MCPs with auditing.
  - **Bad** as a gateway for end users of several tenants: the user would have to exist in Access/IdP, and the machine-to-machine path (service token) loses per-user OAuth.
  - I did not find specific Portals pricing in the docs (unverified).

### Code Mode
- **Idea** [cf-codemode-how]:
  - the model writes JavaScript against a TypeScript API generated from the tools (MCP, OpenAPI, AI SDK);
  - that code runs in an isolated *executor*: `DynamicWorkerExecutor`, on Worker Loader;
  - `fetch()` and `connect()` are **blocked by default** (`globalOutbound: null`);
  - calls to the *connectors* cross the sandbox by RPC, and **credentials never enter the sandbox**.
- **SDK pieces** [cf-codemode-mcp][cf-hitl]:
  - `createCodeTool({ tools: this.mcp.getAITools(), executor })`: simple, no approval;
  - `McpConnector` + `createCodemodeRuntime`: durable runtime with `codemode.search()`/`describe()` (on-demand discovery), `requiresApproval` per tool (pauses and resumes), logs and snippets in SQLite;
  - `codeMcpServer()` and `openApiMcpServer()` publish a server with a `code` tool, or with the `search`/`execute` pair for large APIs [cf-codemode-server][cf-codemode-api].
- **Version.** `@cloudflare/codemode` 0.5.3, with minimal dependencies (`acorn`) (measured).
- **Savings.** Cloudflare claims "can save up to 80% in inference tokens and cost" [cf-dw-beta]. I did not measure it.

### Dynamic Worker Loader (Dynamic Workers)
- **Status:** **open beta** since 2026-03-24, "for all paid Workers users" [cf-dw-beta].
  - I found no GA announcement in the changelog or the docs (unverified).
  - The pricing page says "currently only available on the Workers Paid plan" [cf-dw-price].
- **Price** [cf-dw-price]:
  - 1,000 unique Dynamic Workers/month included, then **US$ 0.002 per Dynamic Worker per day**;
  - this charge has been active since 2026-05-26;
  - requests and CPU follow the Standard Workers rates;
  - a Dynamic Worker is unique by the combination **Worker ID + code**.
- **Limits** [cf-dw-limits][cf-dw-limits-cl]:
  - up to 4 distinct Dynamic Workers in flight per Worker request;
  - up to **10 per Durable Object**;
  - `cpuMs` and `subRequests` can be limited per invocation [cf-dw-custom].
- **Network egress** [cf-dw-egress]:
  - `globalOutbound: null` cuts the network;
  - a `WorkerEntrypoint` as *gateway* intercepts, filters, injects credentials and audits.
- **Real cost of Code Mode** (inference):
  - `load()` with model-generated code creates a **unique** Worker on every execution;
  - estimate: 100 thousand executions/month ≈ 99 thousand × US$ 0.002 ≈ **US$ 198/month**, plus CPU;
  - compare with the token savings before turning Code Mode on by default;
  - for an agent with few well-selected tools, `defer_loading` is cheaper.

### stdio servers: options and trade-offs
**Options** (all outside Workers; inference from each one's docs)
- Run the stdio process on another host and expose it over HTTP with a bridge:
  - **supergateway**: stdio → Streamable HTTP/SSE, MIT, 2,877★, active on 2026-10-03 [gh-supergateway];
  - **mcp-proxy** (sparfenyuk): bridge between Streamable HTTP and stdio, MIT, 2,770★ [gh-mcpproxy].
- **Smithery Uplink**: the CLI keeps a tunnel and exposes a local or stdio server as a Smithery connection [sm-uplink]. It depends on a machine being on.
- **Cloudflare Containers/Sandbox** would solve it, but are out because of the "no containers" requirement.

**Trade-offs** (inference)
- **Isolation.** stdio servers usually read API keys from environment variables and have access to the host FS. For per-user credentials, you need **one process per tenant or user**, which is expensive and laborious to operate.
- **Latency.** There are extra hops (Worker → bridge → process) and process cold start.
- **Security.** The bridge becomes a public surface that needs its own auth (bearer, mTLS or Access).
- **Operation.** Server infrastructure comes back, which is exactly what the project avoids.

**Recommendation**
- **Do not** support stdio in the core.
- Document the "bring your own bridge" path: the bridge comes in as a **generic remote MCP**, with a URL and header/OAuth, like any other.
- With 62.7% of registry entries already remote and the big SaaS vendors having an official remote server, the cost-benefit favors this choice.

---

## Credentials per tenant and user

### What to store where
- **Platform secrets** (KEK, `COMPOSIO_API_KEY`, `TYPESAFE_API_KEY`, client secrets of own OAuth apps): use Worker secrets or the Secrets Store.
  - **Secrets Store** [cf-ss][cf-ss-acl]:
    - in **open beta**;
    - **100 secrets per account and 1 store per account**;
    - the value cannot be read back;
    - scopes `workers` and `ai-gateway`.
  - **Worker secrets:** 128 variables per Worker on the Paid plan, 5 KB each [cf-limits].
  - **Neither one fits per-user tokens.**
- **Per-user OAuth tokens and API keys** (design inference):
  - They go in a **`CredentialVault` DO per `tenant:user`**.
  - A DO's storage is private to the instance: "cannot be accessed by other objects" [cf-sqlite].
  - Connect the vault to the Agents SDK through the **storage adapter of `DurableObjectOAuthClientProvider`** [cf-client], or through a custom `createMcpOAuthProvider` [cf-v040].
- **Composio tool tokens:** they stay at Composio. On our side we store only `user_id`, `sessionId` and connected account IDs [cx-custody].

### Encryption
- **Envelope encryption** (design inference):
  1. A **KEK** sits in the Secrets Store or in a Worker secret.
  2. A **DEK per tenant** is stored encrypted by the KEK, in D1 or in the vault itself.
  3. Tokens are encrypted with **AES-GCM** and a random IV. Alongside the ciphertext go `kid` (KEK version) and `dekVersion`.
- **Web Crypto.** It is available on Workers, with `importKey`, `encrypt` and `decrypt` [cf-webcrypto].
- **Rotation** (inference):
  - a new KEK re-encrypts the DEKs, and the `kid` allows coexistence during the switch;
  - tokens are re-encrypted *lazily*, on the next read;
  - refresh tokens follow the provider's rotation; Composio does this for us on its side [cx-auth].
- **Platform encryption at rest** (DO and D1): I found no confirmation in the documentation consulted (unverified). Hence the application-level encryption.
- **PITR.** DO SQLite has **30-day** *point-in-time recovery* [cf-sqlite]. A deleted token remains recoverable during that period. Revoking requires revoking **at the provider**, not just deleting the row (inference).

### Scopes and revocation
- **Minimum scopes.**
  - Composio lets you override OAuth scopes per toolkit [cx-index] ("Controlling scopes").
  - There is also the v3.1 endpoint `POST /tools/scopes/required` [cx-auth] (API versions footer).
  - In MCP OAuth, scopes come from the server's discovery. The Agents SDK handles *step-up* (`onInsufficientScope`, `maxStepUpRetries` in the persisted options) [cf-src-storage].
- **Revocation** (inference):
  - The provider's `disconnect(subject)` should:
    1. revoke at the provider (RFC 7009) when there is an endpoint;
    2. delete from the vault;
    3. remove the connection (`removeMcpServer(id)` in the Agents SDK [cf-client], or disable or delete the connected account at Composio).
  - The doc shows connections being disabled in the "restrict Gmail domain" example [cx-manual]. The exact deletion endpoint was not verified.
  - When a member leaves the workspace: they lose access to the `org:integration` accounts, and the policy lives in our app [cx-b2b].
- **Identity mapping** [ik-brokers][cx-custody]:
  - the `user_id` is **derived on the server** from the channel's authenticated session, never from user input;
  - format `tenantId:userId`;
  - "A caller-supplied user ID is not proof of identity".

---

## Tool selection at scale

### Available tools
- **Anthropic tool search** [an-toolsearch]:
  - **Variants:** regex (`tool_search_tool_regex_20251119`) and BM25 (`tool_search_tool_bm25_20251119`), both executed on the server.
  - **Deferred loading:** `defer_loading: true` keeps the definitions out of the context. You still send all of them in the request.
  - **Limits:** up to **10,000 deferred tools**; each search returns 5 by default, and `limit` ranges from 1 to 10,000.
  - **Own search:** you can return `tool_reference` blocks in a `tool_result` from your own search tool, for example with embeddings.
  - **MCP connector:** `defer_loading` goes in the `default_config` of the `mcp_toolset`.
  - **Motivation:** selection "degrades once you exceed 30–50 available tools", and about 55k tokens of definitions in a typical setup drop by more than 85%.
  - **Compatibility:** it preserves prompt caching. A deferred tool does not accept `cache_control`.
- **Composio** [cx-session][cx-harness]:
  - the meta-tool search runs on the server, with skills;
  - or `getRawComposioTools` feeds our index.
- **Code Mode.** `codemode.search()`/`describe()` load documentation on demand, inside the sandbox [cf-codemode-mcp].
- **Portals.** They have an `optimize_context` mode with `portal_query_tools` (regex) [cf-portals].

### Where Jev comes in
See `04-jev.md` for the detail.

**Useful data** [ts-models][ts-skill][cx-ts]
- **Model and limits:** Jev 1.13, at US$ 0.042 per million input tokens. The limit is 80 req/s and is "adjusting dynamically".
- **Context:** 64k tokens per request; the `state` plus the largest question fit in up to 32k.
- **Language:** English is the main language. Other languages work, but "not equally well".
- **Reference result:** on a catalog of 182 skills, ranking followed by a check lowered "loads the wrong skill" from 16.8% to 7.3% and "loads one when nothing fits" from 9.8% to 4.0% [ts-skill].

**Proposed pipeline** (design inference)
1. **Policy.** Filter the catalog by what the tenant and the agent may use: allowlist of providers and toolkits, connected accounts and risk ceiling.
2. **Cheap prefilter.** BM25 or embeddings over name, description and arguments, keeping the top 30–50. This is needed because Jev's 64k context **does not fit a catalog of thousands of tools in a single call**.
3. **Jev as qualifier**, in a single *fan-out* call per turn:
   - (a) `noul` "does this turn need a tool?", which allows abstaining;
   - (b) `choice` or ranking among the 30–50 candidates, keeping k = 3–5;
   - (c) risk (`read_only`, `write`, `destructive`), which feeds HITL;
   - (d) filling in *enum* arguments when there are any.
   - Jev does **not** generate free arguments [cx-ts].
4. **Exposure to the LLM:**
   - **Claude:** the k chosen stay non-deferred and the rest deferred, with tool search as a safety net [an-toolsearch].
   - **Other LLMs:** inject only the shortlist.
   - **Long chains** with many dependent calls: Code Mode.
5. **Execution.** A `destructive` tool pauses for approval. In a durable flow, use Workflows with `waitForEvent` or Code Mode's `requiresApproval` [cf-hitl].

**Caveats**
- **Language.** The input will be in pt-BR and Jev has English as its main language [ts-models]. Measure before trusting the abstention.
- **Privacy.** The request, context, and the tools' names and descriptions go to TypeSafe [cx-ts]. This goes into the per-tenant data policy.
- **Legacy path.** Composio's provider uses `composio.tools.get` and `provider.execute(userId, …)`, which is the legacy direct-execution path and requires a *toolkit version* [cx-ts-ex] (footer "legacy direct tool execution").
  - The combination coherent with sessions is `typesafe.shortlistTools(getRawComposioTools(...))` + `session.execute(slug)` (inference).
  - On Workers, it is simpler to call Jev directly (binding or HTTP, see `04-jev.md`) than `@composio/typesafe` (Node ≥ 24.17, unverified on Workers).

---

## Proposed abstraction

### Principles
- **One interface of ours, three adapters.** No third-party SDK leaks into the agent core.
- **Explicit identity on every call.** The `Subject` always has a tenant.
- **Closed errors, and "connect your account" is a result, not an exception** (lesson from invokta).
- **Credentials never pass through the model, the logs or the events** [ik-adr36][cx-custody].

### Type sketch

```ts
// ---------- identity ----------
export interface Subject {
  tenantId: string;
  userId?: string;   // absent = workspace account ("tenant:integration")
  agentId: string;
}
export const subjectKey = (s: Subject) => `${s.tenantId}:${s.userId ?? "integration"}`;

// ---------- catalog ----------
export type ToolRisk = "read_only" | "write" | "destructive";

export interface ToolDescriptor {
  id: string;               // namespaced and stable: "mcp:linear/create_issue", "composio/GMAIL_SEND_EMAIL"
  providerId: string;
  description: string;
  inputSchema: JsonSchema;   // MCP and Composio already deliver JSON Schema
  outputSchema?: JsonSchema;
  risk: ToolRisk;           // from MCP annotations (readOnlyHint/destructiveHint), declared, or classified (Jev)
  toolkit?: string;         // "github", "slack"...
}

// ---------- connection ----------
export type ConnectionState =
  | { status: "ready" }
  | { status: "auth_required"; authorizationUrl: string }
  | { status: "unavailable"; reason: string };

// ---------- execution ----------
export interface ToolCallContext {
  subject: Subject;
  requestId: string;        // correlation and idempotency
  signal: AbortSignal;      // end-to-end cancellation
  timeoutMs: number;        // always finite
}

export type ToolResult =
  | { ok: true; content: unknown }
  | { ok: false; code: "AUTH_REQUIRED"; authorizationUrl: string }   // ≈ FORBIDDEN+authorizationUrl (invokta)
  | {
      ok: false;
      code: "FORBIDDEN" | "INVALID_INPUT" | "RATE_LIMITED" | "PROVIDER_ERROR" | "TIMEOUT" | "CANCELLED";
      message: string;      // sanitized: no raw payload, no credential
      retryable: boolean;   // execution is only retried if idempotent
    };

// ---------- provider contract ----------
export interface ToolProvider {
  readonly id: string;                                    // "mcp:linear", "composio", "native"
  listTools(subject: Subject, signal?: AbortSignal): Promise<ToolDescriptor[]>;
  connection(subject: Subject, toolkit?: string): Promise<ConnectionState>;
  connect?(subject: Subject, opts: { callbackUrl: string; toolkit?: string }): Promise<{ authorizationUrl: string }>;
  disconnect?(subject: Subject, toolkit?: string): Promise<void>;  // revokes at the provider + deletes from the vault
  call(toolId: string, args: unknown, ctx: ToolCallContext): Promise<ToolResult>;
}

// ---------- selection ----------
export interface ToolSelector {   // prefilter (BM25/embeddings) + Jev
  select(input: { request: string; context?: unknown; candidates: ToolDescriptor[]; k: number; signal: AbortSignal }):
    Promise<{ kind: "tools"; tools: ToolDescriptor[] } | { kind: "abstain"; reason: string }>;
}

// ---------- credentials ----------
export interface CredentialVault {  // RPC to a DO by subjectKey; AES-GCM with the tenant's DEK
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}
```

### Adapters (design inference, anchored in the sources)

| Adapter | Basis | Notes |
| --- | --- | --- |
| `McpRemoteProvider` | Agents SDK `addMcpServer` inside a **DO per `subjectKey`** (`ToolGateway`) [cf-client] | Uses `createMcpOAuthProvider` and storage through the `CredentialVault` [cf-v040]. Puts in `headers` only credentials **of the subject itself**, never platform keys, because `headers` is persisted in the clear [cf-src-storage]. Serves any market MCP and any "bring your own" stdio bridge. `ToolDescriptor.risk` comes from the MCP annotations, with a "write" fallback (inference). |
| `ComposioProvider` | `@composio/core` in a Worker or DO, with `COMPOSIO_API_KEY` in a secret [cx-cfw][cx-harness] | `composio.create(subjectKey, { manageConnections: false, sandbox: { enable: false } })`. The `sessionId` is stored in the vault and reused, to save the rate limit [cx-session][cx-rl]. `listTools` = `getRawComposioTools({ toolkits })` filtered by `session.toolkits({ isConnected: true })`. `call` = `session.execute(slug, args)`, with no automatic retry [cx-prod]. `connect` = `session.authorize(toolkit, { callbackUrl })`. Circuit breaker (inference). Do **not** use `session.mcp` via `addMcpServer` [cx-mcp]. |
| `NativeProvider` | TypeScript tools in the Worker itself (Standard Schema/Zod), or a `McpAgent` wired through the Agents SDK **RPC transport** [cf-client] | Zero network hops. This is the place for the product's tools: memory, internal calendar, handoff to a human and the like. |

**Composition** (design inference)
- One `ToolRegistry` per agent joins the providers enabled by the tenant.
- It applies the policy (allowlist, risk ceiling and consent) and guarantees unique names, with collisions detected at load time (like invokta's ADR 0025).
- The event-driven flow looks like this:
  1. Queue;
  2. agent DO;
  3. `ToolSelector`;
  4. LLM;
  5. `ToolProvider.call`;
  6. if `destructive`: Workflow step with approval;
  7. result.

---

## Risks

### Composio
1. **Custody with no exit.** Without token export, leaving Composio forces every user to consent again. Your own OAuth app does not change this; only CMK or self-host, both Enterprise [cx-custody].
2. **Shared rate limit.** It is per organization and sums all tenants: 2k/min on Hobby, 10k/min on Pro. Creating a session and listing tools also count [cx-rl]. A noisy tenant affects everyone (inference).
3. **No SLA and no retry.** There is no SLA below Enterprise [cx-price], and the SDK does not retry executions [cx-prod]. Idempotency is our responsibility.
4. **Experimental surface.** Custom MCP and Shared connections are experimental [cx-custom-mcp][cx-b2b]. Do not build the tenant model on top of them.
5. **Third-party data.** Arguments and results stay in Composio's logs by default; ZDR exists per project [cx-custody]. Tenants in regulated sectors will ask about this.

### Agents SDK and MCP
6. **Tokens in the clear in DO storage** [cf-src-oauth][cf-src-storage].
   - If the DO is shared among users, there is a risk of cross-leakage.
   - Mitigation: DO per `tenant:user` and a vault with envelope encryption.
7. **30-day PITR** keeps deleted secrets recoverable [cf-sqlite].
8. **Third-party MCP servers are untrusted content.** Tool descriptions and results may carry prompt injection (inference).
   - Treat tool output as data.
   - Keep `destructive` behind approval.
   - Portals and Code Mode help with auditing [cf-portals][cf-codemode-how].
9. **SSE deprecated.** Some servers are still SSE-only (1,101 entries in the registry, measured). `transport: "auto"` covers the case for now [cf-client][cf-transport].

### Cloudflare
10. **Dynamic Workers and Code Mode.** Still in open beta and Paid plan only, with a cost per unique execution and at most 10 per DO in parallel [cf-dw-beta][cf-dw-price][cf-dw-limits]. Start with `defer_loading` and a shortlist, and turn on Code Mode per agent when measurement justifies it.
11. **Secrets Store.** Still in open beta, with a limit of 100 secrets [cf-ss]. It does not fit per-user data.

### Jev
12. **Portuguese, privacy and limits.**
    - English is the main language [ts-models]; nobody has measured it in PT (see `04-jev.md`).
    - The user's text goes to TypeSafe [cx-ts].
    - The limits are "adjusting dynamically" [ts-models].
    - Mitigation: Jev is **optional** in the pipeline. If it fails or times out, use only the prefilter and tool search (inference).

### invokta
13. **Immature dependency.** Mitigation: do not depend on it. Copying the concepts costs little.

### stdio
14. **Recurring customer request.** Some useful MCPs exist only as stdio (36.1% of registry entries, measured). "Bring your own bridge" pushes the operation onto the customer. Make this clear in the product documentation.

---

## Sources

### Composio
- [cx-index] https://docs.composio.dev/llms-index.txt
- [cx-session] https://docs.composio.dev/docs/how-composio-works.md
- [cx-b2b] https://docs.composio.dev/docs/b2b-agents.md
- [cx-auth] https://docs.composio.dev/docs/authentication.md
- [cx-managed] https://docs.composio.dev/docs/authentication/custom-app-vs-managed-app.md
- [cx-custody] https://docs.composio.dev/docs/security/token-custody.md
- [cx-import] https://docs.composio.dev/docs/authentication/importing-existing-connections.md
- [cx-manual] https://docs.composio.dev/docs/authentication/manually-authenticating.md
- [cx-cfw] https://docs.composio.dev/examples/cloudflare-workers.md
- [cx-mcp] https://docs.composio.dev/docs/sessions-via-mcp.md
- [cx-custom-mcp] https://docs.composio.dev/docs/extending-sessions/custom-mcp.md
- [cx-harness] https://docs.composio.dev/examples/harness-integration.md
- [cx-ts] https://docs.composio.dev/docs/providers/typesafe.md
- [cx-ts-ex] https://docs.composio.dev/examples/typesafe-tool-selection.md
- [cx-rl] https://docs.composio.dev/reference/rate-limits.md (and https://docs.composio.dev/kb/guide/platform-rate-limits.md)
- [cx-prod] https://docs.composio.dev/docs/production-readiness.md
- [cx-price] https://composio.dev/pricing (read via WebFetch)
- npm: `npm view @composio/core`, `@composio/cloudflare` e `@composio/typesafe` (measured); downloads at https://api.npmjs.org/downloads/point/last-week/@composio/core

### invokta
- [ik-readme] https://github.com/vinilana/invokta/blob/main/README.md
- [ik-vision] https://github.com/vinilana/invokta/blob/main/docs/vision-and-invariants.md
- [ik-brokers] https://github.com/vinilana/invokta/blob/main/docs/connector-brokers.md
- [ik-adr36] https://github.com/vinilana/invokta/blob/main/docs/adr/0036-engine-owned-outbound-connectors.md
- [ik-adr37] https://github.com/vinilana/invokta/blob/main/docs/adr/0037-typed-connector-definitions.md
- Code read: `packages/core/src/*.ts` e `packages/mcp/src/{index,http,client}.ts` (clone on 2026-10-03, HEAD `f1e2f04`)
- Metadata: `gh repo view vinilana/invokta`, `gh api repos/vinilana/invokta/contributors`, https://api.npmjs.org/downloads/point/last-week/@invokta/core e …/@invokta/mcp

### Cloudflare
- [cf-client] https://developers.cloudflare.com/agents/model-context-protocol/apis/client-api/
- [cf-mcp-tools] https://developers.cloudflare.com/agents/tools/mcp/
- [cf-v040] https://developers.cloudflare.com/changelog/post/2026-02-09-agents-sdk-v0.4.0/
- [cf-src-oauth] https://github.com/cloudflare/agents/blob/main/packages/agents/src/mcp/client/do-oauth-client-provider.ts
- [cf-src-storage] https://github.com/cloudflare/agents/blob/main/packages/agents/src/mcp/client/storage.ts (last commit on the file: 2026-08-27)
- [cf-transport] https://developers.cloudflare.com/agents/model-context-protocol/protocol/transport/
- [cf-mcp-0728] https://developers.cloudflare.com/changelog/post/2026-07-28-cloudflare-mcp-servers-mcp-2026-07-28/
- [cf-portals] https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/
- [cf-portals-ga] https://developers.cloudflare.com/changelog/post/2026-09-24-mcp-portals-ga/
- [cf-codemode-how] https://developers.cloudflare.com/agents/tools/codemode/how-it-works/
- [cf-codemode-mcp] https://developers.cloudflare.com/agents/tools/codemode/mcp/
- [cf-codemode-server] https://developers.cloudflare.com/agents/model-context-protocol/codemode/
- [cf-codemode-api] https://developers.cloudflare.com/agents/tools/codemode/api-reference/
- [cf-hitl] https://developers.cloudflare.com/agents/concepts/agentic-patterns/human-in-the-loop/
- [cf-dw-beta] https://developers.cloudflare.com/changelog/post/2026-03-24-dynamic-workers-open-beta/
- [cf-dw-price] https://developers.cloudflare.com/dynamic-workers/pricing/
- [cf-dw-limits] https://developers.cloudflare.com/dynamic-workers/platform/limits/
- [cf-dw-limits-cl] https://developers.cloudflare.com/changelog/post/2026-08-28-durable-objects-dynamic-workers-limit/
- [cf-dw-custom] https://developers.cloudflare.com/dynamic-workers/usage/limits/
- [cf-dw-egress] https://developers.cloudflare.com/dynamic-workers/usage/egress-control/
- [cf-node] https://developers.cloudflare.com/workers/runtime-apis/nodejs/
- [cf-flags] https://developers.cloudflare.com/workers/configuration/compatibility-flags/
- [cf-express] https://developers.cloudflare.com/workers/tutorials/deploy-an-express-app/
- [cf-ss] https://developers.cloudflare.com/secrets-store/manage-secrets/
- [cf-ss-acl] https://developers.cloudflare.com/secrets-store/access-control/
- [cf-limits] https://developers.cloudflare.com/workers/platform/limits/
- [cf-sqlite] https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
- [cf-webcrypto] https://developers.cloudflare.com/workers/runtime-apis/web-crypto/

### MCP ecosystem
- Official registry: https://registry.modelcontextprotocol.io/v0/servers (paginated API; count measured on 2026-10-03)
- [sm-index] https://smithery.ai/docs/llms.txt
- [sm-connect] https://smithery.ai/docs/use/connect.md
- [sm-uplink] https://smithery.ai/docs/use/uplink.md
- [sm-publish] https://smithery.ai/docs/build/publish.md
- [gh-supergateway] https://github.com/supercorp-ai/supergateway
- [gh-mcpproxy] https://github.com/sparfenyuk/mcp-proxy

### Anthropic and TypeSafe
- [an-toolsearch] https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
- [ts-models] https://docs.typesafe.ai/models.md
- [ts-skill] https://docs.typesafe.ai/cookbooks/skill_suggestion.md
- Index: https://docs.typesafe.ai/llms.txt
