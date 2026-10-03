> Research note written on 2026-10-03 for the Kelpie viability study, translated from Portuguese. Corrections across notes are tracked in [00-cross-check.md](00-cross-check.md).

# 06 — Chat channels: viability on Cloudflare (no containers), capabilities and best practices

> Research done on 2026-10-03, reading sources only. Wherever possible I used primary sources: the platforms' official docs and the repositories' code. Anything I did **not** confirm in a source is marked **(unverified)**. When two official sources contradict each other, I show both instead of picking one.
> Literal quotes are only a few words long; the rest is paraphrase, and the URL for each claim sits next to it.

---

## TL;DR

**Viability per channel, without containers (Workers + Durable Objects + Queues + Workflows):**

| Channel | Viable without a container? | Inbound model | Deciding observation |
|---|---|---|---|
| **Own webchat** | Yes, and it is the best fit | WebSocket on a DO with Hibernation | "Typing" in both directions, streaming and editing stay under our control; low cost thanks to hibernation. |
| **Telegram** | Yes | HTTPS webhook + `secret_token` | The easiest for a demo. "Typing" lasts ≤5 s and needs renewing; ~1 msg/s per chat; `sendMessageDraft` allows streaming. |
| **WhatsApp — official Cloud API (Meta)** | Yes | HTTPS webhook + HMAC | "Typing" lasts 25 s and **marks the message as read**. **Pair rate limit: 1 msg every 6 s to the same user** (burst of up to 45). 24 h window. Real multi-tenancy requires becoming a **Tech Provider** (company verification + App Review). **Clause 4.7** prohibits "AI Providers" as the main functionality. |
| **WhatsApp — unofficial libs (Baileys etc.)** | Technically *maybe* (outbound WebSocket on a DO) | Persistent socket | Violates the Terms of Service and carries ban risk. **Not recommended** in a public portfolio repo. |
| **Discord** | Partial | (a) HTTP Interactions **or** (b) Gateway WebSocket on an always-on DO | Normal messages (free text, fragments) **require the Gateway**. Mode (a) only delivers slash commands and components. In mode (b), each bot costs ~324k GB-s/month (≈ US$ 4/month per bot beyond the allowance). |
| **Slack** | Yes | HTTP Events API (ack in 3 s → queue) | There is no classic "typing"; the substitute is `assistant.threads.setStatus` (2 min timeout). It has native streaming (`chat.startStream`) and a limit of 1 msg/s per channel. |
| Messenger / Instagram | Yes | Webhook (Meta) | 24 h window; App Review for third-party accounts. |
| Microsoft Teams | Yes (HTTP) | Bot Service over HTTP | Streaming only in 1:1 chats; Bot Framework SDK unsupported since 31 Dec 2025. |
| Email | Yes | Cloudflare Email Service → Worker `email()` | No "typing" and no splitting into bubbles; one reply per email. |
| SMS (Twilio) | Yes | HTTP webhook | No "typing"; billed per segment (160/70 characters). Splitting into several messages raises the cost. |

