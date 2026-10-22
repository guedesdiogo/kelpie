# Secrets

Kelpie keeps two kinds of secret (ADR-0013). Every secret Kelpie takes after deploy comes in through a one-time form that expires, so it never passes through a model or the chat (ADR-0068).

- **Deploy secrets.** The owner sets these with `wrangler secret put`, only for what must exist before the forms can work:
  - on `llm-gateway`, the first model key, since Master needs a model before it can send a form. It may stay a deploy secret, or move to a form once Kelpie runs ("Model keys"). The other keys `llm-gateway` calls providers with may be deploy secrets too, as before ADR-0068:
    - `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`;
    - `AI_GATEWAY_TOKEN`, when AI Gateway requires authentication (`docs/admin-api.md`);
    - `TYPESAFE_API_KEY`, for agents whose qualifier is Jev (ADR-0018). Clef, the default qualifier, needs no secret: it runs through `llm-gateway`'s `AI` binding;
  - the bootstrap token, on `admin-api` (`docs/admin-api.md`);
  - the recovery token, on `admin-api`, only while the owner recovers a changed Access login, then deleted (`docs/admin-api.md`, "Recovering access");
  - the store's encryption key, `SECRETS_KEY` on `channel-egress`;
  - on `context-store`, the vault's GitHub App private key and webhook secret (ADR-0021, `docs/context-store.md`), until a follow-up moves them to a form. Without them the vault is off;
  - `DEPLOY_PROBE_TOKEN` on `ingress`, for the deploy's deep probe (#234). The owner sets it in GitHub's `production` environment, not with `wrangler secret put`. A deploy uploads it when ingress has none, and on a rotation (`docs/deploy.md`). Without it the probe's route answers 404.
- **Everything else** (a bot token, the VPS runner's secret, a model key, a tool's API key) goes into Kelpie's secret store through a one-time secure form, never through chat.

## The secret store

- **Where it lives.** The `SecretStore` Durable Object, in the `channel-egress` Worker.
- **Encryption.** Each value is encrypted with AES-GCM under `SECRETS_KEY`.
  - Every write gets a fresh 12-byte IV.
  - The slot's name (for example `telegram:sales`) is the additional authenticated data, so a value copied into another slot doesn't decrypt.
  - Each value records the version of the key that sealed it.
