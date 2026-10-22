# Secrets

Kelpie keeps two kinds of secret (ADR-0013).

- **Deploy secrets.** The owner sets these with `wrangler secret put`:
  - on `llm-gateway`, the keys it uses to call providers (ADR-0019):
    - the first model key;
    - `AI_GATEWAY_TOKEN`, when AI Gateway requires authentication (`docs/admin-api.md`);
    - optionally `TYPESAFE_API_KEY`, for agents whose qualifier is Jev (ADR-0018). Clef, the default qualifier, needs no secret: it runs through `llm-gateway`'s `AI` binding;
  - the bootstrap token, on `admin-api` (`docs/admin-api.md`);
  - the recovery token, on `admin-api`, only while the owner recovers a changed Access login, then deleted (`docs/admin-api.md`, "Recovering access");
  - the store's encryption key, `SECRETS_KEY` on `channel-egress`;
  - on `context-store`, the vault's GitHub App private key and webhook secret (ADR-0021, `docs/context-store.md`). Without them the vault is off;
  - `DEPLOY_PROBE_TOKEN` on `ingress`, for the deploy's deep probe (#234). The owner sets it in GitHub's `production` environment, not with `wrangler secret put`. A deploy uploads it when ingress has none, and on a rotation (`docs/deploy.md`). Without it the probe's route answers 404.
- **Everything else** (a bot token, the VPS runner's secret, a tool's API key) goes into Kelpie's secret store through a one-time secure form, never through chat.

## The secret store

- **Where it lives.** The `SecretStore` Durable Object, in the `channel-egress` Worker.
- **Encryption.** Each value is encrypted with AES-GCM under `SECRETS_KEY`.
  - Every write gets a fresh 12-byte IV.
  - The slot's name (for example `telegram:sales`) is the additional authenticated data, so a value copied into another slot doesn't decrypt.
  - Each value records the version of the key that sealed it.
- **Who reads it.** Only `channel-egress` binds the store, because reading returns plaintext. Other Workers reach it through `channel-egress`'s entrypoints, which return no secret:
  - `ChannelForms`, for the admin API, creates, describes and redeems forms, registers webhooks, disconnects a deleted agent's bot, and reports the VPS runner's state;
  - `SetupForms`, for Master's configuration tools in the conversation runtime, only creates a Telegram form or the runner's form, reads the runner's state, which holds no secret, and disconnects a deleted agent's bot. The owner opens a form's link on the admin API, so the Worker a model drives can't describe a form, redeem one or register a webhook (Story 3.11);
  - **disconnecting** removes the bot's webhook at Telegram, then deletes its slot and every form for it, used or open, so a form opened before the deletion can't connect the bot again. It reads nothing back, and Master calls it only after the owner confirms the deletion (#303);
  - `ChannelEgress`, for the conversation runtime, sends and shows typing, puts buttons under Kelpie's notices, answers a tap on one, and edits a notice in place (ADR-0067 §3);
  - `ChannelWebhooks`, for ingress, checks the secret a webhook presents and sends two fixed notices: "paired", and a stranger notice to the owner (`docs/admin-api.md`, "Pairing"). The Worker that takes public requests can't send text of its own: `channel-egress` writes both notices, with a stranger's name cleaned up and cut to 64 characters.
- **Forms.**
  - A link carries a random 256-bit token. The store keeps only its SHA-256.
  - It expires after 15 minutes and works once. A used form's hash is kept 15 minutes more, so the same token sent again, as a double click sends it, is answered with the bot it connected (compared in constant time with the stored one), and its webhook is registered again. Any other value is refused.
  - A Telegram bot token is checked with `getMe` before it is stored, so a refused token leaves the form open for another try. Five refused values close it.
  - The link's token sits in the URL path, so the admin API turns off invocation logs. Cloudflare Access may still log the path; a logged link token is useless once the form is closed or expired, or 15 minutes after it was used. Until then it only shows which bot it connected, and registers the bot's webhook again if the bot's token is also known. Only the owner can open it.
  - The value is encrypted before the form is claimed, and claiming and storing happen in one transaction, so two submissions can't both store and a failure can't spend the form.
- **The runner** (#294, [runner.md](runner.md)).
  - Its secret is in the slot `runner:vps`. `channel-egress` is the only Worker bound to the runner's VPC Service, so it is the only one that calls the runner, and the secret never leaves it.
  - A form checks the secret with the runner's `/health` before storing it. A refused secret counts against the form; a runner that can't answer doesn't.
- **Webhooks.**
  - Each stored bot gets a new random webhook secret.
  - Right after storing, `channel-egress` registers the bot's webhook (`setWebhook`) at `<INGRESS_ORIGIN>/webhooks/telegram/<agentId>`, with that secret, for new messages and taps on buttons (`callback_query`) only.
  - A bot registered before taps existed takes messages only. Before its first notice with a button goes out, `channel-egress` reads its webhook (`getWebhookInfo`) and, if it is Kelpie's own, sets it again with taps, once per isolate. A webhook pointed elsewhere stays as it is.
  - Telegram echoes the secret in every update, a tap included. Ingress asks `ChannelWebhooks` to compare it before reading the update.
  - A new form for the same agent replaces the secret, so it registers again. A failed registration leaves the token stored, and the `registerTelegramWebhook` command repeats it.
- **Failing closed.** A missing or malformed `SECRETS_KEY` keeps the store closed: nothing is read or written, and no token is sent to Telegram to be checked.
- **The trust boundary is the account.** A binding is the authorization: any Worker bound to an entrypoint can call it for any agent, so bindings stay minimal. Anyone who can deploy a Worker in the Cloudflare account could bind `SecretStore` directly and read it; that account is trusted.

## Making the key

`SECRETS_KEY` is 32 random bytes, base64. This command makes one and stores it without printing it:

```bash
openssl rand -base64 32 | tr -d '\n' | bunx wrangler secret put SECRETS_KEY -c apps/channel-egress/wrangler.jsonc
```

## Deploying `channel-egress`

Webhooks point at ingress's public origin, which belongs to one deployment. Pass it as a flag, the same way the admin API takes its Access values:

```bash
bunx wrangler deploy -c apps/channel-egress/wrangler.jsonc --var INGRESS_ORIGIN:https://<ingress hostname>
```

The deploy workflow carries it to later deploys (`docs/deploy.md`). A deploy by hand without the flag sets `INGRESS_ORIGIN` back to empty. Webhooks already registered keep working, but no new one can be registered (`not_configured`).

After the ingress hostname changes, deploy with the new origin, then run `registerTelegramWebhook` for each agent with a bot.

## Losing the key

Losing or replacing the key makes every stored secret unreadable. The owner then enters them again through new forms. Rotating the key without that step isn't built yet; the recorded key version leaves room for it.
