# ADR-0021: The vault's GitHub App credentials are deploy secrets on context-store

- Status: Accepted
- Date: 2026-10-06
- Issue: [#41](https://github.com/guedesdiogo/kelpie/issues/41)
- Accepted by the owner on 2026-10-06, in the instructions for memory v1: the private key goes in as a deploy secret, typed in a terminal with `read -s` into a mode-600 file under `~/.kelpie` that is deleted afterwards, never through chat

## Context

[ADR-0013](0013-self-configuration.md) sends every secret a step needs through a one-time secure form, into Kelpie's secret store. Worker secrets stay for what the owner sets at deploy: the first model key, the bootstrap token and the store's encryption key. [ADR-0019](0019-llm-gateway-keys.md) added the keys `llm-gateway` uses to call providers.

The Context Store (Story 3.8, [ADR-0005](0005-context-store.md)) reaches the owner's vault through a GitHub App. It holds two secrets that fit neither ADR:
- `GITHUB_APP_PRIVATE_KEY`, the App's key, which signs the JWT that mints installation tokens;
- `GITHUB_WEBHOOK_SECRET`, which checks that a push webhook came from GitHub.

The secret store can't serve them, for the reason ADR-0019 gives: it lives in `channel-egress`, and none of its entrypoints returns a secret. `context-store` makes the calls and checks the webhook, and has no way to read it.

## Decision

This amends ADR-0013 for one more scope: the vault's GitHub App private key and webhook secret are Worker secrets on `context-store`.
- **Who sets them.** The owner, at deploy, through `--secrets-file` from a file only the owner can read, deleted right after (`docs/context-store.md`). They never pass through chat.
- **Optional.** Without them, or without the App ID, installation ID and repository given as `--var` flags, the vault is off and agents run on their configured prompts.
- **What doesn't change.** Every other secret keeps ADR-0013's path, through the form into the store.

## Consequences

- **Rotating the App's key or the webhook secret needs a terminal with `wrangler`.** A chat command can't do it: runtime code holds no Cloudflare token (ADR-0013).
- **The key gets no application-level encryption.** Cloudflare's Worker secrets and the account's access control protect it, as with ADR-0019's keys.
- **The exposure is narrow:**
  - `context-store` has no public URL: ingress reaches it through a service binding, and only its webhook entrypoint.
  - Installation tokens are narrowed to the vault repository, and to contents, pull requests and metadata, whatever else the App may do.
  - Errors name the failed call and its status, never a credential.

## Alternatives considered

- **The secret store, read through a new `channel-egress` entrypoint.** It would break the store's rule that no entrypoint returns a secret, as ADR-0019 found for `llm-gateway`.
- **Committing through `channel-egress`.** It would put the vault's credentials next to the bot tokens, and mix context with channel delivery.

## References

- [ADR-0013](0013-self-configuration.md), [ADR-0019](0019-llm-gateway-keys.md)
- [Spike #28](../spikes/github-commit-from-worker.md): the App's key as PKCS#8, and installation tokens from a Worker
- [`docs/context-store.md`](../context-store.md), [`docs/secrets.md`](../secrets.md)