- **Who reads it.** Only `channel-egress` binds the store, because reading returns plaintext. Other Workers reach it through `channel-egress`'s entrypoints, and only `ProviderKeys` returns a secret:
  - `ChannelForms`, for the admin API, creates, describes and redeems forms, registers webhooks, disconnects a deleted agent's bot, reports the VPS runner's state, and removes a model key;
  - `SetupForms`, for Master's configuration tools in the conversation runtime, only creates a Telegram form, the runner's form or a model key's form, reads the runner's state, which holds no secret, disconnects a deleted agent's bot, and removes a model key. The owner opens a form's link on the admin API, so the Worker a model drives can't describe a form or redeem one (Story 3.11), and registers a webhook only through `SetupWebhooks`, below;
  - **disconnecting** removes the bot's webhook at Telegram, then deletes its slot and every form for it, used or open, so a form opened before the deletion can't connect the bot again. It reads nothing back, and Master calls it only after the owner confirms the deletion (#303);
  - `SetupWebhooks`, for Master's `register_telegram_webhook` (ADR-0067, #493), only points a stored bot at ingress again, with the URL from the deploy and the webhook secret already stored. It returns no secret;
  - `ProviderKeys`, for `llm-gateway` alone, returns the stored model keys, and only the `provider:` slots (ADR-0068 §3, "Model keys"). It is the one entrypoint that returns a secret. `llm-gateway` already holds the keys it calls providers with, and conversation-runtime, the Worker a model drives, still can't reach one;
  - `ChannelEgress`, for the conversation runtime, sends and shows typing;
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
- **Model keys** (ADR-0068, "Model keys" below): each in its own slot, `provider:anthropic`, `provider:openai`, `provider:ai-gateway` or `provider:typesafe`. `llm-gateway` checks a key before the form stores it.
- **Webhooks.**
  - Each stored bot gets a new random webhook secret.
  - Right after storing, `channel-egress` registers the bot's webhook (`setWebhook`) at `<INGRESS_ORIGIN>/webhooks/telegram/<agentId>`, with that secret and only new messages.
  - Telegram echoes the secret in every update. Ingress asks `ChannelWebhooks` to compare it before reading the update.
  - A new form for the same agent replaces the secret, so it registers again. A failed registration leaves the token stored, and the `registerTelegramWebhook` command repeats it.
- **Failing closed.** A missing or malformed `SECRETS_KEY` keeps the store closed: nothing is read or written, and no token is sent to Telegram to be checked.
- **The trust boundary is the account.** A binding is the authorization: any Worker bound to an entrypoint can call it for any agent, so bindings stay minimal. Anyone who can deploy a Worker in the Cloudflare account could bind `SecretStore` directly and read it; that account is trusted.

## Model keys

The owner sets or rotates a model key by asking Master, who calls `connect_model_key` (ADR-0068). The key goes into its slot of the store, and never passes through a model, the chat, a tool's result, history or a log.

| Slot | Replaces the Worker secret | Its check |
|---|---|---|
| `provider:anthropic` | `ANTHROPIC_API_KEY` | `GET https://api.anthropic.com/v1/models?limit=1`, with the key as `x-api-key` |
| `provider:openai` | `OPENAI_API_KEY` | `GET https://api.openai.com/v1/models`, with the key as a bearer token |
| `provider:ai-gateway` | `AI_GATEWAY_TOKEN` | Cloudflare's token verification: `/user/tokens/verify`, then `/accounts/<account>/tokens/verify` for the account a gateway's URL in `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL` names |
| `provider:typesafe` | `TYPESAFE_API_KEY` | `GET https://api.typesafe.ai/v1/models`, with the key as a bearer token |

- **The form.** It follows the forms' rules above: a 256-bit token in the link, 15 minutes, one use, five refused values close it. The same key sent again, as a double click sends it, gets the same page: the slot keeps the key's check with it. The page never shows the key.
- **The check.** The admin API, which takes the form's submission, asks `llm-gateway`'s `ProviderCheck` first. Only the admin API binds it: it deploys after `llm-gateway`, and `channel-egress`, deployed first, can't (`docs/deploy.md`).
  - The check is one cheap authenticated read, which spends no tokens. `llm-gateway` keeps nothing it checks.
  - A key its service accepts is stored; a key it refuses, with a 401, counts against the form, as a malformed one does. A 403 is refused too, except from OpenAI, where a restricted key without the models' read scope gets one and may still serve: it is stored unchecked.
  - A service that can't answer, with a 429, a 5xx, a redirect or no answer in 5 seconds, leaves the form open, and the try doesn't count.
  - An account's AI Gateway token (`cfat_…`) with no gateway URL to name its account can't be checked either: it is stored unchecked. The page and Master's note say when a key wasn't checked.
  - So `channel-egress` still calls no provider.
- **Serving.** `llm-gateway` reads the stored keys through `ProviderKeys`, all four in one call, and prefers a stored key to its Worker secret.
  - It reads again 30 seconds after a read, so a rotation or a removal applies to new calls within a minute. A call already running keeps the key it started with.
  - When the store can't answer, it keeps handing out the keys it read, until they are 60 seconds old. Then the Worker secrets serve. A read that takes over 2 seconds counts as failed.
  - Master's `get_models` says where each key comes from: `form`, `deploy` or `none`, never the key.
- **Removing.** Master's `remove_model_key` deletes a slot and every form for it, after the owner's confirmation. The Worker secret, if any, serves again within a minute.
- **A stored key that doesn't serve.** A stored key takes precedence, so a key that passed its check but can't run calls leaves its provider without a working key, and Master may be left without a model to remove it with. The admin API's `removeModelKey` command removes it without Master (`docs/admin-api.md`).
- **Rollback.** Code from before ADR-0068 ignores the `provider:` slots and uses the Worker secrets. Keep a deploy secret until the form has served.

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
