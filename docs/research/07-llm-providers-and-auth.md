> Research note written on 2026-10-03 for the Kelpie viability study, translated from Portuguese. Corrections across notes are tracked in [00-cross-check.md](00-cross-check.md).

# 07 — LLM providers, authentication and cost control

> Research done on **2026-10-03**. All sources were accessed on that date. Terms of use and prices change fast (Anthropic changed its position three times in 2026, and "Sign in with ChatGPT" for third parties was released on 2026-09-29). Before implementing, check the primary sources again.
> Conventions: **(primary)** = official term, policy, doc or announcement read in this session. **(secondary)** = press or blog. **(unverified)** = not confirmed in a primary source.

---

## TL;DR

- **Subscription login (Claude Pro/Max, ChatGPT Plus/Pro) in a hosted multi-tenant harness: no.** Both companies prohibit this today, in writing:
  - Anthropic prohibits third parties from offering Claude.ai login and from storing session tokens ([legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance)).
  - OpenAI's Sign in with ChatGPT (SIWC) terms require two things: the token stored **locally, under the user's control**, and a runtime that **only that user controls**. They also prohibit another person's activity from triggering requests on the user's account ([SIWC Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/)).
  - A group-channel bot running on Durable Objects violates both rules.
- **Self-hosted single-user mode with the user's own subscription, on Workers: also no.**
  - Anthropic: subscription OAuth is only for Claude Code and Anthropic's native apps. The existing exception covers the *unmodified Claude Code binary*, which does not run on Workers without a container.
  - OpenAI: storing the refresh token in a DO or in KV counts as a "remote or managed environment", which the terms forbid.
  - Technically it is trivial (PKCE + refresh in a DO). The blocker is permission, not technology.
- **What can be offered safely:**
  1. Operator keys in hosted mode, with per-tenant metering.
  2. The deployer's own keys in self-hosted mode.
  3. **Per-tenant BYOK**, as a documented **gray-area** option: OpenAI says sharing an API key violates the Terms of Use.
  4. Optionally, **OpenRouter's OAuth PKCE**. It is an official "connect your account" flow: the user pays and the key stays under their control.
