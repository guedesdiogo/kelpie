# 00 — Cross-check of research notes 01–08

- **Date:** 2026-10-03. Read-only review. Nothing was created on GitHub, Cloudflare or any other service.
- **Scope:** all eight notes in this folder (01 Hermes/Bot Mode, 02 memory, 03 tools/Composio/MCP, 04 Jev, 05 Cloudflare limits and architecture, 06 chat channels, 07 LLM providers and auth, 08 database and context storage), read in full.
- **Method:** I compared the notes against each other. Where a contradiction or an unverified claim changes a design decision, I checked it against primary sources in this session: the Cloudflare docs (the `search_cloudflare_documentation` tool plus the official `.md` pages), TypeSafe and OpenRouter docs, Meta, GitHub and Anthropic docs, and the `cloudflare/agents` source code at a pinned commit.
- **Legend:**
  - **Verified:** I read the primary source in this session; the URL and a short quote are given.
  - **(unverified):** I could not confirm it.
  - The quotes used for C1, C3, C4, C5, C6, C9, C15 and C16 were checked against the raw page text (search chunks or `curl` of the `.md` pages), not only against summaries.
  - Internal references use the form `NN §section`, using the headings of the English translations of the notes.

---

## Summary

1. **Four cross-file contradictions change the design. All four are now resolved.**
   - **DO duration overage is billed in steps.** Overage is rounded up to the next 1M GB-s, so 05 is right and 06's "≈ US$ 4/bot" is wrong (C1).
   - **The preferred Jev path is capped.** 04's default `env.AI.run('typesafe/jev')` runs on Unified Billing, which is limited to **200 requests per 60 s per gateway** (C4).
   - **AI Gateway Dynamic Routing can't do the fallback.** It accepts only the chat-completions shape and needs stored BYOK keys. Fallback must live in the harness's `ModelRouter`, as 07 says, not in the gateway, as 05 assumes (C5).
   - **A Discord Gateway socket keeps a DO alive for at most 15 min.** After that the connection keeps running but no longer prevents eviction. A watchdog alarm is mandatory (C3).
2. **Two Jev claims in 02 are wrong, and 04 missed an access path.**
   - OpenRouter uses the same named-map + `criteria` shape as TypeSafe, not "array + `options`" (C6).
   - The blog's launch date is 2026-09-15, not 2026-09-28 (C9).
   - OpenRouter serves `typesafe/jev-1.13` with **no waitlist**. 04 missed this, and it weakens 04's main vendor-access risk (C7).
3. **Three findings in 03 and 08 hold up.**
   - The Agents SDK stores MCP OAuth tokens without app-level encryption, verified in code (C10).
   - Hyperdrive caches by default and is not invalidated by writes (C11).
   - GitHub's 80/min and 500/h content-creation limits also appear on the GraphQL page (C12).
4. **Requirements that are not viable as stated:**
   - **subscription login** for OpenAI and Anthropic (07; the Anthropic policy is verified);
   - **user profiles as `.md` in GitHub/Obsidian** (02, 08, because of LGPD/GDPR erasure).

   Everything else is viable, most of it with changes (§3).

---

## 1. Contradictions between files

### 1A. Resolved against primary sources

Ordered by design impact.

#### C1 — Durable Object duration overage: step-billed or pro-rata?

- **05** ("Limits table (Workers Paid) → Durable Objects (SQLite)", "Price: duration"; "Estimated cost (small scenario, no LLM)"): overage is "rounded up to the next unit (1M GB-s)". This is the source of 05's US$ 5 vs US$ 18 cases and its +US$ 12.50 stress steps.
- **06** (TL;DR table, Discord row; §3.4; §10 item 6): each always-on Discord bot costs "≈ US$ 4.05/month", a pro-rata reading.
- **Verdict: 05 is right. Verified.** [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) (last updated 2026-09-30):
  - "This billable usage is rounded up to the next billable unit before the corresponding rate is applied. For example, 500,000 GB-s of billable compute duration is rounded up to 1,000,000 GB-s".
  - Example 4 on the same page bills 152,960 GB-s of overage as US$ 12.50.
- **Consequence:** duration cost is a step function, US$ 12.50 per started million GB-s above the 400k included.
  - One always-on Discord DO uses 324k GB-s/month. Added to 05's baseline (~150k), that crosses 400k and costs **US$ 12.50**, not US$ 4.05.
  - The next step comes at 1.4M GB-s, roughly three more always-on bots.
  - Correct 06 TL;DR, §3.4 and §10 accordingly.

#### C2 — Does a scheduled DO alarm prevent hibernation?

