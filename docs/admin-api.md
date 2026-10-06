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
3. **The `Directory`.** It admits the token's `sub` as an identity from the `cloudflare-access` source, for the agent id `*`, which names no agent. Owner-only commands check the admitted role (ADR-0015). Emails are never compared.

No configuration command can add, enable or replace an Access identity. The first-run bootstrap adds the owner's, and a token-gated recovery replaces it ("Recovering access").

## Endpoints

Every endpoint is a `POST` with a JSON body.

| Endpoint | Input |
|---|---|
| `/commands/listAgents` | none |
| `/commands/createAgent` | `{ "id": "sales", "name": "Sales" }` |
| `/commands/renameAgent` | `{ "id": "sales", "name": "Sales team" }` |
| `/commands/getAgent` | `{ "id": "sales" }` |
| `/commands/configureAgent` | `{ "id": "sales", "settings": { "systemPrompt": "…", "quietMs": 5000, "qualifier": "jev" } }` |
| `/commands/listIdentities` | none |
| `/commands/enableIdentity` | `{ "channel": "telegram", "channelUserId": "…" }`; re-enables a disabled identity, never a pending one |
| `/commands/disableIdentity` | same as `enableIdentity` |
| `/commands/setTimeZone` | `{ "timeZone": "America/Sao_Paulo" }`, an IANA name. Offsets like `+03:00` are refused; prefer a city name to `Etc/GMT±N`, whose sign is inverted (`Etc/GMT+3` is UTC-03:00) |
| `/commands/connectTelegram` | `{ "agentId": "sales" }`; answers `{ "path": "/forms/<token>", "expiresAt": … }` |
| `/commands/pairTelegram` | `{ "agentId": "sales" }`; answers `{ "link": "https://t.me/<bot>?start=<code>", "expiresAt": … }` (see "Pairing") |
| `/commands/registerTelegramWebhook` | `{ "agentId": "sales" }`; points the agent's bot at ingress again, after a failed registration or a new ingress hostname |
| `/commands/listHeldFiles` | none; the vault's files pushed with conflict markers that still wait, as `{ "path", "state": "held" \| "proposed", "attempts", "at" }` ([context-store.md](context-store.md)) |
| `/commands/forgetVaultPaths` | `{ "paths": ["memory/people/ana.md", "memory/old/"] }`, at most 1,000; a path ending in `/` names a folder. After you rewrote the vault's history, Kelpie forgets its copies of them; answers `{ "forgotten": <rows>, "stillInVault": [<named files the vault still has>] }` (see "Erasing content" in [context-store.md](context-store.md#erasing-content)) |
| `/bootstrap` | `{ "token": "…" }` |
| `/recover` | `{ "token": "…" }`, with the recovery token ("Recovering access") |

**Answers:**
- A success is `200 { "ok": true, "value": … }`; the bootstrap answers `201`.
- A refusal is `{ "ok": false, "reason": … }`, with its HTTP status:

