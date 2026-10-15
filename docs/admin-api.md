# Admin API

The owner's JSON API for the configuration commands (ADR-0013, Story 3.10). It runs as the `kelpie-admin-api` Worker, behind a Cloudflare Access application, and the setup agent's tools (Story 3.11) call the same commands.

## How a request is trusted

1. **Access.** Cloudflare Access lets only the people its policy allows reach the Worker, and adds a signed JWT in the `Cf-Access-Jwt-Assertion` header.
2. **The JWT.** The Worker verifies it on every request:
   - the algorithm is RS256, and the signature matches a key published at `<team domain>/cdn-cgi/access/certs`;
   - the issuer is the team domain, and the audience includes the application's AUD tag;
   - the token is within its validity window, with 60 s of leeway;
   - it was issued to a person, because a service token has no `sub`.

   If the team domain or the AUD tag isn't configured, every request is refused.
3. **The origin.** The Access cookie can go with another site's POST: its SameSite is the Access application's setting, `None` by default, and SameSite counts every hostname under the same registrable domain as one site anyway. So every JSON endpoint also refuses:
   - a request from another origin, with `403 cross_origin`: a `Sec-Fetch-Site` other than `same-origin` or, without it, another `Origin`. Clients such as `cloudflared access curl` send neither, and pass;
   - a request whose `Content-Type` isn't `application/json`, with `415 not_json`, even with no body. No HTML form can send that type, and another origin's `fetch` with it needs a CORS preflight, which Access refuses by default and the Worker answers with `404` and no CORS headers. Leave the Access application's CORS settings empty: if Access answered preflights for another origin, only the origin check would stand.
4. **The `Directory`.** It admits the token's `sub` as an identity from the `cloudflare-access` source, for the agent id `*`, which names no agent. Owner-only commands check the admitted role (ADR-0015). Emails are never compared.

No configuration command can add, enable or replace an Access identity. The first-run bootstrap adds the owner's, and a token-gated recovery replaces it ("Recovering access").

## Endpoints

Every endpoint is a `POST` with a JSON body and `Content-Type: application/json`. Send the header even to a command that takes no input.

| Endpoint | Input |
|---|---|
| `/commands/listAgents` | none |
| `/commands/createAgent` | `{ "id": "sales", "name": "Sales" }` |
| `/commands/renameAgent` | `{ "id": "sales", "name": "Sales team" }` |
| `/commands/getAgent` | `{ "id": "sales" }` |
| `/commands/configureAgent` | `{ "id": "sales", "settings": { "systemPrompt": "…", "quietMs": 5000, "qualifier": "jev" } }` |
| `/commands/getModels` | none; the instance's model settings, the provider pinned as the default, and the providers with a key (#289) |
| `/commands/configureModels` | `{ "settings": { "conversation": { "tier": "medium" }, "memory": { "tier": "cheap" } } }`; replaces the instance's model settings, which every agent follows unless it has its own. A provider without a key answers `409 no_key` |
| `/commands/setMainAgent` | `{ "id": "sales" }`; makes the agent Master, the one the owner talks to (ADR-0036 §1). The previous one becomes a specialist that keeps its chat |
| `/commands/setAgentChat` | `{ "id": "sales", "chat": true }`; lets the owner reach a specialist on its channels, or stops it. Admin and Master always chat |
| `/commands/deleteAgent` | `{ "id": "sales" }`, or with `"ids": ["sales", …]`, the agents you expect it to delete; deletes the agent and its subagents for good ("Deleting an agent"). It answers `{ "deleted", "webhooksLeft", "everyThread" }`. Admin, Master and an `ids` that no longer matches answer `409 not_allowed`; a deletion cut short answers `503 unavailable`, and running it again finishes it |
| `/commands/createTask` | `{ "agentId": "sales", "title": "Book the flights", "body": "…", "status": "todo", "scheduledStartAt": 1793000000000 }`; queues work on the agent's task board ("Tasks"). `status` is `backlog`, the default, or `todo`, and `body` and `scheduledStartAt`, in milliseconds since the epoch, are optional |
| `/commands/editTask` | `{ "agentId": "sales", "taskId": "…", "title": "…" }`, with any of `title`, `body` and `scheduledStartAt`, `null` clearing the start; only in Backlog or To do |
| `/commands/moveTask` | `{ "agentId": "sales", "taskId": "…", "status": "todo" }`; between `backlog` and `todo` only |
| `/commands/commentTask` | `{ "agentId": "sales", "taskId": "…", "text": "…" }`, at any status |
| `/commands/requestStop` | `{ "agentId": "sales", "taskId": "…" }`; asks the agent to stop a running task, which ends in Cancelled within 2 minutes unless its run finishes it first. A waiting one is cancelled at once |
| `/commands/listTasks` | `{ "agentId": "sales" }`, or with `"status": "todo"`; the 200 most recently changed |
| `/commands/getTask` | `{ "agentId": "sales", "taskId": "…" }`; the task with its comments, history and runs. An unknown task answers `404 unknown_task`, and a change the rules don't allow `409 not_allowed` |
| `/commands/listIdentities` | none |
| `/commands/enableIdentity` | `{ "channel": "telegram", "channelUserId": "…" }`; re-enables a disabled identity, never a pending one |
| `/commands/disableIdentity` | same as `enableIdentity` |
| `/commands/setTimeZone` | `{ "timeZone": "America/Sao_Paulo" }`, an IANA name. Offsets like `+03:00` are refused; prefer a city name to `Etc/GMT±N`, whose sign is inverted (`Etc/GMT+3` is UTC-03:00) |
| `/commands/connectTelegram` | `{ "agentId": "sales" }`; answers `{ "path": "/forms/<token>", "expiresAt": … }` |
| `/commands/pairTelegram` | `{ "agentId": "sales" }`; answers `{ "link": "https://t.me/<bot>?start=<code>", "expiresAt": … }` (see "Pairing") |
| `/commands/registerTelegramWebhook` | `{ "agentId": "sales" }`; points the agent's bot at ingress again, after a failed registration or a new ingress hostname |
| `/commands/connectRunner` | none; answers `{ "path": "/forms/<token>", "expiresAt": … }`, a secure form for the VPS runner's secret ([runner.md](runner.md)). `503 not_configured` when `channel-egress` was deployed without the runner's VPC Service |
| `/commands/describeRunner` | none; the runner's state, as `{ "state" }` with its `version` and `protocol` once it answered: `ready`, `outdated` (it speaks another protocol version), `refused` (it no longer takes the stored secret), `unreachable`, `not_connected` (no secret given yet) or `not_configured` |
| `/commands/listHeldFiles` | none; the vault's files pushed with conflict markers that still wait, as `{ "path", "state": "held" \| "proposed", "attempts", "at" }` ([context-store.md](context-store.md)) |
| `/commands/forgetVaultPaths` | `{ "paths": ["memory/people/ana.md", "memory/old/"] }`, at most 1,000; a path ending in `/` names a folder. After you rewrote the vault's history, Kelpie forgets its copies of them; answers `{ "forgotten": <rows>, "stillInVault": [<named files the vault still has>] }` (see "Erasing content" in [context-store.md](context-store.md#erasing-content)) |
| `/commands/setDream` | `{ "mode": "off" }`, or `{ "mode": "dry", "writes": ["abstracts"] }`, where `dry` is the default and `writes` is optional. Turns Dream, memory's consolidation, off or on. `writes` names the operations that may write: only `abstracts` for now, since `summaries` and `merges` wait on #182's measurement. The others only propose: the daily memory report shows the abstracts' plan, and `memory/_lint/dream.md` the day summaries and merges. Off forgets `writes`, so each operation is dry again until named, and deletes what Dream proposed. It answers `{ "mode", "writes" }` ([memory-format.md](memory-format.md#dream)) |
| `/bootstrap` | `{ "token": "…" }` |
| `/recover` | `{ "token": "…" }`, with the recovery token ("Recovering access") |

