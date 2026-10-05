# Secrets

Kelpie keeps two kinds of secret (ADR-0013).

- **Deploy secrets.** The owner sets these with `wrangler secret put`:
  - the first model key, on `llm-gateway`;
  - the bootstrap token, on `admin-api` (`docs/admin-api.md`);
  - the recovery token, on `admin-api`, only while the owner recovers a changed Access login, then deleted (`docs/admin-api.md`, "Recovering access");
  - the store's encryption key, `SECRETS_KEY` on `channel-egress`.
- **Everything else** (a bot token, an API key) goes into Kelpie's secret store through a one-time secure form, never through chat.

## The secret store

- **Where it lives.** The `SecretStore` Durable Object, in the `channel-egress` Worker.
- **Encryption.** Each value is encrypted with AES-GCM under `SECRETS_KEY`.
  - Every write gets a fresh 12-byte IV.
  - The slot's name (for example `telegram:sales`) is the additional authenticated data, so a value copied into another slot doesn't decrypt.
  - Each value records the version of the key that sealed it.
- **Who reads it.** Only `channel-egress` binds the store, because reading returns plaintext. Other Workers reach it through `channel-egress`'s entrypoints, which return no secret:
  - `ChannelForms`, for the admin API, creates, describes and redeems forms, and registers webhooks;
  - `ChannelEgress`, for the conversation runtime, sends and shows typing;
  - `ChannelWebhooks`, for ingress, checks the secret a webhook presents and sends two fixed notices: "paired", and a stranger notice to the owner (`docs/admin-api.md`, "Pairing"). The Worker that takes public requests can't send text of its own: `channel-egress` writes both notices, with a stranger's name cleaned up and cut to 64 characters.
- **Forms.**
  - A link carries a random 256-bit token. The store keeps only its SHA-256.
  - It expires after 15 minutes and works once.
  - A Telegram bot token is checked with `getMe` before it is stored, so a refused token leaves the form open for another try. Five refused values close it.
  - The link's token sits in the URL path, so the admin API turns off invocation logs. Cloudflare Access may still log the path; a logged token is useless once the form is used, closed or expired, and only the owner can open it.
  - The value is encrypted before the form is claimed, and claiming and storing happen in one transaction, so two submissions can't both store and a failure can't spend the form.
- **Webhooks.**
  - Each stored bot gets a new random webhook secret.
  - Right after storing, `channel-egress` registers the bot's webhook (`setWebhook`) at `<INGRESS_ORIGIN>/webhooks/telegram/<agentId>`, with that secret and only new messages.
  - Telegram echoes the secret in every update. Ingress asks `ChannelWebhooks` to compare it before reading the update.
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

Every later deploy needs the same flag. Without it, Wrangler sets `INGRESS_ORIGIN` back to empty. Webhooks already registered keep working, but no new one can be registered (`not_configured`).

After the ingress hostname changes, deploy with the new origin, then run `registerTelegramWebhook` for each agent with a bot.

## Losing the key

Losing or replacing the key makes every stored secret unreadable. The owner then enters them again through new forms. Rotating the key without that step isn't built yet; the recorded key version leaves room for it.
