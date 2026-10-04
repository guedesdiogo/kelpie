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

No configuration command can add or enable an Access identity. Only the first-run bootstrap does.

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
| `/commands/addIdentity` | `{ "channel": "telegram", "channelUserId": "…" }` |
| `/commands/enableIdentity` | same as `addIdentity` |
| `/commands/disableIdentity` | same as `addIdentity` |
| `/commands/setTimeZone` | `{ "timeZone": "America/Sao_Paulo" }`, an IANA name. Offsets like `+03:00` are refused; prefer a city name to `Etc/GMT±N`, whose sign is inverted (`Etc/GMT+3` is UTC-03:00) |
| `/bootstrap` | `{ "token": "…" }` |

**Answers:**
- A success is `200 { "ok": true, "value": … }`; the bootstrap answers `201`.
- A refusal is `{ "ok": false, "reason": … }`, with its HTTP status:

| Status | Reasons |
|---|---|
| 400 | `invalid_input`, `invalid_identity`, `invalid_json` |
| 401 | `unauthenticated` |
| 403 | `forbidden`, `no_owner`, `invalid_bootstrap_token` |
| 404 | `unknown_agent`, `unknown_identity`, `unknown_user`, `not_found` |
| 409 | `identity_taken` |
| 410 | `bootstrap_disabled` |
| 413 | `too_large` |
| 503 | `unavailable` (Access's keys couldn't be loaded) |

Identity values in answers are masked.

## Setting it up

1. **Deploy `ingress` and `conversation-runtime` first.** The admin API's bindings point at their objects.
2. **Create a self-hosted Access application** for the admin API's hostname, with a policy that allows only the owner. Do this before step 4: whoever passes Access and holds the token becomes the owner. Note the team domain (`https://<team>.cloudflareaccess.com`) and the application's AUD tag.
3. **Set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`** in `apps/admin-api/wrangler.jsonc`, and give the Worker its hostname. `workers_dev` and preview URLs stay off.
4. **Make the bootstrap token** and store it as a secret. It is `<expiry in epoch seconds>.<random>`, and here it is valid for 24 hours. Keep the shell open: step 6 uses the same variable.
   ```bash
   BOOTSTRAP_TOKEN="$(( $(date +%s) + 86400 )).$(openssl rand -hex 32)"
   ```
   ```bash
   printf %s "$BOOTSTRAP_TOKEN" | bunx wrangler secret put BOOTSTRAP_TOKEN -c apps/admin-api/wrangler.jsonc
   ```
5. **Deploy:** `bunx wrangler deploy -c apps/admin-api/wrangler.jsonc`.
6. **Register as the owner.** `cloudflared access curl` opens the Access login and sends its token:
   ```bash
   cloudflared access curl https://<admin hostname>/bootstrap -X POST -H 'content-type: application/json' -d "{\"token\":\"$BOOTSTRAP_TOKEN\"}"
   ```
   The bootstrap works once. After it, the endpoint answers `410`, and the token can be deleted with `wrangler secret delete BOOTSTRAP_TOKEN`. If the token expired first, make a new one and put it again (step 4).

## Known limits

- **Lockout.** Access gives the owner a new `sub` if they are removed from the Zero Trust organization and added again. The bootstrap is then disabled, so the owner can't reach the admin API. Recovery is [#71](https://github.com/guedesdiogo/kelpie/issues/71).
- **Pairing.** Until pairing arrives (Story 3.6), `enableIdentity` trusts the identity value the owner types.
