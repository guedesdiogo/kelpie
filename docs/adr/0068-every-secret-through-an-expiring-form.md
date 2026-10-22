# ADR-0068: Every secret Kelpie takes after deploy comes in through a one-time form that expires, model keys included

- Status: Accepted
- Date: 2026-10-22
- Issue: [#490](https://github.com/guedesdiogo/kelpie/issues/490)
- Decided by the owner on 2026-10-22:
  - on Cloudflare's reach: «Chaves de modelo por formulário»;
  - the rule: «toda informação que deve ser segura, como chaves, secrets, tokens e afins devem ser obtidos a partir de formulários específicos com tempo de expiração para o formulário e depois de obter os dados o formulário deve expirar. Assim guardamos os dados sem passar pela llm»;
  - the plan: «Aprovo os três (Recomendado)», for #489, #490 and #491.
- Supersedes: [ADR-0019](0019-llm-gateway-keys.md)
- Amends: [ADR-0013](0013-self-configuration.md), whose deploy secrets narrow to §1's

## Context

The owner asked for Master's widest reach ([ADR-0067](0067-master-reaches-every-owner-command.md)). Master can't set a model key.
- **The keys are Worker secrets today.** [ADR-0019](0019-llm-gateway-keys.md) made the keys `llm-gateway` calls providers with Worker secrets on `llm-gateway`, set with `wrangler secret put`.
- **Why.** The secret store lives in `channel-egress`, and none of its entrypoints returns a secret. ADR-0019 rejected an entrypoint that would hand keys to `llm-gateway`: it would "widen what a compromised caller can read".

The bot token's and the runner's forms already work as the owner asks ([`docs/secrets.md`](../secrets.md)):
- the link carries a random 256-bit token, and the store keeps only its SHA-256;
- the form expires after 15 minutes and works once;
- the value is checked before it is stored, and five refused values close the form;
- Kelpie sends the link itself, so the model never holds it (ADR-0026 §2).

The reference check is on #490.

## Decision

### 1. The owner's rule

- **Every secret Kelpie takes after deploy** comes in through a form on the admin API that serves only that secret. The form expires, works once, and closes once used.
- **The value never passes through the model or the chat,** and never reaches a tool's result, history or a log.
- **Worker secrets stay** only for what must exist before that path does:
  - the store's key, `SECRETS_KEY`;
  - the bootstrap token and the recovery token;
  - `DEPLOY_PROBE_TOKEN`, which CI sets.
- **The vault's GitHub App credentials** ([ADR-0021](0021-vault-app-secrets.md)) move to a form in a follow-up, under this rule.

### 2. Model keys go in through such a form

- **What it covers:** the providers' keys (`anthropic`, `openai`), `AI_GATEWAY_TOKEN` and `TYPESAFE_API_KEY`. Each goes into the slot `provider:<name>` of the secret store.
- **The check:** the form checks a key with a cheap call to its provider before storing it. A refused key counts against the form, and five refused keys close it, as a bot token's do.
- **Master's tool `connect_model_key`** asks for the form for one provider. Kelpie sends its link itself, and when the owner finishes, Kelpie's note tells the conversation that sent it (ADR-0028). ADR-0064 holds the tool after outside content, as it holds the other form tools.
- **Removing a stored key** takes the owner's confirmation.

### 3. `llm-gateway` reads the store through `ProviderKeys`

- **The entrypoint.** `channel-egress` gains a `ProviderKeys` entrypoint, bound only by `llm-gateway`. It returns only `provider:` slots.
- **This narrows the store's rule** that no entrypoint returns a secret. The Worker the model drives, conversation-runtime, still can't reach a key, and `llm-gateway` already holds the keys it calls providers with.
- **The cache.** `llm-gateway` keeps a key it read in memory for at most 60 seconds, so a rotation applies within a minute.

### 4. A stored key takes precedence over the Worker secret

- **The Worker secret still serves** when no key is stored. Today's deploys keep working, and the first model key may still be a deploy secret.
- **When the store can't be reached,** `llm-gateway` uses the key it read in the last 60 seconds, then the Worker secret.
- **`get_models` says where each provider's key comes from,** a form or the deploy, and never the key.

## Consequences

- **The owner sets or rotates a model key by asking Master.** The checklist of `docs/admin-api.md` loses that step, and `docs/secrets.md` gains the slots.
- **`channel-egress` returns a secret to one caller.** A compromised `llm-gateway` could read the stored model keys, which its Worker secrets already give it today. A compromised conversation-runtime still can't.
- **The keys gain application-level encryption** (AES-GCM under `SECRETS_KEY`), which ADR-0019's Worker secrets lacked.
- **No new cost:** one service-binding call per key a minute at most, within the Workers Paid plan.
- **Rollback:** code from before this ignores the `provider:` slots and uses the Worker secrets. The owner keeps the deploy secret until the form has served.
- **The story** is [#496](https://github.com/guedesdiogo/kelpie/issues/496), a sub-issue of [#19](https://github.com/guedesdiogo/kelpie/issues/19). Its tests cover:
  - that a key never appears in a tool's result, history, a log or an error;
  - that a used or expired form refuses;
  - that only `llm-gateway` can call `ProviderKeys`, and only for `provider:` slots;
  - the precedence of a stored key, and the fallbacks.

## Alternatives considered

- **A Cloudflare token for Kelpie,** to write Worker secrets. The owner kept the Cloudflare account out of reach.
- **A second store inside `llm-gateway`,** with its own encryption key. It would add a deploy secret to remove deploy secrets, and the form's redemption would have to cross into it.
- **Calling providers from `channel-egress`.** ADR-0019 rejected it: model access would mix with channel delivery.
- **Pasting a key in chat.** The owner's rule forbids it: the key would pass through the model and the channel.

## References

- [#490](https://github.com/guedesdiogo/kelpie/issues/490): the reference check
- [ADR-0013](0013-self-configuration.md), [ADR-0019](0019-llm-gateway-keys.md), [ADR-0021](0021-vault-app-secrets.md), [ADR-0026](0026-confirmation-by-owner-act.md), [ADR-0028](0028-setup-step-notes.md), [ADR-0064](0064-outside-content-asks.md)
- [`docs/secrets.md`](../secrets.md)
- Hermes Agent at [`41dfcf2`](https://github.com/NousResearch/hermes-agent/tree/41dfcf2c1bd7146d4ad46aea08b7dd007900602e): [secrets kept from the model](https://github.com/NousResearch/hermes-agent/blob/41dfcf2c1bd7146d4ad46aea08b7dd007900602e/tools/skills_tool_setup.py#L87-L118), [refused over messaging](https://github.com/NousResearch/hermes-agent/blob/41dfcf2c1bd7146d4ad46aea08b7dd007900602e/gateway/platforms/base.py#L446-L448)
- ai-memory at [`e52abcb`](https://github.com/akitaonrails/ai-memory/tree/e52abcb6bf2add76d63d5729afda99165475e73e): [tokens redacted before storing](https://github.com/akitaonrails/ai-memory/blob/e52abcb6bf2add76d63d5729afda99165475e73e/crates/ai-memory-core/src/sanitize.rs#L1-L28)