**Answers:**
- A success is `200 { "ok": true, "value": … }`; the bootstrap answers `201`.
- A refusal is `{ "ok": false, "reason": … }`, with its HTTP status:

| Status | Reasons |
|---|---|
| 400 | `invalid_input`, `invalid_identity`, `invalid_json`, `invalid_user` |
| 401 | `unauthenticated` |
| 403 | `forbidden`, `no_owner`, `invalid_bootstrap_token`, `invalid_recovery_token`, `cross_origin` (sent from another origin's page) |
| 404 | `unknown_agent`, `unknown_identity`, `unknown_user`, `not_found` |
| 409 | `not_paired` (a pending identity; pair it instead), `not_connected` (the agent has no bot), `identity_taken` (a recovery to a login another user holds), `not_allowed` (the agent's role doesn't take the change, such as Admin as Master), `no_key` (a model setting names a provider llm-gateway has no key for) |
| 410 | `bootstrap_disabled`, `recovery_token_spent` |
| 413 | `too_large` |
| 415 | `not_json` (a `Content-Type` other than `application/json`) |
| 502 | `channel_refused` (Telegram refused, or couldn't be reached) |
| 503 | `unavailable` (the secret store can't be reached, or Access's keys couldn't be loaded), `not_configured` (`channel-egress` was deployed without ingress's origin, or the vault is off) |

Identity values in answers are masked.

**Waiting for the rest of a message.** An agent answers `quietMs` after the owner's latest message, 10 s by default, and each new message starts the wait again. Its `maxWaitMs`, 60 s by default, caps the wait from the first buffered message; a `quietMs` above it is cut to the cap. `quietMs: 0` removes the wait: each message is processed at once. Nothing else starts before the wait ends, the memory recall included (ADR-0024). No end-of-turn decision is asked of a qualifier (ADR-0024). `conversational: false` answers each message at once.

**The model.** `model` sets the agent's provider, tier and effort (ADR-0036 §2), for example `{ "provider": "openai", "conversation": { "tier": "frontier", "effort": "high" }, "memory": { "tier": "cheap" } }`.
- **Areas:**
  - `conversation` covers the agent's turns;
  - `memory` covers its history checkpoints.
- **What each scope sets:** tier and effort are set per area, so a costlier conversation never makes the agent's memory costlier. `provider` covers both areas, and an area may name its own.
- **Unset fields** come from the instance's settings (`configureModels`), then the defaults:
  - the provider is the first one llm-gateway saw with a key, in the cheap tier's order, pinned then. The pin leads every tier, so a route table that lists another provider first in `medium` or `frontier` follows the pin there too;
  - the tier is `cheap`;
  - the effort is the model's own.
- **An effort a model doesn't take** is lowered to the nearest one it does.
- **The older `tier` setting** still counts as `model.conversation.tier` when `model` doesn't set one.

**When a route fails** (ADR-0037 §4, #293), the conversation hears it from Kelpie, in its language:
- **Fallback.** A route that fails before answering hands the turn to the tier's next one: on a rate limit, an outage, or credits that ran out or a spend limit reached. A refused key ends the turn. After the reply, a notice names the route that failed, why, and the one that answered. A conversation hears the same route and reason at most once a day.
- **No route answered.** The person gets a notice in place of a reply, naming each route the call tried and its reason. The next message is answered as usual.
- **Stopping instead.** `MODEL_FALLBACK: "off"` in `llm-gateway`'s `wrangler.jsonc` ends a turn at the first failed route, with the notice. Any other value falls back.
- Calls that aren't a conversation's, such as history checkpoints and Dream, follow the same setting without a notice. Only a call that ends in a failure is logged, never a fallback along the way.

**Tools.** A turn may run the agent's tools for up to 5 rounds, within `toolLoopMs`: 120 s by default, the floor, up to 600 000 (ADR-0025). Past either bound, one last model call answers with what it has. In the webchat, the turn shows its step once the wait is over: reading memory, thinking, or the tool it runs. Telegram shows "typing".

**The memory core.** `memoryCore: true` carries the agent's always-loaded core into every turn, and it is off by default (#112, [memory-format.md](memory-format.md#retrieval)).
- **What it holds:** the notes the owner pinned, the owner's profile and the agent's self-model, within 1,000 tokens.
- **When it loads:** once per conversation, and again at each checkpoint.
- **Turning it on or off** starts a new prompt version, like a new `systemPrompt`, so it applies from the next turn.

**Formatting** (#188). Replies show a small Markdown subset in the webchat and on Telegram: bold, italics, inline code, code blocks, bullet and numbered lists, and headings as bold. The runtime reads it, and the model's text is never passed on as markup:
- the webchat builds the reply as elements on the page;
- Telegram gets its own HTML, every text escaped. If Telegram can't read it, or it holds more formatting than Telegram reads (about 100 spans), the reply goes without formatting or links, its addresses still in code;
- raw HTML stays text.

A web address (http or https) shows as a link only when it is in the turn's inputs, or the admin API's origin (`ADMIN_ORIGIN`) starts it as written, whose pages only show behind Access:
- the inputs are the owner's messages and their own notes in the memory block, the same that may be previewed (#130);
- any other address, whether the model wrote it or a tool or a note it read gave it, shows as code, with its label, so the owner sees where it points;
- Telegram links addresses in plain text by itself, with or without a scheme (`example.com/login`, `www.example.com`), so on Telegram any text it could read as an address goes in code too. Emails, `@mentions`, hashtags and phone numbers still show as Telegram finds them;
- Kelpie's fixed notices, such as a confirmation's, are never formatted. On Telegram the addresses they quote go in code all the same. The exception is a link Kelpie sends itself, such as a secure form's ("Setup agent"): its own link shows as a link, and any other address in it shows as text;
- a reply replayed in the webchat links what the owner had sent before it among the replayed messages, and their notes its turn recalled;
- a URL hidden behind text in a Telegram message the owner sent (a `text_link`) doesn't count yet (#190).

**Languages.** Kelpie's own texts come in English, Brazilian Portuguese or Spanish (#187, ADR-0027). Any other language gets English. This covers its notices, the confirmation, the link bubbles, the paused message, the limit text, the tool labels and the pages behind its links. The model's replies follow the person by themselves.
- **In a chat,** a text follows the conversation's language: what the person's latest messages are written in. It stays the same while those messages say nothing clear, such as "ok" or a code.
  - Before anything is clear, it follows the device's language: the Telegram app's, or the webchat browser's.
  - A text is written in the language of its moment, and isn't rewritten later.
- **A page** behind a link Kelpie sent (the secure form, the pairing page) opens in the conversation's language, which the link names (`?lang=`). Its answer keeps that language. Opened by hand, a page follows the browser's first language.
- **The webchat page's own texts** follow the browser.
- **Telegram's notices:**
  - "paired" follows the language of the account that paired;
  - a stranger notice follows the language the owner's account was last seen in.
- **Not covered yet:** the vault's own texts (its README and pull requests) and session pages stay in English.

**Pausing.** `/pause` on Telegram (also `/pause@<bot>`), or the webchat's Pause button, holds every answer until the owner's next message (#134). A pause while paused changes nothing, and Telegram's redelivery of the same `/pause` is ignored.
- A turn in flight is interrupted, and the planned answer is cancelled.
- Telegram confirms with a short fixed message, not from the model. The webchat shows the pause.
- The next message is answered together with the buffered ones, after the usual wait. The cap counts from that message.

## Tasks

Each agent has a task board in its `AgentHost` (ADR-0011, #54). The `AgentHost` is the only writer of a task's status, and the commands above are how people reach it.

- **What people do:**
  - create a task in Backlog or To do, and edit it while it is in either;
  - move it between the two, and comment at any time;
  - ask the agent to stop a running task.

  From In progress on, only the agent moves a task.
- **Pickup.** A task in To do is eligible at once, or at its scheduled start. The `AgentHost` claims eligible tasks in order of their scheduled start, or creation, while fewer than the agent's `maxConcurrentTasks` run. That setting is 3 by default and at most 10; the setup agent asks the owner before changing it, as for any setting. A task in Waiting holds no slot.
- **Leases.** A claim leases the task for 15 minutes and opens a run, with a random token its reports must carry. The run's heartbeat extends the lease, but never past 2 hours from the run's start.
  - A lease that runs out is swept on the next wake, and the attempt counts as failed.
  - Two failed attempts in a row put the task in Waiting, with the reason `failed`.
  - A run that couldn't start counts as a failed attempt, and is tried again at a wake a minute later. A pass of pickup stops after three such runs.
  - After the owner's stop, the run's lease lasts at most 2 more minutes, whatever its heartbeat: then the task ends in Cancelled, unless the run finished it first.
- **Done needs a result.** Every change goes into the task's history, with who made it and through what.
- **Runs** (#335). Each run is a conversation of its own, named `<agent>:task:<task id>`.
  - **What it reaches:** no person and no channel. It isn't captured into memory either, because the task is its record.
  - **What it starts with:** the task and its newest comments. A task or comment another agent wrote comes as data, never as the owner's instructions.
  - **How it ends the task:** with `complete_task` and the result, `wait_on_task` and a question, or `cancel_task` and a reason. A turn that leaves the task running gets one nudge from Kelpie; a second such turn counts as a failed attempt.
  - **What reaches it mid-run:** a comment joins its next round. The owner's stop ends its turn at once, and the task is cancelled.
  - **What it can't do:** confirm anything. Admin's and Master's own tools aren't in it.
- **Between agents.** An agent hands work to an agent it owns with `create_task`, which records both agents and the person it acts for.
  - **The mandatory handoff** (ADR-0036 §4, #287). An agent's prompt lists the specialists it owns, by id and name, with each one's remit, or "no remit set". A demand within a remit goes to that specialist as a task, even when the owner didn't name it. A specialist with no remit takes work only when the owner names it.
  - **Kelpie announces it.** After the reply, Kelpie names the agent that has the work, by name and id, in the conversation's language: `Kelpie handed a task to "Sales" (sales).` The text is Kelpie's own, so the model can't change or omit it. A turn that sends no reply, because it was refused or cut short, leaves the notice for the next reply in that conversation.
  - **An agent it doesn't own** is refused, and the refusal lists the ones it does own. No task goes to another agent in its place.
  - **Who hears the news:** the agent that created the task; for a task a person created, the assignee's owner, or the assignee itself. Kelpie tells it, in the owner's latest conversation with it, when the task is done, cancelled by its agent, waiting for an answer, or failed twice. A `dependency` wait reaches no one.
  - **How it answers:** with `comment_task`. A comment on a waiting task, by a person or an agent, puts it back in To do.

## Pairing

No command takes an identity value to admit someone: the owner proves an account is theirs by sending the bot a code from where they are already signed in (Story 3.6).

1. `pairTelegram` answers with `https://t.me/<bot>?start=<code>`.
   - The code is 8 characters from an alphabet without look-alikes, and lasts an hour.
   - Only its salted SHA-256 is kept, and a new code replaces the last one.
2. The owner opens the link in Telegram, which sends the bot `/start <code>`.
3. A match makes that Telegram account the owner's, enabled, and the bot answers with a fixed "paired" notice. The `/start` never reaches the model.

**From the setup agent.** Its `pair_telegram` tool links to `https://<admin hostname>/pair/telegram/<agent id>`, a page behind the same Access login and owner check as the secure forms:
- a `GET` shows a button, and pressing it is the owner's own yes;
- the page's own `POST` (`Sec-Fetch-Site: same-origin` or, without it, a matching `Origin`, form-encoded) runs `pairTelegram` and shows the `t.me` link. A `POST` with neither header is refused: current browsers send at least one;
- without a connected bot, the page says to connect it first.

A code pairs an account with the owner, not with one agent: any of the owner's Telegram bots accepts it, and the paired account reaches every agent.

What a sender who isn't paired gets:
- **Nothing**, ever.
- **A wrong code** counts against that sender only. Five wrong codes with no hour-long pause between them lock that sender out of pairing for an hour; there is no reset command. A stranger's guesses can't lock the owner's account. The owner can lock only the account they are pairing, by mistyping five times.
- **The owner is told about each stranger once**, on the owner's own chat with the bot. That starts once the owner has paired a Telegram account. At most ten notices a day per channel; a stranger is remembered for 30 days. A notice that can't be sent, for example because the owner never opened that bot, doesn't count. The notice has the stranger's name, kept to letters and digits, and their id masked.

## Secure forms

A channel's secret, such as a Telegram bot token, never goes through a command, a conversation or a log (ADR-0013).
1. `connectTelegram` answers with the path of a one-time form, for example `/forms/<token>`.
2. The owner opens `https://<admin hostname>/forms/<token>` in a browser. It is behind the same Access login and owner check as the commands.
3. The owner pastes the token from BotFather. The admin API passes it straight to `channel-egress`'s `ChannelForms` entrypoint, which checks it with Telegram (`getMe`) and stores it encrypted (`docs/secrets.md`).
4. `channel-egress` then registers the bot's webhook, so Telegram sends the bot's messages to ingress. If that fails, the page says why. The token stays stored, and `registerTelegramWebhook` tries again.

The link expires after 15 minutes, works once, and closes after five refused tokens. For 15 minutes after it is used:
- **The same token sent again,** as a second click sends it while the first is still on its way, gets the same "connected" page, and the bot's webhook is registered again.
- **Any other value is refused.**
- **The link opened again** says which bot it connected, instead of "This link no longer works".

The token is stored, and the webhook registered, even when the browser drops the request.

**The runner's form** works the same way, from `connectRunner`. The owner pastes the secret from the runner's server ([runner.md](runner.md)), and `channel-egress` checks it with the runner's `/health` before storing it:
- a secret the runner refuses counts against the form, as a refused bot token does;
- a runner that can't be reached leaves the form open, and doesn't count;
- an outdated runner's secret is stored, and the page asks for an update.

Form pages are HTML:
- they are sent with `Cache-Control: no-store`, `Referrer-Policy: same-origin` and a Content-Security-Policy that forbids framing and scripts;
- a submission must come from the page itself (`Sec-Fetch-Site: same-origin` or, without it, a matching `Origin`) and be form-encoded. A `POST` with neither header is refused: current browsers send at least one;
- no page repeats the token.

## Setting it up

1. **Deploy the other Workers first, in this order.** Each one's bindings point only at Workers before it:
   1. `llm-gateway`, with a model key (`docs/secrets.md`). To send its calls through AI Gateway:
      - create a gateway with "Require provider credentials" (`byok_only`), so a missing key fails instead of billing Cloudflare credits;
      - pass each provider's passthrough URL as a flag, for example `--var OPENAI_BASE_URL:https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/openai`. The deploy workflow carries it to later deploys (`docs/deploy.md`). A deploy by hand without it sends calls straight to the provider, without a warning;
      - if the gateway requires authentication, set `AI_GATEWAY_TOKEN` to a Cloudflare API token with only `AI Gateway Run`. Such a token works on every gateway in the account. The Worker sends it only to `gateway.ai.cloudflare.com`.

      **Qualifier.** The agent's typed decisions, such as the memory rerank (#110), go through the qualifier its `qualifier` setting picks. Change it with `configureAgent`.
      - **`clef`, the default:** Cloudflare's Clef model on Workers AI, through `llm-gateway`'s `AI` binding.
        - It needs no key and is billed as Workers AI usage on the account.
        - `CLEF_MODEL` pins the model: `clef` by default, or `clef-flash`, which is faster.
        - Cloudflare doesn't use the inputs to train or improve models.
      - **`jev`:** Jev on TypeSafe's API (ADR-0018).
        - Set the optional `TYPESAFE_API_KEY` to a key from TypeSafe's console.
        - TypeSafe keeps data with zero retention only on enterprise plans.
        - An agent set to `jev` without the key falls back to each decision's deterministic default.

      Either way, `llm-gateway` masks emails, long numbers, link query strings and token-like strings in the state first. Names, addresses and numbers written in words still go out.

      **Embeddings.** Memory's vector search (#110) embeds notes and questions through `llm-gateway`'s `embed`. The `EMBEDDING_PROVIDER` var chooses the model for the whole vault:
      - **`workers-ai`, the default:** BAAI's multilingual `bge-m3` on Workers AI, 1,024 dimensions. It needs no key and is billed as Workers AI usage. Cloudflare doesn't use the inputs to train or improve models.
      - **`openai`:** OpenAI's `text-embedding-3-small`, 1,536 dimensions, through `OPENAI_BASE_URL`. It needs `OPENAI_API_KEY`. The notes' text, personal data included, then goes to OpenAI, and through AI Gateway when that is configured; their retention policies apply.

      Each text is cut to its first 6,000 characters. Vectors are kept per model, so changing the var means every note is embedded again.
   2. `channel-egress`, with its `SECRETS_KEY` and `--var INGRESS_ORIGIN:https://<ingress hostname>` (`docs/secrets.md`);
   3. `context-store`, with the vault's GitHub App values and secrets (`docs/context-store.md`). Without them it runs with the vault off. It calls `llm-gateway` for memory's embeddings and rerank;
   4. `conversation-runtime`, with `--var ADMIN_ORIGIN:https://<admin hostname>`, so the setup agent can link to the secure form and the pairing page ("Setup agent"). The deploy workflow carries it to later deploys (`docs/deploy.md`). Without it, the setup agent says it can't give those links;
   5. `ingress`, with `--domain <ingress hostname>`. Telegram's and GitHub's webhooks reach it there; like the admin API, it has no `workers.dev` URL. Later deploys keep the domain without the flag, and the deploy workflow carries the webchat's Access values once they are set ("Webchat").
2. **Create a self-hosted Access application** for the admin API's hostname, with a policy that allows only the owner. Do this before step 4: whoever passes Access and holds the token becomes the owner. Note the team domain (`https://<team>.cloudflareaccess.com`) and the application's AUD tag.
3. **Keep the instance's values out of the repository.** The hostname and the Access values belong to one deployment, so they go in as flags when deploying (step 5), and `wrangler.jsonc` stays the same for every instance:
   - `--domain <admin hostname>`: a custom domain on one of the owner's zones. Wrangler creates its DNS record. `workers_dev` and preview URLs stay off.
   - `--var ACCESS_TEAM_DOMAIN:https://<team>.cloudflareaccess.com` and `--var ACCESS_AUD:<aud>`. Wrangler splits each value at its first colon, so the URL arrives whole.
4. **Make the bootstrap token.** It is `<expiry in epoch seconds>.<random>`, and here it is valid for 24 hours. Keep the shell open: steps 5 and 6 use the same variable.
   ```bash
   BOOTSTRAP_TOKEN="$(( $(date +%s) + 86400 )).$(openssl rand -hex 32)"
   ```
5. **Deploy, with the token as the Worker's required secret.** The token goes through a file only you can read, which is deleted right after:
   ```bash
   ( umask 077; printf 'BOOTSTRAP_TOKEN=%s\n' "$BOOTSTRAP_TOKEN" > /tmp/kelpie-admin-api.secrets )
   ```
   ```bash
   bunx wrangler deploy -c apps/admin-api/wrangler.jsonc --secrets-file /tmp/kelpie-admin-api.secrets --domain admin.example.com --var ACCESS_TEAM_DOMAIN:https://<team>.cloudflareaccess.com --var ACCESS_AUD:<aud>
   ```
   ```bash
   rm /tmp/kelpie-admin-api.secrets
   ```
   The deploy workflow carries the `--var` values to later deploys, and Wrangler keeps the custom domain when a deploy names none (`docs/deploy.md`). A deploy by hand without the `--var` flags removes the vars, and every request is refused again.
6. **Register as the owner.** `cloudflared access curl` opens the Access login and sends its token:
   ```bash
   cloudflared access curl https://<admin hostname>/bootstrap -X POST -H 'content-type: application/json' -d "{\"token\":\"$BOOTSTRAP_TOKEN\"}"
   ```
   The bootstrap works once. If the token expired first, make a new one (step 4) and replace the secret with `printf %s "$BOOTSTRAP_TOKEN" | bunx wrangler secret put BOOTSTRAP_TOKEN -c apps/admin-api/wrangler.jsonc`.
7. **Keep the secret; delete the local copy.** Delete the file or shell variable that holds the token.
   - The Worker's `BOOTSTRAP_TOKEN` stays. `wrangler.jsonc` lists it in `secrets.required`, so `wrangler deploy` refuses to deploy without it, and deleting it would make every later deploy fail.
   - It is harmless where it is: `/bootstrap` answers `410` once an owner exists, and the token stops being accepted at the expiry it carries.

## Setup agent

Every instance has a built-in agent, `setup`, to configure Kelpie by talking to it: open `https://<ingress hostname>/webchat/?agent=setup` once the webchat is set up ("Webchat"). It guides a first setup: it connects Master's Telegram bot, and pairs the owner's Telegram account (Story 3.11, ADR-0013).

**Roles** (ADR-0036 §1, #288). Each agent has a role, which `listAgents` shows:
- **`admin`:** the setup agent, by its id.
- **`main`:** Master, the agent the owner talks to. The owner named the role Master (#343); `main` stays its value.
  - A new instance starts with one, `kelpie`, named Kelpie.
  - An instance that already had agents has none until the owner picks one with `setMainAgent`.
  - The previous Master becomes a specialist that keeps its chat.
- **`specialist`:** every other agent, owned by Master.
  - One created now doesn't chat until `setAgentChat` turns its chat on.
  - Agents that existed before roles keep their chat.
- **Master's own tool:** `set_agent_model` changes another agent's model settings, when the owner asks or agrees with its suggestion, behind the same confirmation (#289). No agent changes its own model, except Admin, through `configure_agent`.
- **The check is at `admit`:** a chat its role doesn't allow answers `no_grant`, so a specialist whose chat is off doesn't answer its bot or the webchat.

**Subagents** (ADR-0036 §5, #290). An agent with `spawn` creates temporary subagents for a demand, with `create_subagent`, and hands them work with `create_task`. Master has `spawn` by its role. A specialist has it only when Admin's `configure_agent` turns it on, which takes the owner's confirmation. Admin and subagents never have it. Only the owner's own turns in a direct conversation create a subagent or hand off a task.
- **What a creator gives one:** a name, a soul, a one-line remit and up to 10 skills, kept on its own `AgentHost`, not in the vault. Kelpie picks its id, from the creator's.
- **What it can never exceed:** its creator's tier and effort, field by field, on the creator's route. That is checked when it is created and at every turn, with the last limits read when the creator doesn't answer, and the cheapest tier when nothing was ever read. It starts at the cheapest tier unless its creator asks for more.
- **What it holds:**
  - a subagent's tools only, `memory_search`, `memory_read` and its task tools, and only those of them its creator may use;
  - read-only memory, on its creator's scopes;
  - no channel, and no capture.
- **How many:** three live per creator at most, and ten made a day; past either, a new one is refused. Its soul and skills together hold at most 24,000 characters.
- **What pins it:** its own `AgentHost` records its creator, so it stays a subagent whatever the Registry answers.
- **How it ends:** it lives until its creator deletes it with `delete_subagent`, or the owner through Admin, and deleting its creator deletes it too. What it already reported reached its creator as Kelpie's news; a task it hadn't finished goes with it.
- **Kelpie announces them** (ADR-0036 §6, #342). After the reply, Kelpie names each subagent its creator creates or deletes with its tools, by name and id, in the conversation's language: `Kelpie created the subagent "Scout" (kelpie-sub-a1b2c3).` The name is quoted, since its creator chose it, and only the id is Kelpie's. Like the handoff notice, the text is Kelpie's own, so the model can't change or omit it, and a turn that sends no reply leaves it for the next one. A subagent deleted through Admin, or with its creator, is reported by that deletion's own confirmation and result.
- **The skill:** every agent with `spawn` gets the built-in `create-subagent` skill in its prompt. It covers when a subagent is worth it, how to brief one, and to delete it when the demand ends.

`configure_agent` also takes `spawn`, a one-line `remit`, and `tools`, the tools an agent may use by name, or `null` for all it is given. Each change waits for the owner's confirmation.

**Deleting an agent** (ADR-0036 §1, #303). `deleteAgent`, or the setup agent's `delete_agent` after the owner's confirmation, deletes an agent and every subagent it owns. The agent's chat goes off first, so no channel reaches it. Then the subagents go, deepest first, and the agent last. For each agent, in order:
1. Its role is read again: an agent that became Admin or Master meanwhile stops the deletion.
2. channel-egress removes its Telegram bot's webhook and deletes Kelpie's copy of the bot's token and its open forms. The bot itself stays the owner's, who can revoke its token with BotFather.
   - A webhook Telegram refuses to remove for good, as with a revoked token, doesn't stop the rest. Without the token, ingress refuses the bot's updates, and the result lists the agent under `webhooksLeft`.
   - A failure for now, such as a 429 or a 5xx, keeps the token and stops the deletion, so running it again removes the webhook.
3. Its `AgentHost` erases its conversations and then itself.
   - The conversations it erases are the ones it recorded at their first turn since #303, plus the owner's threads with it: the webchat's, and each channel identity the `Directory` lists.
   - The setup agent's Worker binds no `Directory`, so `delete_agent` names only the owner's webchat thread, and the result's `everyThread` is false. A Telegram conversation with no turn since #303 then stays where nothing reaches it, and an agent created again with the same id would get it back. To cover it, delete the agent through this API instead.
4. Its `Registry` row goes, and the `Registry`'s audit records `agent.deleted`.

Admin and Master can't be deleted, and the `Registry` refuses to remove an agent that still owns another. The setup agent's confirmation names every agent that goes, and its input carries their ids, so a subagent created before the owner's yes stops the deletion until they confirm again. A deletion cut short leaves the agent listed with its chat off, and running it again finishes it. The vault's `agents/<id>/` folder stays: it is the owner's repository, which Kelpie never deletes from. `forgetVaultPaths` drops Kelpie's copy, and the owner deletes the files in the repository.

- **Where it comes from.**
  - A migration of the `Registry` adds it, on new instances and on ones bootstrapped before it.
  - `createAgent` refuses its id.
  - Its default prompt is a built-in persona. `configureAgent` can replace it, and the vault's persona does, as for any agent.
  - **Before deploying it to an existing instance,** check with `listAgents` that no agent already uses the id `setup`. Such an agent would keep its name and gain the setup tools.
- **Its tools** run the commands above, as the owner, through the agent (`via: agent:setup`), and only the setup agent has them:
  - `list_agents`, `get_agent`, `create_agent` and `rename_agent` run directly;
  - `get_models` reads the instance's model settings, and `configure_models` replaces them;
  - `configure_agent` (its `model` included), `configure_models`, `set_main_agent`, `set_agent_chat` and `delete_agent` wait for the owner's confirmation (below);
  - `connect_telegram` opens a secure form ("Secure forms"), and `pair_telegram` leads to the pairing page ("Pairing"). Kelpie sends each link itself (below), and the owner's submitting that page is their yes (ADR-0026).
  - `connect_runner` opens the VPS runner's secure form, whose link Kelpie sends as well, and `runner_status` reads the runner's state, as `describeRunner` does ([runner.md](runner.md)). When the runner accepts the secret, the conversation learns it, as for a bot's form ("Steps the owner finishes", #328).

  The identity, time zone and vault commands stay on this API. `conversation-runtime` binds no `Directory`, which would make it and `ingress` bind each other. Of `channel-egress`, it binds only `SetupForms`, which opens a form, reads the runner's state, which holds no secret, and disconnects a deleted agent's bot, which reads nothing back (`docs/secrets.md`).
- **Confirmation.** A change to an agent's settings (`configure_agent`) waits for the owner's yes, gated in code:
  1. The first call doesn't run. After the agent's reply, Kelpie itself sends one more bubble, written from the change's validated input, not by the model: `Confirm: <the change>`, and a 6-character code. The bubble is in the conversation's language ("Languages").
     - Invisible and control characters in the change are written out as `\u{…}`, so what the owner reads is all there is.
     - A change too long for one bubble is refused before it is shown. Make it through this API instead.
  2. The owner says yes, and the agent calls the same tool with the same input again:
     - **In the webchat,** the owner presses the bubble's Confirm button, which replies with the code for them (#186).
       - A press counts only from the socket of the user who asked, for a confirmation of theirs still open.
       - Any other press is refused, and the button says the confirmation is no longer valid.
       - A second press of the same button sends nothing new.
     - **On Telegram, or in the webchat,** the owner replies with just the code, on a line of its own. A message that only mentions the code, such as "don't do K7MPRX", or asks about it ("K7MPRX?"), is no yes.
  3. A code confirms that one change, once. It lasts 10 minutes from the last time the agent asked for it.

  What never confirms:
  - another person's message;
  - a tool's output;
  - the model's replies, and what it passes to tools.

  The model's text can't show a Confirm button: only Kelpie's own bubble carries one. The model never sees a code before the owner sends it. The bubble isn't part of the conversation's history, so it doesn't come back when the webchat reloads: asking the agent again shows it again.
- **Links Kelpie sends itself.** `connect_telegram`, `pair_telegram` and `connect_runner` don't give the model their links (#186, ADR-0026):
  - After the agent's reply, Kelpie sends its own bubble with the link. The secure form's link carries the form's one-time token.
  - The bubble names the agent by its id, never by its name, which the model chose. The runner's names no agent.
  - Its one link is the admin API page. Any other address in it shows as text.
  - The model learns only that the link was sent. History, later requests and the outbox's inspection never hold the link.
  - As with a confirmation, the bubble doesn't come back once its turn has settled and the webchat reloads. If the owner says they didn't get it, the agent calls the tool again for a new link.
- **Steps the owner finishes.** When the owner submits a secure form, the bot's or the runner's, or pairs by pressing Start in the bot, the conversation that sent the link learns it without being told (#206, #328, ADR-0028):
  - **The wait:** the conversation waits for the step while its link lasts, the form's 15 minutes or a day for pairing, with a few minutes' grace. Both the conversation and the agent's `AgentHost` keep the wait. The runner is the instance's, and only the setup agent connects it, so the setup agent's `AgentHost` keeps its wait.
  - **The report:** the admin API reports a stored token or runner secret to the `AgentHost` it already binds, and `ingress` a redeemed pairing code through conversation-runtime's `SetupEvents` entrypoint, which does nothing else. Each report is bounded and best effort, so the page or the webhook answers whatever happens to it.
  - **The note:** each waiting conversation gets a note Kelpie writes in fixed words, "Kelpie, automatically (the owner didn't write this): …", naming the bot, the pairing, or the runner's version. A conversation takes a report only for a step it waits for, and only once. The agent answers the note.
  - **When the turn starts:**
    - while a turn runs, the note waits for that turn to end and doesn't interrupt it;
    - with the owner's messages waiting, it joins them;
    - otherwise it starts a turn at once;
    - while the conversation is paused, it waits for the owner's next message.
  - **How the turn runs:** the note is authored as the owner who finished the step, so its turn can run the next step's tools. Confirmations still need the code or the button.
  - **What the note never counts as:** the owner's words. It confirms no code, allows no link, doesn't show in the webchat, stays out of session pages and recall, and doesn't change the conversation's language.
  - **A webhook that failed:** the note says Telegram couldn't be pointed at Kelpie. The agent tells the owner to run `registerTelegramWebhook` on this API, since it can't.
  - **An outdated runner:** the note says the runner speaks another protocol version. The agent tells the owner to update it on the server.
  - **A refused secret, or a runner that can't be reached:** nothing is stored and nothing is reported. The form page says why and stays open.
- **Secrets.** The bot's token goes into the secure form ("Secure forms"), never into the chat. If the owner pastes one in the chat anyway, it stays in the conversation: revoke it in BotFather and make a new one. The runner's secret goes into its own form the same way. One pasted in the chat is revoked by writing a new secret to its file on the server ([runner.md](runner.md), "Rotating the secret").
- **Its context** is any agent's: the vault's persona and rules, recall, and the memory tools. A note in the vault could steer it toward a change that runs directly, such as creating or renaming an agent. The confirmed changes still need the owner's yes: the code or the button, or their own submission on the form or the pairing page.

What the setup agent can't do, because it holds no Cloudflare token (ADR-0013):
- deploy the Workers, in order, with their flags ("Setting it up");
- set their secrets: the model keys, `SECRETS_KEY` and the bootstrap token (`docs/secrets.md`);
- create the Access applications and the custom domains;
- the first-run bootstrap itself;
- Hyperdrive and Postgres, once a feature needs them (ADR-0015).

## Webchat

The webchat is a page on `ingress` where the owner chats with an agent, at `https://<ingress hostname>/webchat/?agent=<agent id>` (ADR-0023).
- It logs in the same way as the admin API: Cloudflare Access, then the owner's Access identity in the Directory. It has no pairing of its own.
- The agent must be in the registry.
- `ingress` checks the Access token again on every request: the page, and the socket's upgrade.
- The socket's upgrade must come from the page's own origin.
- Until it is set up, every `/webchat` request answers 404, and Telegram and GitHub's webhooks are unaffected.

To set it up:
1. **Put `/webchat` behind Access.** Either:
   - add `<ingress hostname>/webchat` as another destination of the admin API's Access application, which keeps its AUD tag; or
   - create a self-hosted application for that path, allowing only the owner. Its AUD tag then goes in `ACCESS_AUD` below.

   The path covers what is under it: the page's files and the socket at `/webchat/ws`. Leave the rest of the hostname outside Access: Telegram and GitHub can't log in.
2. **Deploy `ingress` with the Access values,** as for the admin API:
   ```bash
   bunx wrangler deploy -c apps/ingress/wrangler.jsonc --domain <ingress hostname> --var ACCESS_TEAM_DOMAIN:https://<team>.cloudflareaccess.com --var ACCESS_AUD:<aud>
   ```
   The deploy workflow carries them to later deploys (`docs/deploy.md`). A deploy by hand without them makes the webchat answer 404 again.
3. **Open `https://<ingress hostname>/webchat/?agent=<agent id>`.**
   - Replies come as paced bubbles, and the page shows when the agent is typing.
   - While the owner types, buffered messages wait for the rest, up to the agent's `maxWaitMs`.
   - Pause holds the answer until the next message ("Pausing").
   - A reply that arrives with the page closed shows when it opens again.

## Recovering access

Access gives the owner a new `sub` if they are removed from the Zero Trust organization and added again, or log in through another organization. The admin API then answers `403 forbidden`, and the bootstrap is disabled because an owner exists. A recovery token relinks the owner to the new login. Their `userId`, agents and paired accounts stay.

1. **Make a recovery token,** in the bootstrap token's format, valid for an hour:
   ```bash
   RECOVERY_TOKEN="$(( $(date +%s) + 3600 )).$(openssl rand -hex 32)"
   ```
2. **Set it on the Worker.** It is an optional secret: `secrets.required` doesn't list it, so it can be deleted afterwards.
   ```bash
   printf %s "$RECOVERY_TOKEN" | bunx wrangler secret put RECOVERY_TOKEN -c apps/admin-api/wrangler.jsonc
   ```
3. **Relink,** logged into Access with the new login:
   ```bash
   cloudflared access curl https://<admin hostname>/recover -X POST -H 'content-type: application/json' -d "{\"token\":\"$RECOVERY_TOKEN\"}"
   ```
   It answers `200 { "ok": true }`. Each token works once (`410 recovery_token_spent`). An unset, wrong or expired token is refused (`403 invalid_recovery_token`), and so is one that would live more than a day or that equals the bootstrap token.
4. **Delete it:**
   ```bash
   bunx wrangler secret delete RECOVERY_TOKEN -c apps/admin-api/wrangler.jsonc
   ```
   Also delete the shell variable.

Whoever passes Access and holds a live recovery token becomes the owner's admin login, so keep the Access policy limited to the owner, and the token's life short.

## Versions

`GET https://<ingress hostname>/version` answers `{ version, build, commit, deployment, deployedAt }`, and the webchat shows the version and the commit in its footer, for example `Kelpie 0.2.66 · 0c620f4` (#148, #153). Like `/health`, it needs no login.
- **`version` is `<release>.<build>`.**
  - The release is `KELPIE_RELEASE` in `packages/config/src/version.ts`. It is the delivery phase and changes by decision, with a phase or a notable release.
  - The build is main's first-parent commit count at the deployed commit. Every merged PR adds one, so a deploy with any change shows a new number.
- **The build and `commit` come from the deploy's tag.** The deploy workflow tags every deploy (`docs/deploy.md`). A deploy by hand, from a clean checkout of a commit on main, gives every `wrangler deploy` the same tag:
  ```bash
  --tag "$(git rev-list --count --first-parent HEAD)-$(git rev-parse --short=7 HEAD)"
  ```
  Without a tag, or with a tag that holds only the commit, `version` is the release alone and `build` is null.
- **Every deploy covers all six Workers, with the same tag,** as the deploy workflow's does. Only `ingress` answers `/version`, so it names the live build only if it went out with every deploy.
- **`deployment` and `deployedAt`** are `ingress`'s own Cloudflare version and when it was made, from the `version_metadata` binding.
- **`POST /deploy/probe` is the deploy's deep probe** (#234, `docs/deploy.md`). It wakes the `Directory`, the `Registry`, every `AgentHost` and llm-gateway, and answers `{ directory, registry, agentHosts, gateway }`, each `ok` or `failed`. It needs an `x-kelpie-deploy-probe` header that signs the current time with ingress's `DEPLOY_PROBE_TOKEN` secret, which the deploy workflow uploads. Without it, the route answers 404, as any unknown path does.

## Known limits

- **Access policy.** The admin API trusts whoever the Access application lets through, with the owner's admission on top. The policy must allow only the owner, especially while a recovery token is set.
