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
| `/commands/configureAgent` | `{ "id": "sales", "settings": { "systemPrompt": "…", "conversational": false } }` |
| `/commands/listIdentities` | none |
| `/commands/enableIdentity` | `{ "channel": "telegram", "channelUserId": "…" }`; re-enables a disabled identity, never a pending one |
| `/commands/disableIdentity` | same as `enableIdentity` |
| `/commands/setTimeZone` | `{ "timeZone": "America/Sao_Paulo" }`, an IANA name. Offsets like `+03:00` are refused; prefer a city name to `Etc/GMT±N`, whose sign is inverted (`Etc/GMT+3` is UTC-03:00) |
| `/commands/connectTelegram` | `{ "agentId": "sales" }`; answers `{ "path": "/forms/<token>", "expiresAt": … }` |
| `/commands/pairTelegram` | `{ "agentId": "sales" }`; answers `{ "link": "https://t.me/<bot>?start=<code>", "expiresAt": … }` (see "Pairing") |
| `/commands/registerTelegramWebhook` | `{ "agentId": "sales" }`; points the agent's bot at ingress again, after a failed registration or a new ingress hostname |
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
| 503 | `unavailable` (the secret store can't be reached), `not_configured` (`channel-egress` was deployed without ingress's origin) |
| 410 | `bootstrap_disabled`, `recovery_token_spent` |
| 413 | `too_large` |
| 503 | `unavailable` (Access's keys couldn't be loaded) |

Identity values in answers are masked.

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

      For Jev at the end of turn (ADR-0018), set the optional `TYPESAFE_API_KEY` to a key from TypeSafe's console. `llm-gateway` calls TypeSafe's API directly with it, after masking personal data in the fragments. Without the key, the heuristic decides.
   2. `channel-egress`, with its `SECRETS_KEY` and `--var INGRESS_ORIGIN:https://<ingress hostname>` (`docs/secrets.md`);
   3. `conversation-runtime`;
   4. `ingress`, with `--domain <ingress hostname>`. Telegram's webhooks reach it there; like the admin API, it has no `workers.dev` URL. Later deploys need the same flag.
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

## Known limits

- **Access policy.** The admin API trusts whoever the Access application lets through, with the owner's admission on top. The policy must allow only the owner, especially while a recovery token is set.