**Decisions I recommend:**
1. **Own adapter interface**, inspired by the Vercel Chat SDK, with the orchestration (buffer, splitting, interruption) in a **DO per conversation, driven by alarms**. One or another Chat SDK adapter can be reused behind our interface, if useful. The core reason: the Chat SDK debounce is a `sleep()` inside the handler, which is not durable ([chat.ts](https://github.com/vercel/chat/blob/main/packages/chat/src/chat.ts)). Details in the section "Chat SDK and alternatives".
2. **MVP order:** Webchat → Telegram → WhatsApp Cloud API (test number, one tenant) → Slack → Discord (Interactions first; Gateway DO optional).
3. **Debounce:** configurable silence window per channel (WhatsApp 3–5 s, the others 1.5–2 s), extended on every new message, with a **hard cap** counted from the first one.
4. **Splitting:** paragraph → line → sentence, without cutting code blocks; **at most 3–4 bubbles** on WhatsApp because of the pair rate limit.
5. **Interruption:** cancel the bubbles not yet sent and reprocess with the history of what was actually sent.

---

## 1. WhatsApp

### 1.1 Official Cloud API (Meta)

**Webhooks**
- Verification is a GET with `hub.mode`, `hub.verify_token` and `hub.challenge`; the endpoint returns the challenge ([Graph Webhooks](https://developers.facebook.com/docs/graph-api/webhooks/getting-started)).
- The payload arrives signed in `X-Hub-Signature-256`: HMAC-SHA256 of the body with the **App Secret** ([Graph Webhooks](https://developers.facebook.com/docs/graph-api/webhooks/getting-started)).
- The payload can be up to 3 MB. mTLS is also supported ([WA webhooks](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks)).
- **Retries — the sources diverge:**
  - The WhatsApp webhooks page talks about retrying with decreasing frequency for **up to 7 days** and warns that there are duplicates ([WA webhooks](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks)).
  - The generic Graph Webhooks page talks about **36 hours** and batches of up to 1000 updates ([Graph Webhooks](https://developers.facebook.com/docs/graph-api/webhooks/getting-started)).
  - Implication in both cases: deduplicate by `messages.id` and answer 200 right away.

**Service window and templates**
- Each message (or call) from the user opens a 24 h window, renewed with every new message. Outside it only templates can be sent ([Send messages](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages)). Sending outside the window returns error **131047** ([Error codes](https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes)).
- For a conversational harness, the LLM's reply is always a *service message* inside the window. Templates only come in for proactive follow-ups.

**Current pricing model**
- **Per-message** billing since 1 Jul 2025. Only delivered templates are charged, by category and country ([Pricing](https://developers.facebook.com/docs/whatsapp/pricing)).
- By category:
  - Marketing: always charged.
  - Utility and authentication: free inside the service window.
  - Non-template messages: free inside the window.
  - Service conversations: free since 1 Nov 2024.
  - 72 h free window when the conversation starts from Click-to-WhatsApp ([Pricing](https://developers.facebook.com/docs/whatsapp/pricing)).
- Changelog of 12 May 2026: from 13 May 2026 Meta stops charging "AI Providers" for non-template messages delivered in the EU/EEA ([WA changelog](https://developers.facebook.com/documentation/business-messaging/whatsapp/changelog)).
- **For the harness, the cost of LLM replies inside the window is zero on Meta's side.** The BSP, if there is one, charges separately.

**Typing indicator**
- Call: `POST /<PHONE_NUMBER_ID>/messages` with `status: "read"`, the `message_id` received in the webhook and `typing_indicator: {type: "text"}` ([Typing indicators](https://developers.facebook.com/docs/whatsapp/cloud-api/typing-indicators)).
- **Duration:** it disappears when the business replies or after **25 s**, whichever comes first.
- **Side effect:** it marks the message as **read** (blue ticks).
- Meta recommends showing the indicator only when you are actually going to reply ([Typing indicators](https://developers.facebook.com/docs/whatsapp/cloud-api/typing-indicators)).
- Available since 8 Apr 2025 ([WA changelog](https://developers.facebook.com/documentation/business-messaging/whatsapp/changelog)).
- The Chat SDK uses the most recent `message_id` received; without a received message, the indicator does not work ([Chat SDK WhatsApp adapter](https://github.com/vercel/chat/blob/main/apps/docs/content/adapters/official/whatsapp.mdx)).
- Resending the typing with the *same* `message_id` to extend it between bubbles: **(unverified in Meta's docs)**. Twilio says it can be extended by resending ([Twilio typing changelog](https://www.twilio.com/en-us/changelog/whatsapp-typing-indicator)).
- **"User typing" signal to the bot:** I did not find a webhook of this kind **(unverified: absence)**.

**Limits relevant to the "reply in several messages" feature**
- **Pair rate limit:**
  - **1 message every 6 s to the same user** (0.17 msg/s), with a burst of up to **45 messages in 6 s**. The burst "borrows" future quota, and after it you have to wait the equivalent time ([Cloud API overview](https://developers.facebook.com/docs/whatsapp/cloud-api/overview)).
  - Exceeding the limit returns error **131056**, which only affects that recipient ([Error codes](https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes)).
  - Meta suggests retrying with a wait of 4^X seconds ([Cloud API overview](https://developers.facebook.com/docs/whatsapp/cloud-api/overview)).
- Throughput per number: 80 msg/s by default, with automatic upgrade to 1000 msg/s. The throughput error is 130429 ([Throughput](https://developers.facebook.com/docs/whatsapp/throughput)).
- Text: **4096 characters** per message, with optional link preview ([Text messages](https://developers.facebook.com/docs/whatsapp/cloud-api/messages/text-messages)).
- Business-initiated messages (templates to unique users in 24 h): start at **250** per portfolio, rise to 2,000 with verification or a *scaling path*, and then to 10K, 100K and unlimited. The limit is **per business portfolio** ([Messaging limits](https://developers.facebook.com/docs/whatsapp/messaging-limits)).

**Media**
- Limits: image 5 MB, audio and video 16 MB, document 100 MB, sticker 100/500 KB ([Media](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media)).
- The download URL expires in **5 min**. The media ID lasts 30 days when it comes from an upload and 7 days when it comes from a webhook ([Media](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media)).
- Implication: download the media right away and store it in R2.

**Other features**
- Reactions, contextual reply (quote) and mark as read ([Send messages](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages)).
- Formatting: `*bold*`, `_italic_`, `~strikethrough~`, ` ```mono``` `, `` `code` ``, lists and `> quote` ([WhatsApp FAQ — formatting](https://faq.whatsapp.com/539178204879377)).
- **Editing a message sent through the API:** I did not confirm it. The changelog mentions "edit/revoke" webhooks in the context of *Coexistence* ([WA changelog](https://developers.facebook.com/documentation/business-messaging/whatsapp/changelog)), and the Chat SDK marks `editMessage: no` for WhatsApp ([Chat SDK WhatsApp](https://github.com/vercel/chat/blob/main/apps/docs/content/adapters/official/whatsapp.mdx)) **(unverified)**.

**Identity (BSUID)**
- Since early April/2026 the webhooks carry `user_id` (BSUID) ([BSUID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids/)).
- Whoever adopts a *username* may **not have `wa_id`/phone number in the payload**, except under specific conditions, such as having talked to the number in the last 30 days.
- The BSUID is **unique per business portfolio–user pair**: the same user gets different IDs in different portfolios. There is a "parent BSUID" for enrolled portfolios ([BSUID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids/)).
- Sending *to* a BSUID was announced for July/2026; whether it is already live is **(unverified)**.
- **Implication:** the contact key is `(tenant, channel, user_id/BSUID)`, never just the phone number.

**Company verification, test number, multi-tenancy**
- The temporary token from the dashboard expires quickly. For production, a *system user* token is used with `business_management`, `whatsapp_business_messaging` and `whatsapp_business_management` ([Get started](https://developers.facebook.com/docs/whatsapp/cloud-api/get-started)).
- **Test number:**
  - Meta provides a free test number.
  - Limit of **5 verified recipients** and a 24 h token: **(unverified)**. It only shows up in third-party sources ([search](https://medium.com/@adityadeepa634/the-developers-guide-to-the-whatsapp-cloud-api-sandbox-2026-edition-c967ce0bf671)); the official page I read does not give the number.
- **Embedded Signup:**
  - Onboarding flow for desktop and mobile that returns to the originating window the **WABA ID**, the **phone number ID** and a **code exchangeable for a token** ([Embedded Signup](https://developers.facebook.com/docs/whatsapp/embedded-signup)).
  - Tech Providers use the customer's *business tokens*.
  - For more than 200 customers per week, the recommendation is to become a Meta Business Partner ([Embedded Signup](https://developers.facebook.com/docs/whatsapp/embedded-signup)).
- **Tech Provider:** requires **company verification** and then **App Review**, with videos showing sending and template creation, to obtain *Advanced access* to `whatsapp_business_messaging` and `whatsapp_business_management` ([Tech Providers](https://developers.facebook.com/docs/whatsapp/solution-providers/get-started-for-tech-providers)).
- **Coexistence:** customers can keep using the WhatsApp Business app on the same number while on the Cloud API ([WA changelog](https://developers.facebook.com/documentation/business-messaging/whatsapp/changelog), entries of 11 Feb 2025 and 23 Oct 2025). Interesting for SMBs as tenants.
- **AI policy:**
  - **Section 4.7** of the *Meta Terms for WhatsApp Business Platform* (updated on 23 Sep 2026) prohibits "AI Providers" when the AI is the **main** functionality, rather than "incidental or ancillary" ([Meta Terms WA Business Platform](https://www.facebook.com/legal/Meta-Terms-for-WhatsApp-Business-Platform)).
  - In force since 15 Jan 2026. Meta clarified that businesses using AI to serve their own customers remain allowed ([TechCrunch](https://techcrunch.com/2025/10/18/whatssapp-changes-its-terms-to-bar-general-purpose-chatbots-from-its-platform)).
  - **Implication:** position the harness as infrastructure for **each tenant's business bots** (customer service, scheduling, FAQ), not as "ChatGPT on WhatsApp".

**Verdict:** viable without containers. It is pure HTTP: the webhook arrives at the Worker and sending is a `fetch` to the Graph API. The barriers are **account and policy** ones, not technical.

### 1.2 Unofficial libraries (Baileys, whatsapp-web.js, Evolution API, WAHA)

| Project | How it works | Runtime | License / notes |
|---|---|---|---|
| Baileys | Direct WebSocket to the WhatsApp Web protocol (reverse engineering), in TypeScript | Node, Bun, Deno | MIT; "not affiliated" notice regarding WhatsApp; discourages bulk and spam ([repo](https://github.com/WhiskeySockets/Baileys)) |
| whatsapp-web.js | Puppeteer/Chromium driving WhatsApp Web | Node ≥ 18 | The README warns that WhatsApp does not allow bots or unofficial clients ([repo](https://github.com/pedroslopez/whatsapp-web.js)) |
| Evolution API | REST over Baileys **and** over the Cloud API, multichannel | Node 20+, Postgres/MySQL, Redis, Docker | Apache-2.0 with branding conditions ([repo](https://github.com/EvolutionAPI/evolution-api)) |
| WAHA | REST; WEBJS/NOWEB/GOWS/WPP engines | Docker container | Open core, paid Plus ([repo](https://github.com/devlikeapro/waha)) |

**Can it run on Workers/DO without containers?**
- **whatsapp-web.js and WAHA (WEBJS/WPP):** no. They depend on a browser or container.
- **Baileys and derivatives:** in principle yes, with some conditions:
  - **DO as a WebSocket client:** a DO can open an outbound WebSocket, but outbound WebSockets **do not hibernate** ([DO WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)).
  - **Proofs of concept exist:**
    - [`oxidezap/baileyrs-cloudflare-example`](https://github.com/oxidezap/baileyrs-cloudflare-example) uses the *baileyrs* lib, stores auth and Signal keys in the DO's SQLite and does **passive** recovery (it only reconnects when there is a request). The README reminds that, on the Free plan, alarms count as DO requests.
    - There is also a "Baileys for Workers" fork: [`rafaelsg-01/whatsapp-cloudflare-workers`](https://github.com/rafaelsg-01/whatsapp-cloudflare-workers). I did not evaluate it.
  - **"Stock" Baileys on workerd** (dependencies such as `ws` and Node's crypto): **(unverified)**.
  - **Cost:** an always-on DO per number, same math as Discord (§3.4).
- **ToS:**
  - The WhatsApp Terms prohibit reverse engineering and access "through automated means", "bulk messaging, auto-messaging", and non-personal use without authorization ([WhatsApp ToS](https://www.whatsapp.com/legal/terms-of-service)).
  - Unofficial libraries operate outside that. Number bans are a real risk, and the READMEs themselves admit it.

**Honest verdict for a public portfolio repo:** **do not include** it as the default path. If there is interest, at most an **experimental adapter, outside the core, off by default**, with an explicit warning. Better still is to document in the README *why* it is not there. For recruiters, this signals maturity (compliance and risk).

### 1.3 BSPs (summary)
- **Twilio:**
  - Charges **US$ 0.005 per WhatsApp message**, received or sent, on top of Meta's rates ([Twilio WhatsApp pricing](https://www.twilio.com/en-us/whatsapp/pricing)).
  - Typing indicator in *public beta*: it disappears within 25 s or on delivery, and can be extended by resending ([Twilio changelog](https://www.twilio.com/en-us/changelog/whatsapp-typing-indicator), [Typing Indicators resource](https://www.twilio.com/docs/whatsapp/api/typing-indicators-resource)).
  - HTTP webhooks, compatible with Workers.
- **360dialog:**
  - Sandbox with **200 messages in total**, a fixed recipient, three predefined templates and no media upload ([360dialog sandbox](https://docs.360dialog.com/docs/get-started/sandbox.md)).
  - Pricing model: **(unverified)**.
- A BSP only makes sense if the tenant already has one. The harness should talk to the Cloud API directly; a BSP becomes just another adapter.

---

## 2. Telegram Bot API

**Webhooks**
- `setWebhook` accepts a `secret_token` of 1–256 characters `[A-Za-z0-9_-]`, which comes back in the **`X-Telegram-Bot-Api-Secret-Token`** header on every request ([Bot API](https://core.telegram.org/bots/api)).
- `max_connections` ranges from 1 to 100 (default 40). Accepted ports: 443, 80, 88 and 8443. On a non-2xx response, Telegram repeats "a reasonable number" of times ([Bot API](https://core.telegram.org/bots/api)).
- If the webhook does not finish quickly, Telegram resends the update. grammY uses a default timeout of 10 s and recommends sending long work to a queue ([grammY deployment types](https://grammy.dev/guide/deployment-types)).

**"Typing"**
- `sendChatAction` keeps the status for **5 s or less**, and it is cleared when a message from the bot arrives ([Bot API](https://core.telegram.org/bots/api)).
- Telegram recommends using it only when the reply will take a while.
- Implication: **renew every ~4 s** while the LLM works, and again before each bubble.

**Native streaming**
- `sendMessageDraft` shows a partial draft, **ephemeral, as a ~30 s preview**; at the end you must call `sendMessage` to persist it. It only works in a **private chat** (`chat_id` of a private chat), and empty text shows "Thinking…" ([Bot API](https://core.telegram.org/bots/api)).
- Version history ([changelog](https://core.telegram.org/bots/api-changelog)):
  - Added in API 9.3 (31 Dec 2025).
  - Opened to all bots in 9.5 (1 Mar 2026).
  - `can_stop`/`keep_on_stop` and the `stopped_message_generation` update arrived in 10.3 (24 Aug 2026).
- The current version is **Bot API 10.3**, from 24 Aug 2026, which also brings *Rich Messages* (10.1+) and ephemeral messages (10.2+) ([Bot API](https://core.telegram.org/bots/api)).

**Limits**
- Text: **1–4096 characters after entity parsing** ([Bot API](https://core.telegram.org/bots/api)).
- Files: upload up to 50 MB by multipart; by URL, 5 MB for photos and 20 MB for the rest; download via `getFile` up to 20 MB ([Bot API](https://core.telegram.org/bots/api)).
- **Rate:** about 1 msg/s per chat; in groups, 20 msg/min; broadcast around 30 msg/s, or up to 1000 msg/s with *paid broadcasts* ([Bot FAQ](https://core.telegram.org/bots/faq)).

**Formatting**
- There are three modes: `MarkdownV2`, `HTML` or `entities` ([Bot API](https://core.telegram.org/bots/api)).
- In MarkdownV2, 18 characters need escaping: `_ * [ ] ( ) ~ ` > # + - = | { } . !`.
- **Recommendation:** generate **HTML** (escaping only `<`, `>` and `&`) or `entities` from an AST, instead of MarkdownV2.

**Groups and privacy mode**
- With privacy mode, the bot receives:
  - commands addressed to it;
  - general commands, if it was the last bot to speak;
  - replies to its messages ([Bot FAQ](https://core.telegram.org/bots/faq)).
- To read the whole group you must turn privacy mode off or make the bot an admin. The latter path is **(unverified)** in this research.

**Others**
- Editing (`editMessageText`) and reacting (`setMessageReaction`) are available ([Bot API](https://core.telegram.org/bots/api)).
- Read receipt for bots: I did not find one **(unverified: absence)**.
- "User typing" event for bots: does not exist in the Bot API **(unverified: absence)**.
- *Business* mode allows replying on behalf of a business account ([Chat SDK Telegram](https://github.com/vercel/chat/blob/main/apps/docs/content/adapters/official/telegram.mdx)).

**Libraries that run on Workers**
- **grammY**, with the `webhookCallback(bot, "cloudflare-mod")` adapter. It recommends preloading `botInfo` to avoid `getMe` on every execution ([grammY CF Workers](https://grammy.dev/hosting/cloudflare-workers-nodejs)).
- **Chat SDK Telegram:** downloads use Web Fetch, which works on Cloudflare Workers ([adapter-telegram README](https://github.com/vercel/chat/blob/main/packages/adapter-telegram/README.md)).
- The Bot API is plain HTTP, so a thin client of our own is also trivial.

**Verdict:** **fully viable** and the best "real" channel for a demo. Multi-tenancy is trivial: each tenant pastes their bot's token, and we call `setWebhook` with a per-tenant `secret_token`.

---

## 3. Discord

### 3.1 Two entry doors

**Interactions endpoint (HTTP)**
- Receives slash commands, components and PING.
- Initial response within **3 s**, otherwise the token is invalidated. You can *defer* and complete later with the token, valid for **15 min** ([Interactions](https://docs.discord.com/developers/interactions/receiving-and-responding)).
- Ed25519 signature in the `X-Signature-Ed25519` and `X-Signature-Timestamp` headers (summary of the page; **(unverified in the excerpt read)**).
- Interaction endpoints **do not count** toward the global limit of 50 req/s ([Rate limits](https://docs.discord.com/developers/topics/rate-limits)).
- **It does not deliver normal messages.**

**Gateway (WebSocket)**
- It is the only way to receive normal messages and reactions. Even Vercel's adapter says so ([Chat SDK Discord](https://github.com/vercel/chat/blob/main/apps/docs/content/adapters/official/discord.mdx)).
- **MESSAGE_CONTENT:**
  - It is a privileged intent. Without it, `content`, `embeds`, `attachments`, `components` and `poll` arrive empty.
  - Exceptions: the app's own messages, **DMs with the app**, messages that **mention** the app and messages targeted by a context menu ([Gateway](https://docs.discord.com/developers/events/gateway)).
- **Privileged intent review:**
  - Since 10 Jun 2026 it is based on **unique users**: above **10,000 users**, the app must request access and has 90 days to do so ([Privileged Intent Review](https://docs.discord.com/developers/gateway/getting-started-with-privileged-intent-review)).
  - The old threshold, 100 servers, was replaced.
  - In a "each tenant brings their own bot" model, each app counts separately.
- **Conclusion:** MESSAGE_CONTENT is **not** the blocker for a customer-service bot (DM and @mention are enough). The blocker is **needing the Gateway** for any message that is not an interaction.

### 3.2 Gateway on a Durable Object

**Protocol** ([Gateway](https://docs.discord.com/developers/events/gateway))
- **Heartbeat** every `heartbeat_interval` ms (docs example: 45000). With no ACK between two heartbeats, the connection is a "zombie": close and reconnect.
- **Resume:** store `session_id`, `resume_gateway_url` and the last `s`, and reconnect with RESUME.
- **IDENTIFY:** limit of **1000 per 24 h**, besides `max_concurrency` every 5 s.
- **Sending:** 120 events per 60 s per connection.
- **Sharding:** mandatory from 2500 guilds.

**DO behavior with an outbound WebSocket — the sources diverge**
- The WebSockets page says outbound connections **do not hibernate** and prevent the DO from being evicted "for up to 15 minutes", and the connection may stay open afterwards ([DO WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)).
- The lifecycle page also speaks of 15 min per operation ([DO lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)).
- The **changelog of 19 Jun 2026** says DOs now **stay alive while there is an active outbound connection** ([changelog](https://developers.cloudflare.com/changelog/post/2026-06-19-outbound-connections-keep-dos-alive/)).
- **Recommendation in both scenarios:** a **"watchdog" alarm** every ~1 min checks whether the socket is alive and reconnects, with RESUME, if it is not.

**Deploys**
- **Every deploy restarts all DOs** and drops the WebSockets ([DO WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), [DO lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)).
- Implication: persist `session_id`, `seq` and `resume_gateway_url` in the DO's SQLite and do RESUME, never IDENTIFY on every deploy, because of the 1000-per-day cap.

**Vercel adapter**
- Runs the Gateway in a serverless environment with a **cron every 9 min** that opens a 10-min listener and forwards events to the webhook ([Chat SDK Discord](https://github.com/vercel/chat/blob/main/apps/docs/content/adapters/official/discord.mdx)).
- Depends on `discord.js` ([package.json](https://github.com/vercel/chat/blob/main/packages/adapter-discord/package.json)).
- Whether `discord.js` runs on workerd: **(unverified)**. This pattern is worse than a dedicated DO.

### 3.3 "Typing" and limits
- `POST /channels/{id}/typing` lasts **10 s** or until the bot sends a message. The doc says bots in general should **not** use it, except when the reply will take a few seconds ([Channel](https://docs.discord.com/developers/resources/channel)). Renew every ~8 s.
- **User typing signal:** it exists. It is the Gateway's `TYPING_START` event, with the `GUILD_MESSAGE_TYPING` and `DIRECT_MESSAGE_TYPING` intents ([Gateway](https://docs.discord.com/developers/topics/gateway)). Useful for extending the debounce.
- Messages ([Message](https://docs.discord.com/developers/resources/message)):
  - Content of up to **2000 characters**.
  - Embeds: up to 6000 characters combined and at most 10 per message.
  - Request of up to 25 MiB.
  - Editing via PATCH, reactions and replies through `message_reference`.
- **Rate limits** ([Rate limits](https://docs.discord.com/developers/topics/rate-limits)):
  - Global **50 req/s**, with per-route buckets reported in the `X-RateLimit-*` headers.
  - **10,000 invalid requests (401, 403, 429) in 10 min cause a temporary ban.**
  - Per-channel limit, around 5 msgs every 5 s: **(unverified)**. Follow the headers.

### 3.4 Cost estimate for an always-on DO
- Duration is billed for the allocated 128 MB, in wall-clock time, while the DO is active or idle without being able to hibernate ([DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).
- **One connection per month:** 30 × 86,400 s × 0.125 GB = **324,000 GB-s/month**.
- **Paid plan:** the allowance is **400,000 GB-s/month per account**, shared with everything else, and the excess costs **US$ 12.50 per million GB-s**. Each additional bot comes to ≈ **US$ 4.05/month** of duration ([DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).
- **Free plan:** allowance of 13,000 GB-s/day; one connection consumes about 10,800 GB-s/day, i.e. ~83% of it ([DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).
- Whether messages received on an **outbound** WebSocket count as DO "requests": **(unverified)**. The documented 20:1 rule is for messages received on server WebSockets.
- **Product modes:**
  - **(a) Interactions only:** 100% serverless and cost ~0, but no free text, hence no fragment buffer.
  - **(b1) Gateway per tenant bot:** one DO per bot.
  - **(b2) Shared project app, invited by the tenants:** a single connection up to 2500 guilds. It goes against "each tenant brings their own bot", but is much cheaper.

**Verdict:** viable without containers **with an always-on DO**. I recommend shipping (a) first and (b1) as a well-documented optional feature. The RESUME and watchdog engineering is, by itself, a good portfolio highlight.

---

## 4. Slack

**Events API (HTTP)** ([Events API](https://docs.slack.dev/apis/events-api/))
- Respond 2xx within **3 s**. Otherwise there are up to 3 retries: almost immediate, then after 1 min and then after 5 min, with the `x-slack-retry-num` and `x-slack-retry-reason` headers.
- Limit of 30,000 events per workspace per app per hour.
- If more than **95% of deliveries fail in 60 min**, the app's events are disabled.
- Pattern: immediate ack, then queue or DO.

**Signature**
- `X-Slack-Signature` carries `v0=` + HMAC-SHA256 of `v0:{timestamp}:{body}` with the *signing secret*.
- Reject an `X-Slack-Request-Timestamp` that differs by more than 5 min and compare in constant time ([Verifying requests](https://docs.slack.dev/authentication/verifying-requests-from-slack)).

**"Thinking" indicator — there is no classic typing for bots**
- `assistant.threads.setStatus` takes `channel_id`, `thread_ts`, `status` and `loading_messages` (up to 10, rotating). The limit is 600 req/min per app and team. The accepted scopes are `assistant:write` or `chat:write`, and only `chat:write` in the future ([setStatus](https://docs.slack.dev/reference/methods/assistant.threads.setStatus)).
- **2 min timeout** with no message.
- **Status clearing — the sources diverge:**
  - The method page says the status is cleared automatically when the app replies ([setStatus](https://docs.slack.dev/reference/methods/assistant.threads.setStatus)).
  - The AI apps guide says the loading UX does **not** go away on its own and that you must set `status: 'active'` at the end ([Developing AI apps](https://docs.slack.dev/ai/developing-ai-apps)). It may be the new "agent sessions" model.
  - Treat explicit clearing as mandatory.
- Some AI features require a paid plan. The Developer Program offers a free sandbox ([Developing AI apps](https://docs.slack.dev/ai/developing-ai-apps)).

**Native streaming**
- `chat.startStream`, `chat.appendStream` and `chat.stopStream` ([AI apps](https://docs.slack.dev/ai/developing-ai-apps)).
- `chat.startStream` is Tier 2 (20+/min). `markdown_text` accepts up to 12,000 characters. Outside "session" channels, it requires `thread_ts` ([chat.startStream](https://docs.slack.dev/reference/methods/chat.startStream)).

**Sending and formatting**
- `chat.postMessage`: the ideal is up to 4,000 characters, and above 40,000 the text is truncated. Limit of **1 msg/s per channel**, with burst ([chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage)).
- **mrkdwn is not Markdown:** `*bold*`, `_italic_`, `~strikethrough~`, links `<url|text>`; escape `&`, `<` and `>`. For standard Markdown there is the *markdown block* ([Formatting](https://docs.slack.dev/messaging/formatting-message-text)).

**Distribution**
- Since 29 May 2025, apps distributed **outside the Marketplace** have `conversations.history` and `conversations.replies` limited to **1 req/min and 15 objects**. Existing installations started being affected on 3 Mar 2026 ([Slack changelog](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/)) **(content obtained via a search summary; page not read in full)**.
- **Implication:** keep the conversation history in our DO, do not fetch it from Slack.
- Multi-tenancy via OAuth v2 per workspace: **(unverified in this research)**. The Chat SDK has a "multi-workspace mode" for Slack ([Chat SDK API](https://github.com/vercel/chat/blob/main/apps/docs/content/docs/api/chat.mdx)).

**Verdict:** **viable**. It is pure HTTP, with no need for Socket Mode. "Typing" becomes `setStatus`, and splitting into bubbles can coexist with native streaming, or be replaced by it.

---

## 5. Own webchat

**Transport**
- WebSocket on a DO with the **Hibernation API** (`ctx.acceptWebSocket`): clients stay connected with the DO out of memory, and **there is no duration charge during hibernation** ([DO WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)).
- `setWebSocketAutoResponse` answers ping/pong **without waking** the DO ([Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)).
- Up to 32,768 WebSockets per DO ([DO State API](https://developers.cloudflare.com/durable-objects/api/state/)).
- Deploys drop the WebSockets, so the client needs reconnection with *resume* ([DO WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)).

**Ready to use**
- `AIChatAgent` (`@cloudflare/ai-chat`) and the `useAgentChat` hook already bring SQLite persistence, **streaming that can be resumed after reconnection**, cross-tab sync and tools ([Chat agents](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/)).
- For Vue, Svelte or vanilla there is `WebSocketChatTransport` ([Chat agents](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/)).

**"Typing"**
- Native in **both directions**: the client sends `typing:start/stop` and we send `bot:typing`. It is the only channel, besides Discord, where the debounce can use the real "user typing" signal.

**Visitor authentication**
- The browser cannot set custom headers on a WebSocket upgrade. The token has to go in a query string, cookie or subprotocol (general WebSocket knowledge, **(unverified in a source in this research)**).
- Suggested flow:
  1. The widget solves **Turnstile**.
  2. The backend validates it at `siteverify`. The token is up to 2048 characters, is **valid for 300 s** and **is single-use** ([Turnstile server-side](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)).
  3. The backend issues a **short-lived JWT**, signed and scoped to `tenant`/`visitorId`.
  4. The client opens the WebSocket with the JWT, and the Worker validates it before forwarding to the DO.
- Anonymous visitor: random `visitorId` in a cookie; login on the tenant's site can "promote" the identity.

**Verdict:** the **best channel to demonstrate** both requirements (buffer and splitting with "typing") without any external dependency.

---

## 6. Other channels (summary)

- **Messenger (Meta)**
  - Standard 24 h window; the *Human Agent* tag allows replying manually within 7 days ([Messenger policy](https://developers.facebook.com/docs/messenger-platform/policy/policy-overview)).
  - Sender actions `typing_on`, `typing_off`, `mark_seen` and `react`. It is recommended not to leave an artificial gap between `typing_on` and `typing_off` ([Sender actions](https://developers.facebook.com/docs/messenger-platform/send-messages/sender-actions)).
  - Duration of `typing_on` and text limit (~2000 characters): **(unverified)**.
- **Instagram (Meta)**
  - 24 h window; text of **up to 1000 bytes** UTF-8.
  - Requires a *professional* account and the `instagram_business_basic` and `instagram_business_manage_messages` permissions, with *Advanced Access* for third-party accounts ([IG Messaging API](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api)).
  - The Chat SDK marks typing as supported ([Chat SDK Instagram](https://github.com/vercel/chat/blob/main/apps/docs/content/adapters/official/instagram.mdx)).
- **Microsoft Teams**
  - Message streaming **only in 1:1 chats**, with one stream per chat ([Teams streaming](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/streaming-ux)):
    - Limit of **1 req/s** and a **2 min cap** per stream.
    - Recommends buffering tokens for 1.5–2 s.
    - The user has a "Stop" button.
    - **There is no typing animation with a stream open.**
  - The **Bot Framework SDK lost support on 31 Dec 2025**. The path is the Microsoft 365 Agents SDK or the Teams SDK, and Azure Bot Service keeps running bots ([Bot Service — what's new](https://learn.microsoft.com/en-us/azure/bot-service/what-is-new?view=azure-bot-service-4.0)) **(via a search summary)**.
  - Inbound over HTTP, compatible with Workers. Validating the Bot Connector JWT on Workers: **(unverified)**.
- **Email**
  - Inbound through Cloudflare Email Service, with a routing rule to the `email()` handler or an Agent's `onEmail()`. Sending with the `send_email` binding ([Agents — Email](https://developers.cloudflare.com/agents/communication-channels/email/)).
  - Limits: 25 MiB per received message; `reply()` fails above 100 entries in `References` ([Email limits](https://developers.cloudflare.com/email-service/platform/limits/)).
  - Reply rules ([changelog 2025-03-12](https://developers.cloudflare.com/changelog/post/2025-03-12-reply-limits/)):
    - Valid DMARC on the received message.
    - One reply per event.
    - The reply's recipient must be the original sender.
    - Same domain.
  - Buffer and splitting do not apply; the debounce can group the emails of a thread.
- **SMS (Twilio)**
  - Segments of 160 characters in GSM-7 (153 when concatenated) or 70 in UCS-2 (67); body of up to 1,600 characters ([Twilio SMS limit](https://www.twilio.com/docs/glossary/what-sms-character-limit)).
  - No typing. Splitting into several messages multiplies the cost.
  - RCS through Twilio has typing ([Twilio V3 typing changelog](https://www.twilio.com/en-us/changelog/v3-typing-indicator-api)).

---

## 7. Capability matrix

### 7.1 UX

| Channel | Bot "typing" (duration) | User typing visible to the bot? | Edit | Reactions | Read receipt | Threads / reply | Native streaming |
|---|---|---|---|---|---|---|---|
| WhatsApp Cloud | Yes, 25 s or until it replies; **marks as read** | No (unverified) | No (unverified) | Yes | Yes (mark as read) | Contextual reply (quote) | No (Chat SDK: "buffered") |
| Telegram | Yes, ≤5 s; renew | No (unverified) | Yes | Yes | No (unverified) | Reply; topics (forum/private) | `sendMessageDraft` (private only) |
| Discord | Yes, 10 s; renew | **Yes** (`TYPING_START`) | Yes | Yes | No | Threads and replies | No (post+edit) |
| Slack | `setStatus` (2 min timeout) | No (unverified) | Yes (`chat.update`, unverified) | Yes | No | Threads (`thread_ts`) | **Yes** (`chat.startStream`) |
| Webchat | Yes (ours) | **Yes** (ours) | Yes | Optional | Optional | Optional | Yes |
| Messenger | `typing_on/off` (duration unverified) | No (unverified) | No (unverified) | `react` | `mark_seen` | — | No |
| Instagram | Yes (according to the Chat SDK) | No (unverified) | No (unverified) | No (Chat SDK) | — | — | No |
| Teams | Yes (`typing` activity) | (unverified) | Yes | Yes | — | Yes | Yes, 1:1 only |
| Email | — | — | — | — | — | Thread via `References` | — |
| SMS | — | — | — | — | — | — | — |

### 7.2 Limits and windows

| Channel | Max text | Media | Buttons | Formatting | Relevant send limit | Session window |
|---|---|---|---|---|---|---|
| WhatsApp Cloud | 4096 characters | img 5 MB, audio/video 16 MB, doc 100 MB | Interactive (reply/list/CTA) | `*b*` `_i_` `~s~` ` ``` ` | **1 msg/6 s per user** (burst 45); 80 msg/s per number | **24 h**; outside it, paid template |
| Telegram | 4096 (after entities) | upload 50 MB; download 20 MB | Inline/reply keyboard | HTML / MarkdownV2 / entities | ~1 msg/s per chat; 20/min in a group; ~30/s global | None (the user has to start the bot, unverified) |
| Discord | 2000 (embeds 6000) | 25 MiB per request | Components | Discord Markdown (unverified) | 50 req/s global + buckets | None |
| Slack | ≤4000 recommended (truncates at 40k) | (unverified) | Block Kit | mrkdwn | 1 msg/s per channel; stream Tier 2 | None |
| Webchat | free | free (R2) | free | Markdown/HTML | ours | ours |
| Messenger | ~2000 (unverified) | (unverified) | Templates (max. 3, according to the Chat SDK) | text | (unverified) | 24 h (+7 d Human Agent) |
| Instagram | 1000 bytes | (unverified) | Quick replies | text | (unverified) | 24 h |
| Teams | (unverified) | yes | Adaptive Cards | Extended Markdown | stream: 1 req/s, 2 min | None |
| Email | — | 25 MiB inbound | — | HTML/text | — | — |
| SMS | 1600 (160/70 per segment) | MMS | RCS | text | (unverified) | — |

Sources for the matrix: the same as sections 1 to 6. For Messenger, Instagram and Teams I filled in the gaps with the *features* declared by the Chat SDK adapters ([adapters](https://github.com/vercel/chat/tree/main/apps/docs/content/adapters/official)), which count as a secondary source.

---

## 8. Vercel Chat SDK and alternatives

### 8.1 What it is (state on 2026-10-03)

**Package and repository**
- npm package `chat`, repo [vercel/chat](https://github.com/vercel/chat), MIT license.
- Created on 22 Dec 2025, with about 2.4k stars. Latest version: **4.41.1, from 28 Sep 2026** (GitHub API data).
- Description: unified TypeScript SDK for bots across several chats ([README](https://github.com/vercel/chat)).

**Official adapters (packages in the monorepo)**
- Slack, Teams, Google Chat, Discord, Telegram, **WhatsApp (Cloud API)**, GitHub, Linear, Gmail, Instagram, Messenger, Notion, **Twilio** (SMS/MMS/RCS), **Web** (the AI SDK UI stream protocol) and X.
- Community: Baileys, zaileys, LINE, Mattermost, Webex, Matrix, Lark and others ([docs/adapters](https://github.com/vercel/chat/tree/main/apps/docs/content/adapters)).
- **The 10 official adapters I checked** (WhatsApp, Telegram, Slack, Teams, Web, Instagram, Messenger, Twilio, Gmail and Discord) are marked `beta: true` in the documentation frontmatter ([e.g.: whatsapp.mdx](https://github.com/vercel/chat/blob/main/apps/docs/content/adapters/official/whatsapp.mdx)). I did not check Google Chat, GitHub, Linear, Notion or X.

**State adapters**
- Official: memory, Redis, ioredis and Postgres.
- Community: **`chat-state-cloudflare-do`**, a DO with SQLite that stores subscriptions, locks, cache, queues and lists ([cloudflare-do.mdx](https://github.com/vercel/chat/blob/main/apps/docs/content/adapters/community/cloudflare-do.mdx)).
- Maintained by Cloudflare: **`agents/chat-sdk`** (`createChatSdkState`, `ChatSdkStateAgent` sub-agents with SQLite in the DO) ([CF docs — Chat SDK](https://developers.cloudflare.com/agents/runtime/communication/chat-sdk/)).

**Does it run on Cloudflare Workers?**
- **Yes**, inside an Agent or DO with `nodejs_compat`. Cloudflare documents this with a Telegram example using `concurrency: { strategy: "burst", debounceMs: 600 }` ([CF docs — Chat SDK](https://developers.cloudflare.com/agents/runtime/communication/chat-sdk/)).
- The Discord adapter depends on `discord.js` and a cron listener, so it is a poor fit (§3.2).

**Concurrency** ([Concurrency](https://chat-sdk.dev/docs/concurrency), [types.ts](https://github.com/vercel/chat/blob/main/packages/chat/src/types.ts))
- Strategies: `drop` (default), `queue`, `debounce`, `burst` and `concurrent`.
- `debounceMs` has a default of 1500 ms.
- `debounce` restarts the wait on every new message and processes only the last one.
- `burst` waits once and delivers the last message with the earlier ones in `context.skipped`.
- Queue of up to 10 items per thread, with a 90 s TTL; `maxLockLifetimeMs` of 10 min.

**Streaming** ([streaming.mdx](https://github.com/vercel/chat/blob/main/apps/docs/content/docs/streaming.mdx), [whatsapp.mdx](https://github.com/vercel/chat/blob/main/apps/docs/content/adapters/official/whatsapp.mdx))
- Slack: native.
- Telegram: post+edit, or rich drafts (opt-in).
- WhatsApp and Messenger: **buffered**, one final message.
- The SDK "heals" incomplete Markdown and holds tables until the end.
- On WhatsApp, it automatically splits texts above 4096 characters.
- I did **not find** a feature for "splitting into several bubbles with a delay and typing between them" **(unverified: absence)**.

**Multi-tenancy**
- Explicitly supported in Slack (multi-workspace), Linear, GitHub and Teams (`MultiTenant`) ([api/chat.mdx](https://github.com/vercel/chat/blob/main/apps/docs/content/docs/api/chat.mdx)).
- WhatsApp and Telegram are configured with one number or one token per adapter. The WhatsApp thread ID is `whatsapp:{phoneNumberId}:{userWaId}` ([whatsapp.mdx](https://github.com/vercel/chat/blob/main/apps/docs/content/adapters/official/whatsapp.mdx)).
- For per-tenant BYO, probably one `Chat` instance per tenant **(unverified)**.

### 8.2 The deciding fact

How debounce and burst are implemented in the code:
- Debounce is an **`await sleep(debounceMs)` inside the handler**, which holds a lock with a heartbeat and then drains the queue ([chat.ts](https://github.com/vercel/chat/blob/main/packages/chat/src/chat.ts)). Burst works the same way.
- On a plain Worker, this depends on `waitUntil`, which has a **limit of 30 s after the response** ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Context](https://developers.cloudflare.com/workers/runtime-apis/context/)).
- On a DO or Agent it works, but has three costs:
  - it keeps the DO active and billing duration during the wait;
  - it is **not durable**: a deploy or restart kills the `sleep` ([DO lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/));
  - the items stay in the queue until the TTL, and I did not find a resume mechanism **(unverified)**.
- Debounce has no **hard cap** counted from the first message, other than the 10 min `maxLockLifetimeMs`.

**Selective reuse**
- The adapters call `this.chat.processMessage(...)` when handling the webhook ([adapter-telegram/src/index.ts](https://github.com/vercel/chat/blob/main/packages/adapter-telegram/src/index.ts)) and implement `initialize(chat)` ([types.ts](https://github.com/vercel/chat/blob/main/packages/chat/src/types.ts)).
- That is, they are coupled to the `ChatInstance` interface.
- The outbound methods (`postMessage`, `editMessage`, `startTyping`, `addReaction`) are part of the `Adapter` interface.
- An adapter can be reused by implementing a `ChatInstance` *shim* that forwards to our DO. Whether this works in practice: **(unverified)**.

### 8.3 Verdict

**Define our own adapter interface**, inspired by the Chat SDK. Six reasons:
1. The two core requirements (fragment buffer and reply in several bubbles with "typing", with interruption) are **the project's differentiator**. They need to be durable with DO alarms, which the Chat SDK does not do.
2. The adapters I checked are in **beta**, and the API changes fast: 4.41 in nine months.
3. Multi-tenant BYO for WhatsApp and Telegram is not a first-class scenario in the Chat SDK.
4. The Discord adapter assumes a Vercel cron and `discord.js`.
5. The APIs involved are plain HTTP, so own adapters are thin: verify → normalize → send.
6. For a portfolio, the own interface **shows system design**; using the SDK would hide exactly what we want to show.

**What to copy from the Chat SDK:**
- Encoded thread ID (`channel:account:conversation`).
- A *capabilities* object per adapter (`typingIndicator`, `editMessage`, `streaming: native|post+edit|buffered`).
- Deduplication with TTL.
- Markdown "healing" during streaming.
- Converting cards to native formats.
- The `context.skipped` concept.

**Possible one-off reuse:** behind our interface, use `@chat-adapter/slack` (Block Kit, streaming and multi-workspace are laborious) **if** the shim works. Evaluate in a spike.

**Alternatives and references**
- **grammY** (Telegram on Workers) ([grammY](https://grammy.dev/hosting/cloudflare-workers-nodejs)).
- **Cloudflare Agents SDK:**
  - `AIChatAgent` for the webchat;
  - `onEmail` for email;
  - `agents/chat-sdk` as the Chat SDK state ([Chat agents](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/), [Agents — Email](https://developers.cloudflare.com/agents/communication-channels/email/)).
- **Teams SDK / M365 Agents SDK** (§6).
- **OpenClaw**, as a **design reference**: it is a long-running Node gateway, not Workers, with more than 20 channels ([repo](https://github.com/openclaw/openclaw)). The documentation describes inbound debounce, queue modes and an outbound chunker (§9).

---

## 9. Best practices: debounce, splitting, interruption and identity

### 9.1 Reference architecture (event-driven, no containers)

1. **Ingress on the Worker**
   - Route `/{channel}/{tenant}/webhook`.
   - Verifies the channel's signature (Meta HMAC, Telegram `secret_token`, Slack v0 HMAC, Discord Ed25519).
   - **Responds 200 immediately**: Slack and Discord give 3 s, Telegram resends, Meta retries.
2. **Dedupe** by the platform's ID (`messages.id`, `update_id`, `event_id`/`x-slack-retry-num`), with TTL. Duplicates are documented by Meta ([WA webhooks](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks)).
3. **Normalization** into `InboundMessage { tenant, channel, conversationKey, userKey, text, media[], platformMsgId, ts }`. Media goes to R2 immediately, because on WhatsApp the URL expires in 5 min.
4. **Forwarding** to the **`ConversationDO`** identified by `tenant:channel:conversation`, by RPC or via a Queue if you want to absorb spikes. The DO is the single instance of the conversation and removes the need for a distributed lock, but it **does not serialize everything**:
   - Only synchronous code between two `await`s is atomic.
   - At every `await` (LLM fetch, bubble send, storage), another RPC or the `alarm()` can interleave. Alarms can run concurrently with other requests to the same DO ([changelog 2026-08-25](https://developers.cloudflare.com/changelog/post/2026-08-25-durable-object-alarm-abort-no-retry/)).
   - Therefore, **after every `await`, recheck `generationId`** before writing to the outbox or sending the next bubble.
5. **Debounce in the DO:**
   - Appends the message to the buffer (SQLite).
   - `setAlarm(min(now + silence, firstMsg + cap))`. Each new message reschedules the alarm.
   - Alarms have *at-least-once* execution, with exponential retry starting at 2 s, up to 6 times ([DO Base — alarm](https://developers.cloudflare.com/durable-objects/api/base/)), and must be **idempotent** ([Rules of DOs](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)).
6. **Turn** (in `alarm()`):
   - Snapshots the buffer and increments `generationId`.
   - Turns on "typing" with renewal.
   - Calls the LLM. An alarm handler has up to 15 min of wall time ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)). For steps with long retry/tooling, use a **Workflow**.
7. **Splitting + outbox:**
   - Generates the bubbles, persists `outbox[{seq, text, sendAt}]` and drains it by alarm.
   - Before each bubble: typing, wait, send.
   - Writes to `history` **only what was actually sent**.
   - Since the alarm is *at-least-once*, mark each `seq` as `sent` in storage right after sending and skip those already sent on a retry. That way no bubble goes out duplicated.
   - **Each DO has a single alarm**, and `setAlarm` overwrites the previous one ([Alarms API](https://developers.cloudflare.com/durable-objects/api/alarms/)). Different deadlines (end of debounce, outbox `sendAt`, watchdog) need to live in a deadlines table, with the alarm always pointing to **the nearest one**; on waking, the handler dispatches what has come due and reschedules. Alternative: the Agents SDK's `schedule()`, which multiplexes several schedules over the alarm **(unverified in this research)**.
8. **Interruption:**
   - A new message with a pending outbox or a generation in progress applies the policy in §9.4.
   - Results with a stale `generationId` are discarded.

### 9.2 Debounce (buffering fragmented messages)

**Values used by well-known projects**

| Source | Value |
|---|---|
| Chat SDK | default `debounceMs` **1500 ms** ([types.ts](https://github.com/vercel/chat/blob/main/packages/chat/src/types.ts)) |
| Cloudflare example (burst) | 600 ms ([CF docs](https://developers.cloudflare.com/agents/runtime/communication/chat-sdk/)) |
| OpenClaw | default **2000 ms**; **WhatsApp 5000 ms**; Discord and Slack 1500 ms; Telegram 300 ms ([OpenClaw messages](https://docs.openclaw.ai/concepts/messages)) |
| n8n template (WhatsApp + Redis) | wait of **3 s**, per-sender buffer, "am I still the last one?" check, 30 s lock and dedupe by ID ([n8n #19116](https://n8n.io/workflows/19116-debounce-and-buffer-whatsapp-ai-replies-with-redis-and-google-gemini/)); there are variants with Twilio ([n8n #2346](https://n8n.io/workflows/2346-enhance-customer-chat-by-buffering-messages-with-twilio-and-redis/)) |

- The claim that "the typical range is 3–10 s" comes from a search summary **(unverified)**.

**Recommendations**

These are our own choices, backed by the values above:
- **Silence window per channel:**
  - WhatsApp: 3–5 s, because people write "in bursts" there.
  - Telegram, Discord and Slack: 1.5–2 s.
  - Webchat: 1–1.5 s, with the typing signal.
  - Configurable per tenant.
- **Extend** the window on every new message (true debounce).
- **Hard cap** of 10–15 s from the first message, so the user is not left without an answer if they keep sending.
- **Immediate flush:**
  - **Commands and controls** (`/stop`, `/reset`), as OpenClaw does ([OpenClaw messages](https://docs.openclaw.ai/concepts/messages)).
  - **Media:** OpenClaw flushes immediately. On WhatsApp "photo + caption right after" is common, so I suggest keeping media in the buffer with a short window **(our suggestion)**.
- **"User typing" signal:**
  - Only **Discord** (`TYPING_START`) and **webchat** offer it.
  - On those channels, while there is a recent typing event (~10 s), postpone the flush, respecting the cap.
  - WhatsApp, Telegram and Slack do not expose this signal to bots **(unverified: absence)**.
- **Merge** in `ts` order, preserving line breaks and reply/quote references. Reply quoting the **last** message, which is OpenClaw's default.
- Do **not** mark as read or fire typing during the buffer. On WhatsApp, typing marks as read ([Typing indicators](https://developers.facebook.com/docs/whatsapp/cloud-api/typing-indicators)). Turn it on only at the start of the turn.

### 9.3 Splitting the reply into several messages (split)

**Algorithm**
- Follow OpenClaw's chunker ([OpenClaw streaming](https://docs.openclaw.ai/concepts/streaming)):
  - `minChars` and `maxChars` limits.
  - Cut preference: **paragraph → line → sentence → space → hard cut**.
  - **Never cut inside a code block.** If the cut is forced, close and reopen the *fence*.
  - A table that fits in `maxChars` stays in a single block.
- `maxChars` respects the channel's limit: WhatsApp and Telegram 4096, Discord 2000, Slack ≤4000, Instagram 1000 bytes, SMS per segment. The practical target stays well below: 300–600 characters per bubble **(our suggestion)**.
- Do not separate a list from its title; a short list stays whole.

**Where each bubble's limits come from:** ask the LLM for short paragraphs, separated by a blank line, and let the **deterministic splitter** guarantee the limits. Do not rely on the model alone.

**Pacing**
- Delay proportional to length: `delay = clamp(800 ms + 20–30 ms × characters, 800 ms, 4 s)` **(our suggestion)**.
- References: OpenClaw uses a random pause of 800–2500 ms in "natural" mode ([OpenClaw streaming](https://docs.openclaw.ai/concepts/streaming)); Teams recommends buffering tokens for 1.5–2 s when streaming ([Teams streaming](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/streaming-ux)).

**Bubble limit**
- **WhatsApp:**
  - Because of the pair rate limit (1 every 6 s on average, burst of 45 that "borrows" quota), use **at most 3–4 bubbles** per turn.
  - Handle **131056** with backoff of 4^X s ([Cloud API overview](https://developers.facebook.com/docs/whatsapp/cloud-api/overview)).
  - With a burst the quota is borrowed, and the next reply may hit the limit. Track a per-recipient "token bucket" in the DO.
- **Telegram:** ≥1 s between messages ([Bot FAQ](https://core.telegram.org/bots/faq)).
- **Slack:** ≥1 s per channel ([chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage)).
- **SMS:** preferably a single message, because of the per-segment cost.

**"Typing" between bubbles**

Sending a message clears the typing on WhatsApp, Telegram and Discord. You have to **turn it back on before each bubble**:

| Channel | Renewal |
|---|---|
| Telegram | every ~4 s (status lasts ≤5 s) |
| Discord | every ~8 s (lasts 10 s) |
| WhatsApp | one call covers 25 s, but **marks as read** |
| Slack | `setStatus` covers 2 min; clear at the end |
| Teams | no typing with a stream open |
| Webchat | own event |

**Splitting vs. native streaming:** where there is native streaming (Slack `chat.startStream`, Telegram `sendMessageDraft`, Teams 1:1, webchat), the tenant may prefer *stream* over *bubbles*. This stays as a per-channel option in the *capabilities*.

**Markdown conversion per channel** (generate an AST once and render per channel)
- WhatsApp: `*b*`, `_i_`, `~s~`; headings become a bold line; links as a raw URL; tables become lists ([WhatsApp FAQ](https://faq.whatsapp.com/539178204879377)).
- Telegram: HTML `parse_mode`, escaping only `<`, `>` and `&` ([Bot API](https://core.telegram.org/bots/api)).
- Slack: mrkdwn with `<url|text>`, escaping `&`, `<` and `>` ([Formatting](https://docs.slack.dev/messaging/formatting-message-text)).
- Discord: Markdown close to CommonMark **(unverified)**.
- SMS and Instagram: plain text.

### 9.4 Interruption (the user speaks while the bot is still sending)

**Observed options**
- **OpenClaw**, with an internal 500 ms debounce ([OpenClaw messages](https://docs.openclaw.ai/concepts/messages)):
  - `steer`: injects the message into the active turn.
  - `followup`: processes later.
  - `collect`: groups into a later turn.
  - `interrupt`: aborts and restarts.
- **Chat SDK:** in `queue` and `burst`, it processes the last message with the earlier ones in `context.skipped` ([Concurrency](https://chat-sdk.dev/docs/concurrency)).
- **Teams:** the user can click "Stop", and the bot receives 403 if it tries to continue the stream ([Teams streaming](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/streaming-ux)).
- **Telegram 10.3:** `can_stop` generates the `stopped_message_generation` update ([changelog](https://core.telegram.org/bots/api-changelog)).

**Recommended policy** (configurable default):
1. A new message arrives during **generation**: abort the LLM call with `AbortController`, increment `generationId`, merge the message into the buffer and reopen the debounce.
2. A new message arrives during **bubble sending**: **cancel the unsent bubbles** and do not cut a bubble already in flight. In practice: clear the outbox and increment `generationId` in the same synchronous stretch; the drain loop rechecks `generationId` after each `await` and stops if it changed. Write to history only the delivered bubbles and mark the turn as `interrupted`. Reopen the debounce.
3. In the next prompt, include in the history what the bot **actually said** and a short note that the reply was interrupted. That way the LLM resumes or adjusts without repeating itself.
4. Exception: if the new message is just an "ok", "👍" or a reaction, optionally **do not interrupt** and let the outbox finish. Heuristic or cheap classifier **(our suggestion)**.

### 9.5 Identity (the same person across several channels)

- **Per-channel key:** `(tenant, channel, userIdOnChannel)`.
  - On WhatsApp, use the **BSUID** (`user_id`), because `wa_id` may come omitted ([BSUID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids/)).
  - On Telegram, Discord and Slack, each platform's numeric or user ID.
- **Scope:** identity is **always per tenant**. The BSUID is already different across portfolios, so there is no way, nor reason, to unify across tenants.
- **Unification within the tenant:** only by **explicit link**. Examples:
  - the user asks in the webchat to "connect my WhatsApp" and receives an OTP or magic link on the other channel;
  - the tenant's CRM supplies the mapping.
- **Never** unify automatically by name. The phone number (when the `wa_id` or the SMS number exists) is a **hint** that requires confirmation **(our suggestion)**.
- Model: `Contact` (person in the tenant) 1 → N `ChannelIdentity`. History is kept per conversation, and long-term memory can be per `Contact`.
- LGPD (Brazil's General Data Protection Law): record consent to link channels and allow unlinking **(our suggestion; legal aspect not researched)**.

---

## 10. Risks

1. **Meta's AI policy (clause 4.7):** a "general-purpose assistant" on WhatsApp violates the terms. The demo and the README should show a **bounded business** use case ([Meta Terms](https://www.facebook.com/legal/Meta-Terms-for-WhatsApp-Business-Platform), [TechCrunch](https://techcrunch.com/2025/10/18/whatssapp-changes-its-terms-to-bar-general-purpose-chatbots-from-its-platform)).
2. **Multi-tenant onboarding barrier on WhatsApp:** becoming a Tech Provider requires company verification and App Review with videos ([Tech Providers](https://developers.facebook.com/docs/whatsapp/solution-providers/get-started-for-tech-providers)). For the portfolio, the realistic option is a test number with one tenant and the Embedded Signup flow implemented and documented, without going live.
3. **Pair rate limit vs. several bubbles on WhatsApp:** without control, 131056 appears and the reply is left half-sent. Mitigation: bubble limit, per-recipient token bucket and backoff ([overview](https://developers.facebook.com/docs/whatsapp/cloud-api/overview)).
4. **"Typing" marks as read on WhatsApp:** it changes the semantics of the blue ticks. Turn it on only when you are actually going to reply ([Typing](https://developers.facebook.com/docs/whatsapp/cloud-api/typing-indicators)).
5. **Unofficial WhatsApp libs:** ToS violation, bans and reputational risk in a public repo ([WhatsApp ToS](https://www.whatsapp.com/legal/terms-of-service)).
6. **Discord Gateway on a DO:**
   - Continuous cost (~US$ 4/month per bot beyond the allowance).
   - Divergent docs about the DO's lifetime with an outbound WebSocket.
   - A deploy drops the connection, which requires RESUME so as not to exceed 1000 IDENTIFYs per day ([Gateway](https://docs.discord.com/developers/events/gateway), [CF changelog](https://developers.cloudflare.com/changelog/post/2026-06-19-outbound-connections-keep-dos-alive/)).
7. **Intent review on Discord** from 10 thousand users per app ([Privileged Intent Review](https://docs.discord.com/developers/gateway/getting-started-with-privileged-intent-review)).
8. **Slack outside the Marketplace:** hard limits on `conversations.history`/`replies` ([Slack changelog](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/)). Some AI features require a paid plan ([AI apps](https://docs.slack.dev/ai/developing-ai-apps)).
9. **Duplicate or out-of-order webhooks:** retries from Meta (36 h or 7 days, depending on the page), Slack (3 times) and Telegram. They require idempotency and `ts` ordering in the DO.
10. **`waitUntil` has 30 s:** any long wait on a plain Worker is lost. Debounce and outbox **need** an alarm on a DO ([Context](https://developers.cloudflare.com/workers/runtime-apis/context/)).
11. **Platforms change fast:**
    - Telegram shipped 10.0 to 10.3 in 2026 alone ([changelog](https://core.telegram.org/bots/api-changelog)).
    - Meta's doc migrated to `/documentation/business-messaging/...`.
    - The Bot Framework was retired.
    - Mitigation: thin adapters, contract tests with recorded payloads.
12. **Chat SDK maturity** (beta, with very frequent releases), if it is partially adopted.
13. **24 h windows** (WhatsApp, Messenger, Instagram): proactive follow-ups require a paid template or tag. The orchestrator needs to know whether the window is open before scheduling sends.
14. **Per-tenant secrets** (bot tokens, App Secret): store encrypted and rotatable. Outside the scope of this research **(not researched)**.

---

## 11. Sources

**Meta / WhatsApp**
- https://developers.facebook.com/docs/whatsapp/cloud-api/typing-indicators
- https://developers.facebook.com/docs/whatsapp/pricing
- https://developers.facebook.com/docs/whatsapp/cloud-api/get-started
- https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started
- https://developers.facebook.com/docs/whatsapp/embedded-signup
- https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks
- https://developers.facebook.com/docs/graph-api/webhooks/getting-started
- https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages
- https://developers.facebook.com/docs/whatsapp/throughput
- https://developers.facebook.com/docs/whatsapp/cloud-api/messages/text-messages
- https://developers.facebook.com/docs/whatsapp/messaging-limits
- https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
- https://developers.facebook.com/docs/whatsapp/cloud-api/overview
- https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids/
- https://developers.facebook.com/docs/whatsapp/solution-providers/get-started-for-tech-providers
- https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media
- https://developers.facebook.com/documentation/business-messaging/whatsapp/changelog
- https://www.facebook.com/legal/Meta-Terms-for-WhatsApp-Business-Platform
- https://techcrunch.com/2025/10/18/whatssapp-changes-its-terms-to-bar-general-purpose-chatbots-from-its-platform
- https://www.whatsapp.com/legal/terms-of-service
- https://faq.whatsapp.com/539178204879377
- https://developers.facebook.com/docs/messenger-platform/send-messages/sender-actions
- https://developers.facebook.com/docs/messenger-platform/policy/policy-overview
- https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api

**Unofficial WhatsApp and BSPs**
- https://github.com/WhiskeySockets/Baileys
- https://github.com/pedroslopez/whatsapp-web.js
- https://github.com/EvolutionAPI/evolution-api
- https://github.com/devlikeapro/waha
- https://github.com/oxidezap/baileyrs-cloudflare-example
- https://github.com/rafaelsg-01/whatsapp-cloudflare-workers
- https://www.twilio.com/en-us/whatsapp/pricing
- https://www.twilio.com/en-us/changelog/whatsapp-typing-indicator
- https://www.twilio.com/docs/whatsapp/api/typing-indicators-resource
- https://www.twilio.com/en-us/changelog/v3-typing-indicator-api
- https://www.twilio.com/docs/glossary/what-sms-character-limit
- https://docs.360dialog.com/docs/get-started/sandbox.md
- (third-party, not primary) https://medium.com/@adityadeepa634/the-developers-guide-to-the-whatsapp-cloud-api-sandbox-2026-edition-c967ce0bf671

**Telegram**
- https://core.telegram.org/bots/api
- https://core.telegram.org/bots/api-changelog
- https://core.telegram.org/bots/faq
- https://grammy.dev/hosting/cloudflare-workers-nodejs
- https://grammy.dev/guide/deployment-types

**Discord**
- https://docs.discord.com/developers/resources/channel
- https://docs.discord.com/developers/events/gateway
- https://docs.discord.com/developers/topics/gateway
- https://docs.discord.com/developers/topics/rate-limits
- https://docs.discord.com/developers/interactions/receiving-and-responding
- https://docs.discord.com/developers/gateway/getting-started-with-privileged-intent-review
- https://docs.discord.com/developers/resources/message

**Slack**
- https://docs.slack.dev/apis/events-api/
- https://docs.slack.dev/reference/methods/assistant.threads.setStatus
- https://docs.slack.dev/reference/methods/chat.postMessage
- https://docs.slack.dev/reference/methods/chat.startStream
- https://docs.slack.dev/ai/developing-ai-apps
- https://docs.slack.dev/authentication/verifying-requests-from-slack
- https://docs.slack.dev/messaging/formatting-message-text
- https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/

**Microsoft Teams**
- https://learn.microsoft.com/en-us/microsoftteams/platform/bots/streaming-ux
- https://learn.microsoft.com/en-us/azure/bot-service/what-is-new?view=azure-bot-service-4.0
- https://learn.microsoft.com/en-us/azure/bot-service/bot-service-resources-faq-availability?view=azure-bot-service-4.0

**Cloudflare**
- https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
- https://developers.cloudflare.com/changelog/post/2026-06-19-outbound-connections-keep-dos-alive/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://developers.cloudflare.com/durable-objects/api/base/
- https://developers.cloudflare.com/durable-objects/api/alarms/
- https://developers.cloudflare.com/changelog/post/2026-08-25-durable-object-alarm-abort-no-retry/
- https://developers.cloudflare.com/durable-objects/api/state/
- https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/workers/runtime-apis/context/
- https://developers.cloudflare.com/workers/best-practices/workers-best-practices/
- https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
- https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/
- https://developers.cloudflare.com/agents/runtime/communication/chat-sdk/
- https://developers.cloudflare.com/agents/communication-channels/email/
- https://developers.cloudflare.com/email-service/platform/limits/
- https://developers.cloudflare.com/changelog/post/2025-03-12-reply-limits/

**Vercel Chat SDK** (code read from the repo clone on 2026-10-03)
- https://github.com/vercel/chat
- https://chat-sdk.dev/docs
- https://chat-sdk.dev/docs/concurrency
- https://chat-sdk.dev/docs/platform-adapters
- https://github.com/vercel/chat/blob/main/packages/chat/src/chat.ts
- https://github.com/vercel/chat/blob/main/packages/chat/src/types.ts
- https://github.com/vercel/chat/blob/main/packages/adapter-telegram/src/index.ts
- https://github.com/vercel/chat/blob/main/packages/adapter-telegram/README.md
- https://github.com/vercel/chat/blob/main/packages/adapter-discord/package.json
- https://github.com/vercel/chat/blob/main/apps/docs/content/docs/streaming.mdx
- https://github.com/vercel/chat/blob/main/apps/docs/content/docs/api/chat.mdx
- https://github.com/vercel/chat/tree/main/apps/docs/content/adapters
- https://github.com/vercel/chat/blob/main/apps/docs/content/adapters/official/discord.mdx
- https://github.com/vercel/chat/blob/main/apps/docs/content/adapters/official/whatsapp.mdx
- https://github.com/vercel/chat/blob/main/apps/docs/content/adapters/official/telegram.mdx
- https://github.com/vercel/chat/blob/main/apps/docs/content/adapters/official/instagram.mdx
- https://github.com/vercel/chat/blob/main/apps/docs/content/adapters/community/cloudflare-do.mdx

**Pattern references (debounce/splitting)**
- https://docs.openclaw.ai/concepts/messages
- https://docs.openclaw.ai/concepts/streaming
- https://github.com/openclaw/openclaw
- https://n8n.io/workflows/19116-debounce-and-buffer-whatsapp-ai-replies-with-redis-and-google-gemini/
- https://n8n.io/workflows/2346-enhance-customer-chat-by-buffering-messages-with-twilio-and-redis/