| Status | Reasons |
|---|---|
| 400 | `invalid_input`, `invalid_identity`, `invalid_json`, `invalid_user` |
| 401 | `unauthenticated` |
| 403 | `forbidden`, `no_owner`, `invalid_bootstrap_token`, `invalid_recovery_token` |
| 404 | `unknown_agent`, `unknown_identity`, `unknown_user`, `not_found` |
| 409 | `not_paired` (a pending identity; pair it instead), `not_connected` (the agent has no bot), `identity_taken` (a recovery to a login another user holds) |
| 502 | `channel_refused` (Telegram refused, or couldn't be reached) |
| 503 | `unavailable` (the secret store can't be reached), `not_configured` (`channel-egress` was deployed without ingress's origin, or the vault is off) |
| 410 | `bootstrap_disabled`, `recovery_token_spent` |
| 413 | `too_large` |
| 503 | `unavailable` (Access's keys couldn't be loaded) |

Identity values in answers are masked.

**Waiting for the rest of a message.** An agent answers `quietMs` after the owner's latest message, 10 s by default, and each new message starts the wait again. Its `maxWaitMs`, 60 s by default, caps the wait from the first buffered message; a `quietMs` above it is cut to the cap. `quietMs: 0` removes the wait: each message is processed at once. Nothing else starts before the wait ends, the memory recall included (ADR-0024). No end-of-turn decision is asked of a qualifier (ADR-0024). `conversational: false` answers each message at once.

**Tools.** A turn may run the agent's tools for up to 5 rounds, within `toolLoopMs`: 120 s by default, the floor, up to 600 000 (ADR-0025). Past either bound, one last model call answers with what it has. In the webchat, the turn shows its step once the wait is over: reading memory, thinking, or the tool it runs. Telegram shows "typing".

**Pausing.** `/pause` on Telegram (also `/pause@<bot>`), or the webchat's Pause button, holds every answer until the owner's next message (#134). A pause while paused changes nothing, and Telegram's redelivery of the same `/pause` is ignored.
- A turn in flight is interrupted, and the planned answer is cancelled.
- Telegram confirms with a short fixed message, not from the model. The webchat shows the pause.
- The next message is answered together with the buffered ones, after the usual wait. The cap counts from that message.

## Pairing

No command takes an identity value to admit someone: the owner proves an account is theirs by sending the bot a code from where they are already signed in (Story 3.6).

1. `pairTelegram` answers with `https://t.me/<bot>?start=<code>`.
   - The code is 8 characters from an alphabet without look-alikes, and lasts an hour.
   - Only its salted SHA-256 is kept, and a new code replaces the last one.
2. The owner opens the link in Telegram, which sends the bot `/start <code>`.
3. A match makes that Telegram account the owner's, enabled, and the bot answers with a fixed "paired" notice. The `/start` never reaches the model.

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

The link expires after 15 minutes, works once, and closes after five refused tokens.

Form pages are HTML:
- they are sent with `Cache-Control: no-store`, `Referrer-Policy: same-origin` and a Content-Security-Policy that forbids framing and scripts;
- a submission must come from the page itself (`Sec-Fetch-Site: same-origin`, or a matching `Origin`) and be form-encoded;
- no page repeats the token.

## Setting it up

1. **Deploy the other Workers first, in this order.** Each one's bindings point only at Workers before it:
   1. `llm-gateway`, with a model key (`docs/secrets.md`). To send its calls through AI Gateway:
      - create a gateway with "Require provider credentials" (`byok_only`), so a missing key fails instead of billing Cloudflare credits;
      - pass each provider's passthrough URL as a flag, for example `--var OPENAI_BASE_URL:https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/openai`. Later deploys need the same flag, or calls go straight to the provider without a warning;
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
   4. `conversation-runtime`;
   5. `ingress`, with `--domain <ingress hostname>`. Telegram's and GitHub's webhooks reach it there; like the admin API, it has no `workers.dev` URL. Later deploys need the same flag, and the webchat's Access flags once it is set up ("Webchat").
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
   Later deploys need the same `--domain` and `--var` flags. Without them, Wrangler removes the vars that aren't in `wrangler.jsonc`, and every request is refused again.
6. **Register as the owner.** `cloudflared access curl` opens the Access login and sends its token:
   ```bash
   cloudflared access curl https://<admin hostname>/bootstrap -X POST -H 'content-type: application/json' -d "{\"token\":\"$BOOTSTRAP_TOKEN\"}"
   ```
   The bootstrap works once. If the token expired first, make a new one (step 4) and replace the secret with `printf %s "$BOOTSTRAP_TOKEN" | bunx wrangler secret put BOOTSTRAP_TOKEN -c apps/admin-api/wrangler.jsonc`.
7. **Keep the secret; delete the local copy.** Delete the file or shell variable that holds the token.
   - The Worker's `BOOTSTRAP_TOKEN` stays. `wrangler.jsonc` lists it in `secrets.required`, so `wrangler deploy` refuses to deploy without it, and deleting it would make every later deploy fail.
   - It is harmless where it is: `/bootstrap` answers `410` once an owner exists, and the token stops being accepted at the expiry it carries.

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
   Later deploys need the same flags. Without them, the webchat answers 404 again.
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
- **The build and `commit` come from the deploy's tag.** Deploy from a clean checkout of a commit on main, and give every `wrangler deploy` the same tag:
  ```bash
  --tag "$(git rev-list --count --first-parent HEAD)-$(git rev-parse --short HEAD)"
  ```
  Without a tag, or with a tag that holds only the commit, `version` is the release alone and `build` is null.
- **Deploy all six Workers each time, with the same tag.** Only `ingress` answers `/version`, so it names the live build only if it went out with every deploy.
- **`deployment` and `deployedAt`** are `ingress`'s own Cloudflare version and when it was made, from the `version_metadata` binding.

## Known limits

- **Access policy.** The admin API trusts whoever the Access application lets through, with the owner's admission on top. The policy must allow only the owner, especially while a recovery token is set.