- **05** (contradiction table, "DO alarm and hibernation"; cost cases A/B; closing note): the DO WebSockets page says "Events such as alarms … prevent hibernation". The lifecycle page's hibernation conditions do not list a scheduled alarm. 05 assumes it does not block hibernation (case A, ≈ US$ 5) but leaves this as inference.
- **Verdict: 05's reading is supported. Verified, but only implicitly.**
  - [DO lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/) (2026-09-30) lists the hibernation conditions: no `setTimeout`/`setInterval`, no unfinished I/O or `waitUntil`, "no outbound connection remains open", no standard WebSocket API, no request or event in progress. It also says "the first incoming request or event (like an alarm) will execute the `constructor()`", so an alarm can construct an inactive object.
  - [Alarms API](https://developers.cloudflare.com/durable-objects/api/alarms/) (2026-04-21): alarms "schedule the Durable Object to be woken up at a time in the future".
  - The WebSockets-page sentence most likely refers to events *being processed* (my interpretation; I did not fetch that page).
  - No page says in so many words "a pending alarm does not block hibernation", so confirm with duration metrics in a spike.
- **Consequence:** debounce, pacing waits and watchdogs must be alarms (or `Agent.schedule()`), never `setTimeout` outside an active turn. 05's case A is the right baseline.

#### C3 — Outbound WebSocket lifetime (Discord Gateway, any socket client)

- **05** (R3; "Hard constraints and adaptations"): outbound WebSockets don't hibernate; each one holds the DO for at most 15 min; the connection "may" stay open after that.
- **06** (§3.2): cites a 2026-06-19 changelog saying DOs "stay alive while there is an active outbound connection".
- **Verdict: both are partial. Verified.**
  - [Changelog 2026-06-19](https://developers.cloudflare.com/changelog/post/2026-06-19-outbound-connections-keep-dos-alive/): "Each outbound connection keeps the Durable Object alive for a maximum of 15 minutes. After 15 minutes, the connection stops preventing eviction (the connection itself continues operating)."
  - The lifecycle page also lists "no outbound connection remains open" as a hibernation condition. While the socket is open the DO can't hibernate, so it is billed.
- **Consequence:**
  - A Gateway DO is billed 24/7 (C1 applies).
  - After 15 min it becomes evictable after 70–140 s without incoming events. Whether frames received on an *outbound* socket count as incoming events is **(unverified)**.
  - 06's ~1-min watchdog alarm is therefore **mandatory, not optional**: each alarm invocation is an event, about 43k requests a month, well inside the 1M included.
  - 06's advice to persist `session_id`/`seq` and RESUME stands.
  - Run a spike: keep a socket for more than 24 h with only the alarm, and log evictions.

#### C4 — Unified Billing rate cap vs the preferred Jev path (a conflict no note connects)

- **04** (§2.1 table; §3.2; §5.3 `makeQualifier`): prefers `JevWorkersAIQualifier` (binding + `JEV_GATEWAY_ID`) over the HTTP path, and §4.2 fires a Jev call **on every pause** of the fragment buffer. 04 writes "Through Cloudflare, the limits for this model: (unverified)".
- **05** ("AI" table) and **07** (§2.3): Unified Billing has a "limit of 200 req/60 s per gateway". 07 says it "does not work as a multi-tenant production path".
- **Verdict: the cap applies to the Jev binding path. Verified.**
  - [AI Gateway limits](https://developers.cloudflare.com/ai-gateway/reference/limits/) (2026-09-24): "Unified Billing rate limit: 200 requests per 60 seconds per gateway". It applies to requests using Cloudflare-managed credentials, returns 429, and can be raised through a limit-increase form.
  - [Changelog 2026-05-21](https://developers.cloudflare.com/changelog/post/2026-05-21-rest-api/): "Third-party models are billed through Unified Billing". `typesafe/jev` is listed as third-party in 04 [CF-jev].
  - [Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/): "A 5% fee is applied to all credits purchased".
- **Consequence:**
  - Jev through Cloudflare tops out around **3.3 req/s per gateway**, with 20 gateways per Paid account.
  - Under 04 §4.2, a user who sends four fragments can cost 3–4 calls, which caps one gateway at roughly 50–65 user turns per minute. That's fine for a demo and a hard ceiling for multi-tenant use.
  - **Options:**
    1. request a limit increase;
    2. use TypeSafe direct for production (80 req/s, 100k tokens/s per [models.md](https://docs.typesafe.ai/models.md));
    3. use OpenRouter (C7; its Jev rate limits are **(unverified)**).
  - The Workers AI free-neuron allowance does not cover Jev, because it is billed through Unified Billing (inference from the changelog above).

#### C5 — AI Gateway Dynamic Routing as the LLM fallback mechanism

- **05** (TL;DR item 4; flow step 5; `llm-gateway` row): retry and "fallback via Dynamic Routing" in the AI Gateway.
- **07** (§2.1, §2.4, §5): dynamic routes and `/compat` accept only the chat format, which breaks OpenAI tool calling on GPT-6 (Responses-only). Fallback belongs in a `ModelRouter`, applied at the start of a turn.
- **Verdict: 07 is right. Verified.**
  - [Dynamic Routing](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/): "Dynamic routes accept the OpenAI chat completions request shape only … Other request formats, such as Anthropic Messages, return a `400` error."
  - The same page requires gateway authentication and "upstream providers keys stored with BYOK". 05 R12 and 07 §2.3 already show that stored BYOK only consults the `default` alias on the unified paths.
  - Dynamic Routing is therefore incompatible with three things: native Anthropic Messages, OpenAI Responses, and per-request tenant keys.
- **Consequence:** use the AI Gateway only as a passthrough (logs, `cf-aig-max-attempts` retries, metadata, `byok_only`). Put provider and model fallback in the harness `ModelRouter` (07 §5).
  - 07's claim that GPT-6 tool calling requires the Responses API was not re-verified by me **(unverified here)**.

#### C6 — Jev API endpoint and request shape

- **02** (§1.8, "Two diverging API surfaces"): the ai-memory shim uses `POST /v1/systemone` with a named `questions` object and `criteria`; OpenRouter uses `POST /api/alpha/decisions` with an **array** and `options`.
- **04** (§3.1): `POST https://api.typesafe.ai/v1/systemone`, a named map, `criteria`, `model` required. The Cloudflare binding takes only `state` and `questions`.
- **Verdict: one shape everywhere. 02's "array + `options`" is wrong. Verified.**
  - [TypeSafe api.md](https://docs.typesafe.ai/api.md): `POST https://api.typesafe.ai/v1/systemone`; `questions` is "a map of typed Question objects"; choice uses `criteria`; `model` is required.
  - [OpenRouter Decisions API reference](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request): both the OpenAPI **schema and example** for `/api/alpha/decisions` agree. `DecisionsRequest.questions` is `type: object` with `additionalProperties`, i.e. a named map. `DecisionsChoiceQuestion` requires `type`, `instructions` and `criteria`. The example sends `"model": "typesafe/jev-1.13"`. The only array in the schema is one allowed form of `state`.
  - [OpenRouter Jev guide](https://openrouter.ai/docs/guides/community/jev): OpenRouter also exposes `POST https://openrouter.ai/api/v1/systemone` "by changing the base URL" of the TypeSafe SDK.
- **Consequence:** one wire format for the `Qualifier`. Adapters differ only in base URL, auth and the `model` field (required on TypeSafe and OpenRouter, absent on Cloudflare per 04 §2.1, not re-verified).

#### C7 — Can Jev be used without a waitlist?

- **04** (§2.1: OpenRouter lists only `typesafe/jev-router`, and `~typesafe/jev-latest` returned 404; §6.1 risk 1: TypeSafe early access "with a waitlist"). **02** (§1.8) cites the OpenRouter Jev guide.
- **Verdict: yes, via OpenRouter. Verified.** [OpenRouter Jev guide](https://openrouter.ai/docs/guides/community/jev): "`typesafe/jev-1.13` (or the `~typesafe/jev-latest` alias) is available to anyone with an OpenRouter API key" and "There's no waitlist or separate TypeSafe account."
- **Consequence:**
  - Add a `JevOpenRouterQualifier`, or the TypeSafe SDK pointed at the OpenRouter base URL.
  - A clone of the public repo can run Jev with only an OpenRouter key. It's still paid, and the heuristic fallback stays the zero-key default.
  - OpenRouter becomes one more data subprocessor (LGPD).

#### C8 — Jev context window

- **02** (§1.8; §3.4): "32,000 tokens for state + questions" (OpenRouter).
- **03** ("Where Jev comes in") and **04** (§2.2): 64k per request; 32k for `state` plus the largest question.
- **Verdict: both are right for their access path. Verified.**
  - [TypeSafe models.md](https://docs.typesafe.ai/models.md): "64k tokens per request; 32k tokens for `state` plus the longest question".
  - The [Cloudflare model page](https://developers.cloudflare.com/ai/models/typesafe/jev/) and the OpenRouter guide list "32,000 tokens".
- **Consequence:** budget 32k in total so every path works. This tightens 03's 30–50-candidate tool prefilter and 04 rule 2 (minimal `state`).

#### C9 — Jev launch date (minor)

- **02** cites the TypeSafe blog as "2026-09-28". **04** says it launched on 2026-09-15.
- **Verdict: 04 is right. Verified in raw HTML.** The [blog post](https://typesafe.ai/blog/introducing-system-one-models-and-jev) shows "Sep 15, 2026" as its date. "Published Sep 28, 2026, 7:32 PM UTC" is a Framer site-publish comment in the HTML header.

#### C10 — Agents SDK: MCP OAuth token storage

- **03** ("Cloudflare Agents SDK MCP client → Persistence"; risk 6): the docs say "securely stored", but the code stores tokens without application-level encryption, and transport `headers` are persisted as JSON.
- **05** ("Agents SDK (`agents` package) — confirmed capabilities", MCP client row): "tokens and connections persisted in the agent's SQLite", with no caveat.
- **Verdict: 03 is right. Verified in code** at [`cloudflare/agents@2f3176b`](https://github.com/cloudflare/agents/blob/2f3176b9fa03c6429c805b560c8dc14371c15f64/packages/agents/src/mcp/client/do-oauth-client-provider.ts):
  - `saveTokens` runs `await this.storage.put(this.tokenKey(this.clientId), tokens);`. `crypto.subtle` is used only for the PKCE SHA-256 digest.
  - [`storage.ts`](https://github.com/cloudflare/agents/blob/2f3176b9fa03c6429c805b560c8dc14371c15f64/packages/agents/src/mcp/client/storage.ts) persists `transport.headers` inside `server_options` via `JSON.stringify`.
- **Consequence:**
  - Use one DO per `tenant:user` (or `tenant:integration`) for MCP connections, plus envelope encryption through the storage adapter.
  - Never pass platform keys, such as Composio's project `x-api-key`, as MCP headers.
  - Whether Cloudflare encrypts DO storage at rest is **(unverified)**; a docs search found no statement.

#### C11 — Hyperdrive caching

- **05** (Hyperdrive row): lists "pooling and cache included" as a plain feature.
- **08** ("Postgres via Hyperdrive"; risk 1): caching is on by default, writes don't invalidate it, and the key is undocumented, so tenant data should go through a cache-disabled binding.
- **Verdict: 08 is right; 05 leaves out a multi-tenant risk. This is an omission, not a strict contradiction. Verified.** [Query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/) (2026-07-05):
  - "Query caching is enabled by default".
  - Hyperdrive "does not purge or invalidate cached read query results when your application writes".
  - Defaults are `max_age` 60 s and `stale_while_revalidate` 15 s.
  - The page recommends a cache-disabled configuration for "authentication, sessions, permissions, billing state, admin settings".
  - It does not document how the cache key is built.
- **Consequence:** adopt 08's rules: an explicit `tenant_id` parameter and a cache-disabled binding for tenant data. Whether reads inside an explicit transaction are cached, which matters for 08's `set_config` RLS pattern, is **(unverified)**.

#### C12 — GitHub write rate limits for the versioning worker

- **08** ("GitHub as the source of truth: facts that size the design → Rate limits"): 80 content-generating requests per minute and 500 per hour, probably shared per installation (its own inference). It recommends GraphQL `createCommitOnBranch`.
- **05** (risks; cost assumptions): "1 commit per hour per agent"; GitHub limits "(unverified)".
- **02** (§3.6): commits via the Git Data API "(not verified in this session)".
- **Verdict: 08's numbers hold for REST and GraphQL; scope is undocumented. Verified.**
  - [REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api): "No more than 80 content-generating requests per minute and no more than 500 content-generating requests per hour". The same page gives installations 5,000 requests per hour, scaling to 12,500 (15,000 on Enterprise Cloud).
  - [GraphQL limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api) repeats the 80/500 limit and scores mutations at 5 secondary points.
  - Neither page says whether a mutation counts as "content-generating" (it almost certainly does) or whether the limit is per user, app or installation **(unverified)**.
- **Consequence:**
  - Design for **≤ 500 commits per hour per installation as a global ceiling** if every tenant repo shares one installation. 05's one commit per hour per agent fits up to about 500 agents per installation.
  - The Git Data API needs N+3 writes per commit; `createCommitOnBranch` needs one mutation. Use the mutation, as 08 says.
  - Letting each tenant install the App in its own org probably separates the budgets (inference).

#### C13 — Vectorize limits (no real contradiction)

- **02** (§3.6): "50,000 namespaces per index on the paid plan (another page still says 1,000)".
- **08** (vector table): 20M vectors per index on the limits page vs 10M in the January 2026 changelog.
- **Verified** on [Vectorize limits](https://developers.cloudflare.com/vectorize/platform/limits/) (2026-08-05):
  - namespaces: 1,000 on Free and 50,000 on Paid, so 02's "1,000" is the Free figure;
  - 20,000,000 vectors per index, which supersedes the 10M changelog;
  - 10 metadata indexes, 64 bytes indexed per string, topK 50 with metadata and 100 without.

#### C14 — Secrets Store (no inter-file contradiction)

- 03, 05 and 07 agree: open beta, 100 secrets and one store per account.
- **Verified** on [Manage secrets](https://developers.cloudflare.com/secrets-store/manage-secrets/) (2026-09-25): "up to 100 secrets per account", "only one store per account", 65,536 bytes per secret.
- Use it for platform secrets such as the KEK and provider keys, never for per-tenant secrets.

#### C15 — Cloudflare Artifacts (no inter-file contradiction)

- 05 (TL;DR item 6, R17) and 08 ("(B)", "R2, isomorphic-git and Artifacts") agree: open beta since 2026-10-01, billed from 2026-10-14, Workers Paid only, 1 GB per repo, writes only via git smart HTTP.
- **Verified** on the [Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/) (2026-10-01):
  - namespace methods: `create`, `get`, `list`, `import`, `delete`;
  - repo methods: `info`, token methods, `fork`, `log`, `readCommit`, `readTree`, `readBlob`, `readFile`;
  - **no write or commit method.**
- **Dates verified:** the [open-beta changelog](https://developers.cloudflare.com/changelog/post/2026-10-01-artifacts-open-beta/) is dated October 1, 2026, and [Artifacts pricing](https://developers.cloudflare.com/artifacts/platform/pricing/) says "Cloudflare will begin billing for Artifacts operations and storage on October 14, 2026."

#### C16 — Alarm concurrency inside a DO (no real contradiction)

- **06** (§9.1): "Alarms can run concurrently with other requests to the same DO". **05** ("Concurrency"; "Hard cases"): the DO is single-threaded with input/output gates, and work interleaves only at `await` points.
- **Verified:** [Changelog 2026-08-25](https://developers.cloudflare.com/changelog/post/2026-08-25-durable-object-alarm-abort-no-retry/): "Alarms can run concurrently with other requests to the same Durable Object." The Alarms API adds: "Only one instance of `alarm()` will ever run at a given time".
- These are compatible: JavaScript stays single-threaded, but an alarm handler interleaves with RPCs at awaits. Both notes already prescribe re-checking `generation` after every `await`. Keep that as a hard rule, with a test.

### 1B. Contradictions already resolved by another note

| Topic | Unverified or weaker claim | Resolved by | Notes |
|---|---|---|---|
| Unit of the Hermes memory "nudge" | 02 §2.2 (Hermes bullets): "(not verified in the code)" | 01 §3: code-verified. Memory counts user turns (`turn_context.py#L745-L754`); skills count tool iterations (`turn_finalizer.py#L737-L743`) | — |
| Does Composio expose remote MCP? | 01 (table "What to bring / what does not map to serverless", Composio row; Risks): (unverified) | 03 "MCP offering": yes, `session.mcp.url` + `headers` | The header carries the project-wide `x-api-key`. Don't persist it via `addMcpServer` (C10) |
| Typing TTLs per channel | 05 "Step by step and decisions" step 7(b): all (unverified) | 06 §1.1, §2, §3.3, §4: Telegram ≤5 s, Discord 10 s, WhatsApp 25 s (and it **marks as read**), Slack has no typing; `setStatus` lasts 2 min | WhatsApp 25 s re-confirmed on [Meta typing indicators](https://developers.facebook.com/docs/whatsapp/cloud-api/typing-indicators) |
| Discord without the Gateway | 05 R3: "Discord Interactions" as the webhook alternative | 06 §3.1: Interactions carry no normal messages; free text needs the Gateway | So the debounce requirement on Discord needs the Gateway DO (C1, C3) |
| Slack Socket Mode | 05 R3 / Risks: "Slack Socket Mode" as a socket risk | 06 §4: the HTTP Events API is enough | — |
| `Agent.schedule()` multiplexing | 06 §9.1: "(unverified in this research)" | 05 "Agents SDK" table: verified (Agent class, v0.8.0) | — |
| GitHub commit primitive | 02 §3.6: Git Data API (not verified in this session) | 08: `createCommitOnBranch` (one call, `expectedHeadOid`) | See C12 |
| Subscription login | 01 TL;DR item 10 and §7: Hermes supports Anthropic OAuth ("Max + extra credits") | 07 §1: prohibited by Anthropic; the OpenAI SIWC terms forbid remote token storage | The Anthropic quote is **verified** on [legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance): "developers may not collect, store, or intermediate Claude.ai credentials or session tokens". The OpenAI SIWC terms page returned HTTP 403 to me, so 07's reading stands **(unverified by me)** |
| Analytics Engine price | 05: "unverified" | 08: announced but **not billed today** | — |
| R2 object versioning | 05: "not found in the doc" | 08: `PutBucketVersioning` / `ListObjectVersions` not implemented | Consistent |

### 1C. Design conflicts that are not factual (owner decisions)

These can't be settled by fetching documentation. Each needs a decision, ideally recorded as an ADR.

1. **Where user memory and profiles live.** Both options keep PII out of git and **both break the "user profiles versioned in GitHub/Obsidian" requirement** (§3 row 13).
   - 02 (§3.1 layout; §6 item 2): `.md` files in R2 plus a DO per `tenant×user`, with Vectorize for retrieval and supersession chains as versioning.
   - 08 ("Recommendation (A)"; LGPD option 1): rows with revisions in Postgres plus pgvector, exposed as virtual `.md` files by the Context Store; erasure is a single transactional `DELETE`.
   - **Recommendation:** if Postgres is in scope anyway (requirement "database beyond D1"), 08's option gives one-step transactional erasure. 02's option fits a "100% Cloudflare" profile.
2. **Vector store.** Vectorize with a namespace per tenant (02 §3.6; 04 table, row d; 05 `memory-jobs`) vs pgvector by default with Vectorize optional (08 "Vectors: Vectorize vs. pgvector"). This follows from decision 1.
3. **Debounce parameters.** Pick one configuration table per channel, with a hard cap measured from the first fragment.

   | Source | Values |
   |---|---|
   | 01 ("What to bring / what does not map to serverless", batching row) | WhatsApp 3–5 s |
   | 04 §4.2 | speculative Jev call at T₁ 1.0–1.5 s, T_max 6–8 s, absolute cap 10 s; fallback 2.5 s, max 8 s |
   | 05 ("Step by step and decisions" step 3) | 2–4 s, `max_wait` 15 s |
   | 06 §9.2 | WhatsApp 3–5 s; others 1.5–2 s; webchat 1–1.5 s; cap 10–15 s |

4. **Bubble pacing and how the outbox drains.**
   - 05 steps 6–7: Δt of 30–50 ms per character, clamped to 1.5–6 s, with in-memory timers inside the fiber.
   - 06 §9.1 and §9.3: 800 ms + 20–30 ms per character, clamped to 0.8–4 s; the outbox drains by alarm; at most 3–4 bubbles on WhatsApp.
   - **05 ignores WhatsApp's pair rate limit.** It is verified on the [Cloud API overview](https://developers.facebook.com/docs/whatsapp/cloud-api/overview): "1 message every 6 seconds to the same WhatsApp user", a 45-message burst that "borrows" from future quota, error 131056, retry after 4^X s.
   - **Recommendation:** in-memory timers during the active turn (cheap; outbox status makes it recoverable), a per-recipient token bucket in the DO, and per-channel bubble caps.
5. **Context Store DO granularity.**
   - 02: a DO per `tenant×agent` for the derived index, plus a DO per `tenant×user`.
   - 05: a `RepoDO` per `(tenant, repo)`.
   - 08: a `TenantContextDO` per tenant.
   - With one repo per tenant, 05 and 08 are the same design; 02's per-agent DO is a retrieval index, a separate concern. Watch the DO soft limit of 1,000 req/s for large tenants.
6. **How broadly Jev is used in the memory path.**
   - 02 §3.4–§3.5 puts Jev in the hot path: a `noul`, then a rubric `score` per candidate, then a `choice`. 04 rule 1 allows **one** synchronous fan-out call per turn, so 02's retrieval questions must be folded into that single call.
   - 02 also proposes Jev as the **PII gate** ("Does the text contain personal data (and of what category)?"). That sends the very PII it is screening to a US third party, which 04 §2.4 says to minimise. Use a local regex/sanitizer gate first, and send Jev only what has already been masked.

---

## 2. Load-bearing claims that are still unverified, ranked by impact

### 2A. Top five, which I checked myself

| Rank | Claim (source) | Impact if wrong | Result |
|---|---|---|---|
| 1 | Jev throughput and billing through Cloudflare (04 §2.1, §2.2: "unverified") | Decides whether Jev can be the hot-path default for many tenants | **Verified: capped** at 200 req/60 s per gateway under Unified Billing, plus a 5% fee (C4). An OpenRouter path with no waitlist exists (C7). OpenRouter's rate limit for Jev remains **(unverified)** |
| 2 | Outbound WebSocket beyond 15 min (05 R3; 06 §3.2) | Viability and cost of Discord free text | **Verified:** keeps the DO alive for at most 15 min, then the connection continues but no longer prevents eviction (C3). Whether inbound frames reset the idle timer is **(unverified)**; needs a spike |
| 3 | A scheduled alarm doesn't block hibernation (05) | 05's whole cost baseline | **Supported** by the lifecycle and Alarms pages (C2). No explicit sentence says so; confirm with metrics |
| 4 | GitHub content limits: scope and GraphQL coverage (08, inference) | Batching floor and tenant ceiling of the versioning worker | **Verified:** 80/min and 500/h listed for REST and GraphQL. **(unverified):** the scope, and whether mutations count. Design for 500/h shared |
| 5 | Re-sending the WhatsApp typing indicator extends it between bubbles (06 §1.1, "unverified in Meta's docs") | Whether the "typing between bubbles" requirement works on WhatsApp | **Meta docs are silent (verified absence).** The indicator is "dismissed once you respond", so it disappears with the first bubble. Showing it again before bubble 2 depends on re-sending `status: read` + `typing_indicator` for the same inbound `message_id`. Twilio says re-sending extends it (06 §1.3, secondary). **(unverified):** needs a test-number spike. Also: every typing call marks the message as read |

### 2B. Still unverified, in decreasing impact

6. **Jev accuracy and calibration in informal PT-BR** (04 §2.5). No measurement exists; Spanish proxies show −3 to −6 pp and about 2× worse ECE. This decides whether Jev can close the turn, route skills and pick tools by default. A labelled PT-BR set per decision is needed before automatic mode.
7. **Jev latency from Brazil** (04 §2.3: Brazil–US West RTT not measured). This sets the hot-path budget. 04 assumes 0.4–0.6 s per call.
8. **GPT-6 tool calling requires the Responses API, and Responses streams through AI Gateway passthrough** (07 §2.1, §2.4). There is partial support: Cloudflare's [pi-ai provider page](https://developers.cloudflare.com/agents/models/pi-ai/) routes OpenAI models as an "AI Gateway universal request to v1/responses" and parses "the vendor's response stream" **(not directly verified)**.
9. **Discord Gateway DO keepalive and cost in practice** (06 §3.2, §3.4). See C3.
10. **Hyperdrive behaviour inside transactions and how its cache key is built** (08). This matters for RLS via `set_config`. See C11.
11. **Whether Cloudflare encrypts DO storage at rest** (03 "Encryption"). Application-level envelope encryption is needed regardless.
12. **WhatsApp multi-tenant onboarding: Tech Provider status, App Review and test-number limits** (06 §1.1). Calendar time and requirements are unmeasured; the "5 recipients" limit comes only from a third-party source.
13. **Slack OAuth v2 multi-workspace install** (06 §4: "(unverified in this research)").
14. **Composio SDK details in Workers** (03): `pusher-js` in workerd, `@composio/typesafe` needing Node ≥24.17, the purpose of `@composio/cloudflare`.
15. **isomorphic-git pushing from a Worker to Artifacts, and obsidian-git against an Artifacts remote** (08). These matter only if Artifacts becomes canonical.
16. **Pinning the Jev version on the Cloudflare binding** (04 §2.1). TypeSafe recommends pinning once thresholds are calibrated.
17. **The exact text of LGPD art. 18** (02, 08 used secondary sources; Planalto was unreachable).
18. **Whether DO RPC counts toward the 32-invocation service-binding limit** (05 R7). Low impact at the planned depth of 3–4 hops.

---

## 3. Requirement-by-requirement viability

Verdicts: **Viable**; **Viable with changes**; **Not viable as stated**.

| # | Requirement | Verdict | Change needed | Supporting files |
|---|---|---|---|---|
| 1 | Multi-tenant | Viable with changes | Tenants are data, not code; every DO key and every query carries `tenant`. Per-tenant secrets use envelope encryption because the Secrets Store caps at 100 (C14). Several ceilings are shared by all tenants and must be budgeted: Unified Billing 200 req/min per gateway (C4), Composio org-wide 2k/10k per min, GitHub 500/h per installation (C12), 20 AI Gateway gateways. Hyperdrive tenant reads need a cache-disabled binding (C11); MCP tokens need a DO per subject (C10) | 03, 05 R12–R14, 07 §2.3, 08 |
| 2 | Multi-agent (agents orchestrating agents, group rooms) | Viable | `Agent` sub-agents and `agentTool`, Workflows for long tasks. Conversations stay top-level DOs because facets have no alarm of their own. Patterns come from Hermes delegation and Bot Mode rooms | 01 §7, §8; 05 "Agents SDK", R13 |
| 3 | Mostly Cloudflare, no containers | Viable with changes | Drops MCP stdio, git CLI, Baileys, Obsidian Headless and local terminal tools. External dependencies remain: Postgres (Neon) if chosen, and Jev, Composio and LLM APIs | 05 R1–R19; 03; 08 |
| 4 | Event-driven | Viable | Webhook → ingress → DO for ordering and dedupe. Queues only for idempotent side effects (no ordering guarantee). Workflows for long or human-in-the-loop work | 05 "Proposed event-driven flow" |
| 5 | Debounce of fragmented messages | Viable | DO alarm re-armed per fragment, with a hard cap; never `setTimeout` (C2). An optional Jev hybrid is subject to C4. The Vercel Chat SDK debounce is a non-durable `sleep` and shouldn't be used. Debounce on Discord requires the Gateway | 04 §4.2; 05 step 3; 06 §8.2, §9.2; 01 |
| 6 | One reply split into paced bubbles with typing | Viable with changes | Own splitter, outbox and `generation` counter (neither Hermes nor the Chat SDK does this). WhatsApp: pair limit → at most 3–4 bubbles plus a token bucket; typing marks as read; re-sending typing between bubbles is unverified (§2A #5). Slack has `setStatus` instead of typing | 05 steps 6–7; 06 §9.3–§9.4; 01 §6; 1C item 4 |
| 7 | Channel: WhatsApp | Viable with changes | Official Cloud API only, no Baileys (ToS). Multi-tenant requires Tech Provider status and App Review. Meta Terms §4.7 forbid general-purpose AI-provider bots, so position the product as business bots. 24 h service window; BSUID as the contact key; download media within 5 min | 06 §1 |
| 8 | Channel: Telegram | Viable | Webhook with a per-tenant `secret_token`; renew typing every ~4 s; ≥1 s between messages | 06 §2 |
| 9 | Channel: Discord | Viable with changes | Free text (and therefore debounce) needs the Gateway WebSocket in an always-on DO, with a mandatory watchdog alarm and RESUME. Cost is about 324k GB-s per bot per month, billed in US$ 12.50 steps (C1, C3). Alternative: Interactions only, with no free text | 06 §3; 05 R3 |
| 10 | Channel: Slack | Viable | HTTP Events API (3 s ack); `assistant.threads.setStatus` as the "thinking" signal; 1 msg/s per channel; keep history in the DO because non-Marketplace apps face history limits. Multi-workspace OAuth is unverified | 06 §4 |
| 11 | Channel: webchat | Viable | DO WebSocket Hibernation (`AIChatAgent` or our own), Turnstile + short JWT; typing in both directions | 06 §5 |
| 12 | Persona, skills and agent memory as versioned, human-editable `.md` | Viable with changes | One private GitHub repo per tenant via a GitHub App; working copy in a DO; batched `createCommitOnBranch` with `expectedHeadOid`; push webhook plus reconciliation cron (GitHub doesn't redeliver). Persona and skills change only through PRs | 02 §3, §4; 05 `context-store`; 08 (B) |
| 13 | User profiles as versioned `.md` in GitHub/Obsidian | **Not viable as stated** | LGPD/GDPR erasure conflicts with immutable git history (forks, caches, GitHub Support for purges). Keep profiles outside git as virtual `.md` with deletable revisions (1C item 1). The alternative, crypto-shredded files in git, is not readable or diffable in Obsidian. Owner decision | 02 §3.0, §5.3, §6 item 2; 08 "LGPD/GDPR" |
| 14 | Editable in Obsidian | Viable with changes | obsidian-git against the tenant repo, desktop only (mobile is "very unstable"). Obsidian Sync/Headless needs Node and can't run in Workers. The `users/` subtree does not appear in the vault | 08 "Obsidian: what exists in 2026" |
| 15 | Dedicated versioning worker | Viable with changes | The Context Store worker is the only path to GitHub. Commit batching is sized to 80/min and 500/h (C12). Artifacts is an optional backend: beta, with no write method on the binding (C15) | 05; 08 "Context Store worker design" |
| 16 | Tools via Composio | Viable with changes | Behind our own `ToolProvider`, in "harness integration" mode. Accept token custody with no export (lock-in), a rate limit shared across the org, and no SDK retries on execute. Don't route `session.mcp` through `addMcpServer` | 03 "Composio" |
| 17 | Any MCP server | Viable with changes | Remote only (Streamable HTTP or SSE), through the Agents SDK client; stdio servers need a bridge the user brings (36.1% of registry entries are package-only). A DO per subject plus encryption, because tokens are stored in plaintext (C10) | 03 "MCP without containers"; 05 R1 |
| 18 | Jev as the default qualifier | Viable with changes | "Default when configured"; the zero-key install falls back to heuristics. One fan-out call per turn with a short timeout and a circuit breaker. Choose the access path deliberately: Cloudflare binding (200 req/min per gateway, 5% fee, ZDR), TypeSafe direct (80 req/s, no ZDR below enterprise), or OpenRouter (no waitlist; limits unverified). Budget 32k context (C4, C6–C8). PT-BR is unmeasured. The MCA forbids distilling Jev into a replacement | 04; 02 §3.5; 03 |
| 19 | OpenAI and Anthropic via API key | Viable | Native adapters (Anthropic Messages, OpenAI Responses) through AI Gateway passthrough, with the tenant key sent per request and `byok_only` on. Fallback lives in the `ModelRouter`, not Dynamic Routing (C5). BYOK for OpenAI is a contractual grey zone | 07 §2, §5 |
| 20 | OpenAI and Anthropic via subscription login | **Not viable as stated** | Anthropic prohibits it (verified). OpenAI's SIWC terms require tokens stored locally and a runtime only the user controls (07; page not reachable by me). Alternative "connect your account": OpenRouter OAuth PKCE (07 §1.4) | 07 §1; 01 TL;DR item 10 |
| 21 | A database beyond D1 | Viable | Postgres via Hyperdrive, Neon by default with PlanetScale as the upgrade path. Explicit `tenant_id`, cache-disabled binding for tenant data, RLS as defence in depth. DO SQLite holds hot state | 08 (A); 05 R11 |
| 22 | Management UI inspired by Hermes Bot Mode | Viable with changes | Bot Mode is an archived React plugin for the desktop app over local profiles, so reuse UX patterns only. Add what it lacks: tenant switcher, RBAC, audit log, approval queue, per-channel debounce and pacing settings, credential status. Admin authentication (Access vs OIDC) was not researched | 01 §8, "Ideas for the management UI"; 05 `admin-ui` row |
| 23 | Public open-source portfolio (implicit) | Viable with changes | Zero-key install (`HeuristicQualifier`, `FakeQualifier` in CI); WhatsApp demo on a test number with one tenant; synthetic fixtures only; README states why subscription login and Baileys are excluded | 04 §5; 06 §1.2, §10; 07 §1.4; 02 §5.6 |

---

## 4. Gaps: important questions none of the notes answered

1. **End-to-end latency budget for one WhatsApp turn.** No note adds up the pieces: debounce (2–5 s) + Jev fan-out (0.4–0.6 s, unmeasured from Brazil) + LLM time to first token and total (unmeasured) + the first typing burst + bubble pacing under the 6 s pair limit. A target such as "first bubble ≤ 8 s p95" and a measured breakdown are missing.
2. **Voice notes and media.** Audio messages are extremely common on WhatsApp in Brazil. No note designs the speech-to-text pipeline (Workers AI ASR model, cost, latency, PT-BR quality) or image understanding (which model, size limits, routing). 06 covers only download and R2 storage.
3. **Cost and ceilings at larger scale.** Only one scenario is costed: 1 tenant, 3 agents, 2k messages/day (05). No note models 50–100 tenants. That is where the shared ceilings bite: Unified Billing 200/min per gateway, Composio org-wide limits, GitHub 500/h per installation, Discord DO duration steps, Jev about 20 fan-out calls/s per TypeSafe account (04 §2.2).
4. **Admin authentication and the RBAC model.** 01 lists ideas and 05 says "Access ou OIDC". Nobody researched tenant-admin sign-up, invites, role model, audit, or how end users see and correct their own memory (an LGPD access right).
5. **Tenant onboarding per channel, end to end.** Telegram is trivial (06). WhatsApp Embedded Signup requires Tech Provider status (calendar time unknown). Slack OAuth is unverified. Discord is "bring your own bot" vs a shared app. Nobody wrote the onboarding UX or state machine.
6. **Data residency and international transfer.** Partly covered: Artifacts region, D1 jurisdiction (08), TypeSafe in the US (04). Nobody checked **DO jurisdiction controls** for conversation state, or LLM provider data-retention and ZDR terms for OpenAI and Anthropic in multi-tenant use.
7. **Test strategy for the harness itself.** The notes recommend golden sets for Jev and memory (02 §4.4, 04 §5.3) but don't cover contract tests against recorded channel payloads, deterministic tests for the debounce, interrupt and outbox races, or a local workerd test harness for alarms and fibers.
8. **Observability of a turn across workers.** Trace propagation through ingress → DO → llm-gateway → tools-gateway → egress; per-turn cost attribution; PII redaction in logs. Partly touched in 05 and 07, but not designed.
9. **Proactive messaging policy.** Follow-ups outside the 24 h window need paid templates (06 §1.1). Nobody designed template management, opt-in tracking or a per-tenant cost cap.
10. **Abuse and spam controls for public channels and groups.** Per-user rate limits (07 §4), moderation before waking the agent (04 §4.4), and a message budget per anonymous user are mentioned but never assembled into a policy.
11. **Licence and attribution of borrowed patterns.** Hermes and ai-memory are MIT (01, 02). OpenClaw's licence and the reuse of its chunker or queue semantics were not checked; neither were licence notices for copied prompts (01 §3 suggests copying Hermes review prompts "almost verbatim").
12. **Agents SDK upgrade cadence vs version pinning.** 05 recommends pinning, but `agents` went from 0.20 to 0.26 between July and October 2026 (03, 05). There is no policy for security fixes, and no check of whether `keepAlive` or fibers changed semantics between those versions.

---

### Corrections the note authors should apply (not applied here: read-only)

- **06:** in the TL;DR (Discord row), §3.4 and §10 item 6, replace "≈ US$ 4/month per bot" with "US$ 12.50 per started 1M GB-s above 400k (step billing)" (C1). In §3.2, add the 15-minute cap from the 2026-06-19 changelog (C3).
- **02:** in §1.8, OpenRouter `/api/alpha/decisions` uses the same named map + `criteria` (C6). Jev's context is 64k/32k on TypeSafe and 32k on Cloudflare and OpenRouter (C8). The blog date is 2026-09-15 (C9).
- **04:** add the OpenRouter path for `typesafe/jev-1.13`, which has no waitlist (C7). Add the Unified Billing cap of 200 req/60 s per gateway to §2.1, §2.2 and §5.3 (C4).
- **05:** replace "fallback via Dynamic Routing" with a `ModelRouter` (C5). In the MCP client row, note that tokens are stored in plaintext (C10). Add a Hyperdrive cache warning (C11). Add the WhatsApp pair limit to the pacing step (1C item 4).