- **Recommended abstraction:** a thin, in-house `LlmProvider` interface, with **native** adapters: Anthropic Messages and OpenAI **Responses**.
  - No lowest common denominator via Chat Completions. On GPT-6 Astra and GPT-6.1 Sol, tool calling requires the Responses API ([GPT-6 guide](https://developers.openai.com/api/docs/guides/latest-model)).
  - Traffic goes through **Cloudflare AI Gateway** in native *passthrough* mode (logs, retries, spend safety net), with the tenant's key sent per request and `byok_only` turned on.
  - Model routing sits **above** the providers, in the harness core.
  - AI SDK v7 is an acceptable alternative for implementing the adapters.
- **Cost:** the authoritative budget lives in a per-tenant DO: it pre-authorizes against the worst case and reconciles against the real `usage`.
  - AI Gateway *spend limits* (at most 20 rules, eventually consistent) serve only as a global safety net.
  - Watch the cache accounting, which differs between providers. On Anthropic the cache fields are **added** to `input_tokens`. On OpenAI they are a **subset** of `input_tokens`.

---

## 1. Subscription login

### 1.1 Anthropic (Claude Free/Pro/Max via OAuth)

**What Claude Code does (primary):**
- Claude Code authenticates via OAuth in the browser.
- `claude setup-token` generates a **one-year** OAuth token, used as `CLAUDE_CODE_OAUTH_TOKEN`. It requires a Pro, Max, Team or Enterprise plan and is meant "for CI and scripts" of Claude Code *itself* ([Authentication](https://code.claude.com/docs/en/authentication)).

**Current policy: operative text, read on 2026-10-03 (primary).** Page [Legal and compliance → Authentication and credential use](https://code.claude.com/docs/en/legal-and-compliance):
- OAuth is "exclusively" for subscribers. It was designed for ordinary use of Claude Code and other native Anthropic apps.
- Anyone building products, **including with the Agent SDK**, must use an API key from the Console or from a cloud provider.
- Anthropic does not allow third parties to offer Claude.ai login in their own apps.
- It also does not allow routing requests through Free/Pro/Max credentials on behalf of users.
- Decisive passage: *"developers may not collect, store, or intermediate Claude.ai credentials or session tokens"*. The login has to happen through Anthropic's own flow.
- Anthropic may enforce these rules "without prior notice".
- **Exception:** an end user may sign in with their own subscription on the **unmodified Claude Code binary**, including when a platform hosts Claude Code. The conditions are:
  - accept the Commercial Terms;
  - do not remove authentication methods;
  - do not pay for, resell or intermediate the usage. Each user authenticates with their own credential.
- The same page says the advertised Pro/Max limits assume "ordinary individual use" of Claude Code and the Agent SDK.

**Agent SDK (primary):** [overview](https://code.claude.com/docs/en/agent-sdk/overview)
- Passage: Anthropic does not allow third parties to *"offer claude.ai login or rate limits for their products"*, unless previously approved.
- The SDK is a library that **runs the Claude Code binary**.
- Use is governed by the [Commercial Terms](https://www.anthropic.com/legal/commercial-terms) (in effect since 2025-06-17). They allow using the API to "power products and services" offered to customers and end users, and forbid unapproved resale.

**Consumer Terms (primary, in effect since 2025-10-08):** [consumer-terms](https://www.anthropic.com/legal/consumer-terms)
- They prohibit automated access (bot, script), except through an Anthropic API key or with explicit permission.
- They prohibit sharing account credentials.

**2026 timeline:**

| Date | Event | Source |
|---|---|---|
| ~2026-01-09 | Server-side blocks against subscription OAuth tokens used outside Claude Code (OpenCode, Cline, Roo and others). There are reports of client fingerprinting. | (secondary) [The Register](https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access/); technical details (unverified) |
| 2026-02-20 | Docs updated: using Free/Pro/Max OAuth tokens "in any other product, tool, or service — including the Agent SDK" becomes an explicit violation. Anthropic called this a clarification of existing policy. OpenCode removed support, citing a legal request. | (secondary) [The Register](https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access/) |
| 2026-04-04 | Broad "enforcement" | (unverified) |
| 2026-05-13 | Announcement of a monthly "Agent SDK credit", starting 2026-06-15, covering the Agent SDK, `claude -p`, GitHub Actions and "third-party apps built on the Agent SDK". Amounts announced: US$20 (Pro) to US$200 (Max 20x). | (secondary) [post @ClaudeDevs](https://x.com/ClaudeDevs/status/2054610152817619388), [GIGAZINE](https://gigazine.net/gsc_news/en/20260514-anthropic-claude-agent-sdk-credits/); amounts (unverified) |
| 2026-06-15 | **Change paused.** The Agent SDK, `claude -p` and third-party app usage keep consuming the normal subscription limits. The credit "is not available". | (primary) [Support: Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), updated 2026-06-16 |

**Interpretation (my reading, not legal advice):**
- The tolerance of May and June does not reverse the prohibition for our case. It covers apps that authenticate **"through the Agent SDK"**, that is: they run the Claude Code binary and the user logs in through Anthropic's flow.
- A harness on Workers **without a container** does not run that binary. Using the subscription token in it means calling the Messages API directly with an OAuth token from the Claude Code client. That is exactly the "collect, store or intermediate" that the legal page prohibits, and in practice amounts to impersonating the Claude Code client.
- This also holds for self-hosted single-user mode with `CLAUDE_CODE_OAUTH_TOKEN`. OAuth is reserved for Claude Code and native apps.

### 1.2 OpenAI (ChatGPT Plus/Pro via "Sign in with ChatGPT")

**What exists today (primary):**
- **DevDay, 2026-09-29:** SIWC allows using the Plus/Pro allowance in 16 partners (Devin, Notion, Vercel, T3, OpenClaw, Dactyl and others), with control over how much each one consumes ([DevDay 2026 Recap](https://openai.com/index/devday-2026-recap/)).
- **For the user** ([Help: Using your ChatGPT plan in other apps](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites)):
  - requests count against the plan's "ChatGPT Work and Codex" usage;
  - a weekly limit can be set per app;
  - the app can use credits if the user allows it;
  - the app does not access the user's conversations.
- **Developer eligibility** ([SIWC cookbook](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt), [quickstart](https://developers.openai.com/siwc/quickstart), [open-source overview](https://developers.openai.com/siwc/token-sharing-open-source)):
  - Plan usage is available for open-source projects, personal projects that run locally and some selected private apps.
  - Passage: *"If you're building a paid or remotely hosted app, join the waitlist"* ([form](https://openai.com/form/sign-in-with-chatgpt-interest/)).
  - Identity-only sign-in is in a limited trial for selected commercial partners (quickstart).
- **Codex CLI** ([Auth](https://learn.chatgpt.com/docs/auth)):
  - login with ChatGPT stores the tokens in `~/.codex/auth.json`, with automatic refresh;
  - explicit recommendation: use an API key in programmatic flows, such as CI/CD.

**SIWC Terms (primary, dated 2026-09-29):** [sign-in-with-chatgpt-terms](https://openai.com/policies/sign-in-with-chatgpt-terms/). These are the decisive clauses:
- §1: tokens can only be obtained through the supported flow. Any persistent storage must be local and under the user's control. Passage: *"not in a remote or managed environment"*.
- §2: requests must come from the user's local runtime or from a remote runtime *that only they control*. Passage: *"Another user's activity must not trigger requests to the authenticated user's account."*
- §2: the plan can only be used in the connected app (no generic API access) and the user cannot pay you anything to use their own plan.
- §4: it is forbidden to pool, transfer, resell or share usage or tokens, and to use one user's subscription to serve another's requests.
- §6: OpenAI may suspend the app's access.

**SIWC technical details (primary):**
- Protocol: OIDC + PKCE, with a dynamic client (`client_id=dynamic_agent_client`) and a stable `ext_agent_host_id`.
- Scopes: `offline_access` and `chatgpt.tokens.use.direct`.
- Calls go to the Responses API (`https://api.openai.com/v1`) ([cookbook](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt)).
- Access token of 1 h. Refresh token of 30 days, **rotating** ([token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference)). Refreshes must be serialized per session ([profiles and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)).
- Preview limitations ([preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)):
  - `store:false` and `stream:true` are mandatory;
  - system messages are not accepted (use `instructions`);
  - no `temperature`/`top_p`;
  - no code interpreter, file search, hosted MCP or audio.
- SDKs: `@siwc/local` and `@siwc/react` (cookbook). I did not find `@siwc/local` published on npm on 2026-10-03.

**Position on API keys (relevant for BYOK, primary):**
- [Best Practices for API Key Safety](https://help.openai.com/en/articles/5112595-best-practices-for-api-key-safety): *"The sharing of API keys is against the Terms of Use."*
- [OpenAI Services Agreement](https://openai.com/policies/services-agreement/) (in effect since 2026-01-01):
  - allows integrating the services into "Customer Applications" and making them available to "End Users";
  - prohibits *"buy, sell, or transfer API keys from, to, or with a third party"*.

### 1.3 Technical feasibility on Workers (separate from permission)

| Piece | How to do it on Workers | Status |
|---|---|---|
| PKCE | `crypto.getRandomValues` for verifier and state; `crypto.subtle.digest('SHA-256')` for the challenge ([Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)) | feasible |
| Callback and code exchange | A route on the Worker and `fetch` to the token endpoint | feasible |
| Rotating refresh | One DO per credential. Since the DO runs one thing at a time, it meets the "serialize refreshes" requirement; *alarms* do the proactive refresh before 1 h | feasible |
| Storage | AES-GCM in the application, with the master key in a [Secrets Store](https://developers.cloudflare.com/secrets-store/integrations/workers/) binding or a Worker secret, and the ciphertext in the DO's storage | feasible |
| **Permission** | Anthropic: prohibited. OpenAI: the terms forbid persisting tokens in a remote or managed environment and require the waitlist for hosted apps | **blocker** |

### 1.4 Honest verdict for a public portfolio repo

| Mode | Anthropic | OpenAI | Recommendation |
|---|---|---|---|
| Hosted multi-tenant, **operator key** and per-tenant metering | Allowed: Commercial Terms, "power products… for end users" | Allowed: Services Agreement, "Customer Applications… End Users" | **Default for hosted mode** |
| Self-hosted, **the deployer's own keys** | Allowed | Allowed | **Default for self-host** |
| Hosted, **per-tenant BYOK** (the tenant pastes their key) | I did not find an explicit clause about credentials in the Commercial Terms (unverified in a full read) | **Gray area**: OpenAI says sharing a key violates the ToU and forbids "transfer API keys… with a third party" | Offer as a documented option, with a warning: the contractual risk belongs to the key owner |
| Hosted, subscription login | **Prohibited** | **Prohibited** without approval. Even if approved, §1 and §2 are incompatible with DOs and groups | **Do not implement** |
| Self-hosted single-user on Workers, subscription token | **Prohibited**: OAuth only for Claude Code and native apps | **Incompatible**: remote and managed storage | **Do not implement** |
| Single-user with a **local companion** (a process on the user's machine holds the token, makes the calls and only relays that user's activity) | Prohibited (same reason) | The SIWC terms allow it *if* requests leave from the local runtime and the token does not leave the machine. The project is also still open-source and eligible | Outside the "Workers only" scope. Possible future module, OpenAI only |
| "Connect account" alternative | — | — | **OpenRouter's OAuth PKCE**: the user creates a key under their own control and pays with their own credits ([docs](https://openrouter.ai/docs/use-cases/oauth-pkce)). Optional and future |

**How to document it in the README** (section "Provider authentication"):
- A "supported / not supported / why" table, with links to the sources and the verification date.
- One explicit sentence: *"Claude/ChatGPT subscription login is not supported, by a compliance decision"*, with the links above.
- No code that imitates the headers or the Claude Code client, no "claude-max" or "chatgpt-plus" provider and no hidden flag. For hiring managers, this shows judgment.
- For BYOK, explain that:
  - the key is encrypted and never goes to logs;
  - it is used only for that tenant's traffic;
  - the contractual decision belongs to the key owner.
- Optional future work, outside the "no containers" scope: an **unmodified Claude Code runner** in a container, where each user logs in through Anthropic's flow. This is the exception provided for on the legal page.

---

## 2. Provider abstraction on Workers

### 2.1 Facts that drive the choice

- **OpenAI: tool calling on current models requires the Responses API.**
  - GPT-6 Astra and GPT-6.1 Sol accept Chat Completions, but tool calling requires Responses.
  - GPT-6 Sol and GPT-6 Luna only do function calling in Chat Completions with `reasoning_effort: "none"`.
  - Source: [Using GPT-6](https://developers.openai.com/api/docs/guides/latest-model); confirmed on the pages for [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol) and [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna).
  - OpenAI recommends Responses for new projects, and Chat Completions remains supported ([migrate to Responses](https://developers.openai.com/api/docs/guides/migrate-to-responses)).
  - With `store:false`, the encrypted reasoning items must be resent (GPT-6 guide).
  - **Consequence:** any layer that normalizes everything to the Chat Completions format breaks tool calling on current OpenAI models. This includes AI Gateway's `/compat` and the dynamic routes, which only accept the chat format.
- **Anthropic:** Claude 4.7 and later models return **400** if `temperature`, `top_p` or `top_k` come with a non-default value ([deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations)).
  - Thinking is adaptive and "always on" on Opus 5.5 and Fable 5.1 ([models overview](https://platform.claude.com/docs/en/about-claude/models/overview)).
  - Thinking blocks must be preserved in the tool loop (unverified in this session).
- **Prompt caching (the classic framing has changed):**

| | Anthropic | OpenAI (GPT-5.6 and later) |
|---|---|---|
| Activation | Automatic with `cache_control` at the top of the request, or up to 4 explicit breakpoints on blocks | On by default, with implicit breakpoints. Explicit mode via `prompt_cache_options.mode: "explicit"` + `prompt_cache_breakpoint` on blocks, **Responses only** |
| Write | 1.25× (5 min TTL) or 2× (1 h TTL) of the base input | **1.25×** of the input (before 5.6 there was no write charge) |
| Read | 0.1× (0.05× on Opus 5.5; 0.025× on Fable 5.1) | 0.1× (0.05× on GPT-6.1 Sol) |
| TTL | 5 min or 1 h | `ttl: "30m"` |
| Minimum | 512 tokens (5.x family); 4,096 (Haiku 4.5) | 1,024 visible tokens |
| Usage fields | `input_tokens` **+** `cache_creation_input_tokens` **+** `cache_read_input_tokens` (added together) | `cached_tokens` and `cache_write_tokens` **inside** `input_tokens` |
| Sources | [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [pricing](https://platform.claude.com/docs/en/about-claude/pricing) | [prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), [model pages](https://developers.openai.com/api/docs/models/gpt-6.1-sol) |

### 2.2 Comparison

| Criterion | **Vercel AI SDK v7** (`ai@7.0.127`) | **Cloudflare AI Gateway** | **OpenRouter** | **Thin in-house adapter** |
|---|---|---|---|---|
| Nature | Normalization library | Proxy/gateway: logs, cache, limits, BYOK, billing | Hosted aggregator (a third party in the data path) | Your own code over `fetch` or the official SDKs |
| Runs on Workers | Yes. Cloudflare documents use with `ai@^7`; the `agents/models/ai-sdk` provider is in **beta** ([docs](https://developers.cloudflare.com/agents/models/ai-sdk/)) | Native: `env.AI` binding and HTTP endpoints | Yes (HTTP) | Yes: `@anthropic-ai/sdk` and `openai` list Cloudflare Workers as a supported runtime ([anthropic](https://github.com/anthropics/anthropic-sdk-typescript), [openai](https://github.com/openai/openai-node)) |
| Tool calling | Yes, normalized | Native passthrough preserves everything. The unified chat format has the GPT-6 limitation above | Chat and Responses ([Responses API](https://openrouter.ai/docs/api/reference/responses/overview)) | Full, in the native formats |
| Streaming | Yes | Yes (passthrough) | Yes | Yes (parse SSE) |
| Structured outputs | Yes (Anthropic native `output_format`, OpenAI json_schema) | Passthrough | Yes (unverified per model) | Native |
| Prompt caching | `providerOptions.anthropic.cacheControl` with `ttl:'1h'`; `providerOptions.openai.promptCacheOptions` ([anthropic](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic), [openai](https://ai-sdk.dev/providers/ai-sdk-providers/openai)) | Passthrough preserves it. The Gateway's *response cache* is a different thing (exact match) | Forwards `cache_control`; sticky routing ([docs](https://openrouter.ai/docs/features/prompt-caching)) | Full control |
| Reasoning | `thinking: {type:'adaptive'}` and `effort` (Anthropic); `reasoningEffort` and `include: ['reasoning.encrypted_content']` (OpenAI) | Passthrough | Configurable `reasoning` | Full |
| Responses vs Chat | `openai(id)` uses **Responses** by default since AI SDK 5 | `/ai/v1/responses`, `/ai/v1/messages`, `/ai/v1/chat/completions` (since 2026-05-21); `/compat` **deprecated** for single-model calls ([REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/), [compat](https://developers.cloudflare.com/ai-gateway/usage/chat-completion/)) | **Stateless** Responses: `store:true` and `previous_response_id` return 400 | Use Responses |
| Future (Gemini, Workers AI, local) | `@ai-sdk/google`, `workers-ai-provider` | `env.AI.run('@cf/...')` and [custom providers](https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/) for compatible endpoints | Hundreds of models | A new adapter per provider |
| Cost | Free | Core features free; logs of new accounts (since 2026-09-24) follow Workers Logs pricing ([pricing](https://developers.cloudflare.com/ai-gateway/reference/pricing/)); Unified Billing charges **5%** on credits | 5.5% fee on credit purchases; BYOK at 5% above an allowance ([FAQ](https://openrouter.ai/docs/faq)) | — |
| Risks | Version churn (v5→v6→v7 in about 1 year); abstraction lags behind new features | See 2.3 | An additional third party with access to prompts; translation between formats | More code to maintain |

### 2.3 AI Gateway: what matters for multi-tenant

- **Credential precedence** ([Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/)):
  1. the provider key in the request;
  2. the BYOK key stored under the alias `default`;
  3. **Unified Billing**, on the operator's credits.
- **Consequence:** if the tenant's key is missing, the request **silently falls back to the operator's account**. To avoid this, turn on **Require provider credentials** (`byok_only: true`) or send `cf-aig-no-wholesale: true` (since 2026-09-14).
- **BYOK stored in the Gateway does not scale to one key per tenant:**
  - on the unified paths (binding and `/ai/v1/*`), only the alias `default` is consulted;
  - `cf-aig-byok-alias` works only in passthrough ([BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/));
  - the limit is 10 gateways (Free) or 20 (Paid) per account ([limits](https://developers.cloudflare.com/ai-gateway/reference/limits/)).
  - **Design:** the tenant's key stays encrypted in your storage and is sent **per request** on the passthrough endpoint (precedence 1).
- **Unified Billing:** limit of 200 req/60 s per gateway and a 5% fee. It does not work as a multi-tenant production path. It works for demo or dev.
- **Spend limits** ([docs](https://developers.cloudflare.com/ai-gateway/features/spend-limits/), since 2026-06-05):
  - scoped by model, provider or metadata (for example, `tenant_id`), with a 429 response when the limit is reached;
  - **at most 20 rules per gateway**;
  - **eventually consistent**, so a burst can overshoot the limit;
  - "best-effort" cost;
  - at most 5 metadata entries per request.
  - Use it as a **global safety net**, not as a per-tenant budget.
- **Response cache** (`cf-aig-cache-ttl`, `cf-aig-cache-key`, `cf-aig-skip-cache`) is an identical-response cache, different from the provider's prompt caching. In multi-tenant, **turn it off or include the tenant in the cache key** so responses do not leak between tenants.
- **Logs** store tenants' prompts. Define the policy: `cf-aig-collect-log: false` by default or DLP; document it in the privacy policy.
- **Retries:** `cf-aig-max-attempts` (up to 5), with backoff ([REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/)).

### 2.4 Recommendation

1. An **in-house** `LlmProvider` interface (section 5), with two **native** adapters:
   - `AnthropicMessagesProvider`;
   - `OpenAIResponsesProvider` (with `store:false` and resending of the encrypted reasoning items).
   - Implementation with `fetch` + the official SDKs' types, or with the SDKs themselves, which support Workers.
2. **Base URL pointing to AI Gateway in native passthrough**, with these endpoints:
   - `gateway.ai.cloudflare.com/v1/{account}/{gateway}/anthropic/v1/messages` ([example in the changelog](https://developers.cloudflare.com/changelog/post/2025-08-25-secrets-store-ai-gateway/));
   - `.../openai/responses`, with the OpenAI key in `Authorization` ([OpenAI provider](https://developers.cloudflare.com/ai-gateway/usage/providers/openai/)).
   - That page does not explicitly mention streaming through passthrough (unverified). If SSE does not work, the OpenAI adapter calls `api.openai.com/v1/responses` directly, and only Anthropic goes through the Gateway.
   - Configuration: the tenant's or operator's key in the header, `byok_only` on, logs off by default and metadata `{tenant_id, agent_id}`.
   - This way `cache_control`, the breakpoints and the reasoning reach the provider intact.
3. Using AI SDK v7 *inside* the adapters is acceptable and speeds up the third provider onward (Gemini, Workers AI). What is non-negotiable:
   - native formats;
   - a normalized `Usage` with cache reads and writes separate;
   - routing outside the providers.
4. Keep OpenRouter and the unified `/ai/v1/*` as optional adapters. They are not the main path.

---

## 3. Models and prices (October 2026, USD per million tokens)

### 3.1 Anthropic (primary: [models overview](https://platform.claude.com/docs/en/about-claude/models/overview), [pricing](https://platform.claude.com/docs/en/about-claude/pricing))

| Model | API ID | Input | Cache write 5m / 1h | Cache read | Output | Context / max output | Thinking |
|---|---|---|---|---|---|---|---|
| Claude Fable 5.1 | `claude-fable-5-1` | 10 | 12.50 / 20 | 0.25 | 50 | 1M / 128K | Adaptive, always on (default effort `high`) |
| Claude Opus 5.5 | `claude-opus-5-5` | 4 | 5 / 8 | 0.20 | 20 | 1M / 128K | Adaptive, always on (default `medium`) |
| Claude Sonnet 5.5 | `claude-sonnet-5-5` | 2 | 2.50 / 4 | 0.20 | 10 | 1M / 128K | Adaptive (default `high`) |
| Claude Haiku 4.5 | `claude-haiku-4-5-20251001` (alias `claude-haiku-4-5`) | 1 | 1.25 / 2 | 0.10 | 5 | 200K / 64K | Extended |

Notes:
- Batch has a 50% discount.
- The 1M context has standard pricing on 4.6 and later models.
- `inference_geo: "us"` charges 1.1×.
- The tokenizer from 4.7 onward produces about 30% more tokens for the same text.
- Web search: US$10 per 1,000 searches.
- IDs on Bedrock: `anthropic.claude-*-5-5`.
- Haiku 4.5 is "Active", with retirement "not before 2026-10-15". The policy is at least 60 days' notice ([deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations)), so do not hard-code it as the default cheap model.
- Sonnet 4.5 retires on 2026-11-30.

### 3.2 OpenAI (primary: [pricing](https://developers.openai.com/api/docs/pricing), [models](https://developers.openai.com/api/docs/models))

| Model | ID | Input | Cached input | Cache write | Output | Context / max output | Effort |
|---|---|---|---|---|---|---|---|
| GPT-6 Astra | `gpt-6-astra` | 10.00 | 1.00 | 12.50 | 50.00 | 1.05M / 128K | low…max |
| GPT-6.1 Sol | `gpt-6.1-sol` | 2.00 | 0.10 | 2.50 | 10.00 | 1.05M (max input 922K) / 128K | low…max (no `none`) |
| GPT-6 Luna | `gpt-6-luna` | 0.10 | 0.01 | 0.125 | 0.50 | 1.05M / 128K | none…max |

Notes:
- **Long context (more than 272K input tokens):** 2× on input and cache and 1.5× on output, charged on the whole request (model pages and the "Long context" table in pricing).
- Batch and Flex cost 50% of Standard. Fast costs 2×. Regional processing costs 10% more.
- DevDay presented GPT-6.1 Sol with "near-Astra" performance at one fifth of the price ([recap](https://openai.com/index/devday-2026-recap/)).
- Earlier models still listed in pricing (prices taken from the page summary, not checked line by line): `gpt-6-sol` 2/0.20/10, `gpt-5.6-sol` 4/0.40/20 (promotional price until at least 2026-11-21), `gpt-5.5` 5/0.50/30.

---

## 4. Multi-tenant cost control

**Where each thing lives:**

| Control | Mechanism | Reason |
|---|---|---|
| Per-tenant budget (authoritative) | **One `TenantBudget` DO per tenant**: balance, window and pending reservations | The DO is single-threaded and strongly consistent, so it does not overshoot under a burst |
| Pre-authorization | Before each call, reserve the **worst case**: estimated input tokens × price + `maxOutputTokens` × output price (+ long-context multiplier). Deny if the balance does not cover it | The Gateway's spend limits are eventually consistent |
| Reconciliation | On `finish`, compute the real cost from `usage` and release the difference | Corrects the estimate |
| Ledger | One row per call in D1 (tenant, agent, channel user, model, the 4 token counters, cost, `price_version`); aggregates in Analytics Engine (design suggestion) | Audit and billing |
| Rate limit | Workers [Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) (GA on 2025-09-19), key `tenant:user`, period of 10 or 60 s | Stops one user in a group from draining the tenant |
| Global net | AI Gateway spend limit per `tenant_id` (metadata) and the account cap | Protection against a bug in your own counter |
| Per-agent limits | `maxOutputTokens` per call, **maximum tool iterations per turn**, maximum cost per turn, daily cap per agent, model allowlist per plan, context compaction above N tokens | Tool loops are where cost explodes |

**Formulas (cost in USD; `P` in USD per token):**
- **Anthropic** (fields added together):
  `cost = in·P_in + cache_creation·P_write(5m=1.25× | 1h=2×) + cache_read·P_read + out·P_out`
- **OpenAI** (cache inside `input_tokens`):
  `uncached = input_tokens − cached_tokens − cache_write_tokens`
  `cost = (uncached·P_in + cached·P_cached + cache_write·P_write + output_tokens·P_out) × long_context_mult`
  (formula from the [prompt caching doc](https://developers.openai.com/api/docs/guides/prompt-caching); that reasoning tokens are included in `output_tokens` was not verified in this session).
- Keep the **versioned price table** in config, with `effective_from`. Do not trust the Gateway's cost, which is "best-effort".

---

## 5. Proposed interface

```ts
// packages/llm/src/types.ts — sketch
export type ProviderId = 'anthropic' | 'openai' | (string & {});

export interface ModelInfo {
  provider: ProviderId;
  id: string;                         // official provider ID
  contextWindow: number;
  maxOutput: number;
  pricing: {                          // USD per million tokens; versioned
    input: number; output: number; cacheRead: number;
    cacheWrite: { default: number; long?: number };   // Anthropic 5m/1h; OpenAI 1.25×
    longContext?: { overInputTokens: number; inputMult: number; outputMult: number };
  };
  caps: {
    tools: boolean; structuredOutput: boolean;
    reasoning: 'none' | 'adaptive' | 'effort';
    samplingParams: boolean;          // false on Claude 4.7+ and on GPT-6 with reasoning
    promptCache: 'explicit' | 'implicit' | 'both';
  };
}

export interface LlmRequest {
  model: string;
  system: string;                     // -> `system` (Anthropic) | `instructions` (OpenAI)
  messages: ChatMessage[];            // neutral format: user | assistant | tool_result, text/image parts
  tools?: ToolSpec[];                 // JSON Schema
  maxOutputTokens: number;            // required: feeds the pre-authorization
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  cache?: { prefixBreakpoints: number[]; ttl?: '5m' | '30m' | '1h'; key?: string }; // key scoped to the tenant
  responseSchema?: object;
  signal?: AbortSignal;
  meta: { tenantId: string; agentId: string; requestId: string };
}

export interface Usage { inputUncached: number; cacheRead: number; cacheWrite: number; output: number }

export type LlmEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'opaque'; provider: ProviderId; item: unknown } // thinking/encrypted reasoning to resend on the next turn
  | { type: 'finish'; reason: 'stop' | 'tool_calls' | 'length' | 'refusal' | 'error'; usage: Usage };

export type Credential =
  | { kind: 'api_key'; secret: string }          // operator or tenant BYOK (decrypted on the spot)
  | { kind: 'gateway_stored'; alias: 'default' };

export interface LlmProvider {
  readonly id: ProviderId;
  models(): readonly ModelInfo[];                 // local catalog, not a network call
  stream(req: LlmRequest, cred: Credential): AsyncIterable<LlmEvent>;
}
```

**Where routing lives:** in a `ModelRouter`, in the harness core (inside the agent's or conversation's DO), **above** the providers:
- `resolve({tenant, agent, purpose})` returns `{ provider, model, credential, fallbacks[] }`.
- It reads the tenant and agent config from D1 and applies the plan's allowlist and the budget (`TenantBudget` DO) **before** calling `stream`.
- Fallback only on retryable errors (429, 5xx, "overloaded") and only at the **start of a turn**. Switching providers in the middle of a tool loop loses opaque items (thinking signatures, encrypted reasoning).
- The providers are "dumb": they translate the format, do the streaming and normalize `usage`.
- Removal of unsupported parameters (`temperature` etc.) happens in the adapter, driven by `caps`.

---

## 6. Risks

1. **Volatile terms.** Anthropic changed three times in 2026 and SIWC launched on 2026-09-29. Mitigation: dated doc, links to the sources, no subscription-login code and a review at each release.
2. **BYOK with OpenAI.** The official text says sharing a key violates the ToU. Mitigation: operator key as the default in hosted mode and optional BYOK with an explicit warning.
3. **Silent operator billing.** Without `byok_only`, a missing key falls back to Unified Billing.
4. **Leakage between tenants.** Gateway response cache and logs with prompts. Mitigation: cache off or keyed per tenant, and logs off or with DLP.
5. **Model churn.** Haiku 4.5 ("not before 2026-10-15"), Sonnet 4.5 (retires on 2026-11-30) and the promotional price of GPT-5.6 Sol. Mitigation: catalog in config, never hard-coded IDs.
6. **Parameter incompatibilities.** `temperature` and `top_p` return 400 on Claude 4.7+ and must be removed on GPT-6 with reasoning. On GPT-6, tools require Responses.
7. **Cache cost.** A write costs 1.25× on OpenAI (5.6+) and on Anthropic (5m). Volatile prefixes in cache *increase* cost. The minimum cacheable size varies from 512 to 4,096 tokens.
8. **Token estimation.** Different tokenizers (Claude 4.7+'s produces about 30% more tokens). Pre-authorization needs a margin.
9. **Beta dependencies.** `agents/models/ai-sdk` and SIWC itself. Major-version changes in the AI SDK.
10. **Chat groups.** Without per-user attribution, one member drains the tenant's budget. With a subscription, this would be a direct violation of SIWC §2.

---

## 7. Sources (all accessed on 2026-10-03)

**Anthropic (primary)**
- Legal and compliance (Claude Code): https://code.claude.com/docs/en/legal-and-compliance
- Agent SDK overview: https://code.claude.com/docs/en/agent-sdk/overview
- Authentication (Claude Code): https://code.claude.com/docs/en/authentication
- Support — Use the Claude Agent SDK with your Claude plan (updated 2026-06-16): https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
- Consumer Terms (in effect since 2025-10-08): https://www.anthropic.com/legal/consumer-terms
- Commercial Terms (in effect since 2025-06-17): https://www.anthropic.com/legal/commercial-terms
- Models overview: https://platform.claude.com/docs/en/about-claude/models/overview
- Pricing: https://platform.claude.com/docs/en/about-claude/pricing
- Prompt caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Model deprecations: https://platform.claude.com/docs/en/about-claude/model-deprecations

**Anthropic (secondary)**
- The Register, 2026-02-20: https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access/
- @ClaudeDevs on X (credit announcement): https://x.com/ClaudeDevs/status/2054610152817619388
- GIGAZINE, 2026-05-14: https://gigazine.net/gsc_news/en/20260514-anthropic-claude-agent-sdk-credits/

**OpenAI (primary)**
- DevDay 2026 Recap (2026-09-29): https://openai.com/index/devday-2026-recap/
- Sign in with ChatGPT Terms (2026-09-29): https://openai.com/policies/sign-in-with-chatgpt-terms/
- Help — Sign in with ChatGPT: https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt
- Help — Using your ChatGPT plan in other apps and sites: https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites
- Cookbook — Integrating Sign in with ChatGPT: https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt
- SIWC quickstart: https://developers.openai.com/siwc/quickstart
- SIWC open source overview: https://developers.openai.com/siwc/token-sharing-open-source
- SIWC preview limitations: https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
- SIWC accounts and sessions: https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
- SIWC token reference: https://developers.openai.com/siwc/token-sharing-open-source/token-reference
- SIWC interest form: https://openai.com/form/sign-in-with-chatgpt-interest/
- Codex auth: https://learn.chatgpt.com/docs/auth
- Best Practices for API Key Safety: https://help.openai.com/en/articles/5112595-best-practices-for-api-key-safety
- OpenAI Services Agreement (in effect since 2026-01-01): https://openai.com/policies/services-agreement/
- Pricing: https://developers.openai.com/api/docs/pricing
- Models: https://developers.openai.com/api/docs/models — pages `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-luna`
- Using GPT-6: https://developers.openai.com/api/docs/guides/latest-model
- Prompt caching: https://developers.openai.com/api/docs/guides/prompt-caching
- Migrate to Responses: https://developers.openai.com/api/docs/guides/migrate-to-responses

**Cloudflare (primary)**
- AI Gateway REST API (2026-05-21): https://developers.cloudflare.com/ai-gateway/usage/rest-api/
- Unified API / compat (deprecated for single-model calls): https://developers.cloudflare.com/ai-gateway/usage/chat-completion/
- OpenAI provider (passthrough, `/openai/responses`): https://developers.cloudflare.com/ai-gateway/usage/providers/openai/
- BYOK + Secrets Store changelog (example `/anthropic/v1/messages`): https://developers.cloudflare.com/changelog/post/2025-08-25-secrets-store-ai-gateway/
- BYOK: https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/
- Unified Billing and credential precedence: https://developers.cloudflare.com/ai-gateway/features/unified-billing/
- Require provider credentials (2026-09-14): https://developers.cloudflare.com/changelog/post/2026-09-14-require-provider-credentials/
- Spend limits: https://developers.cloudflare.com/ai-gateway/features/spend-limits/
- Limits: https://developers.cloudflare.com/ai-gateway/reference/limits/
- Pricing: https://developers.cloudflare.com/ai-gateway/reference/pricing/
- Worker binding methods: https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/
- Custom providers: https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/
- Agents — AI SDK provider (beta, `ai@^7`): https://developers.cloudflare.com/agents/models/ai-sdk/
- Web Crypto: https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
- Secrets Store + Workers: https://developers.cloudflare.com/secrets-store/integrations/workers/
- Rate Limiting binding: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/

**Other**
- AI SDK, Anthropic provider: https://ai-sdk.dev/providers/ai-sdk-providers/anthropic
- AI SDK, OpenAI provider: https://ai-sdk.dev/providers/ai-sdk-providers/openai
- npm versions on 2026-10-03: `ai` 7.0.127, `@ai-sdk/anthropic` 4.0.71, `@ai-sdk/openai` 4.0.83, `@anthropic-ai/sdk` 0.131.0, `openai` 7.27.0, `ai-gateway-provider` 4.0.1, `workers-ai-provider` 4.0.0
- OpenRouter OAuth PKCE: https://openrouter.ai/docs/use-cases/oauth-pkce
- OpenRouter FAQ (fees): https://openrouter.ai/docs/faq
- OpenRouter prompt caching: https://openrouter.ai/docs/features/prompt-caching
- OpenRouter Responses API: https://openrouter.ai/docs/api/reference/responses/overview
- Anthropic SDK TS (runtimes): https://github.com/anthropics/anthropic-sdk-typescript
- OpenAI SDK Node (runtimes): https://github.com/openai/openai-node
