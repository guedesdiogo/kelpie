# ADR-0019: The keys llm-gateway uses to call providers are deploy secrets

- Status: Accepted
- Date: 2026-10-05
- Issue: [#101](https://github.com/guedesdiogo/kelpie/issues/101)
- Accepted by the owner on 2026-10-05: «sim para chave do type safe», then «quero» to recording it here

## Context

[ADR-0013](0013-self-configuration.md) sends every secret a step needs through a one-time secure form, into Kelpie's secret store. Worker secrets stay for three values the owner sets at deploy: the first model key, the bootstrap token and the store's encryption key.

`llm-gateway` holds the keys used to call providers, and three of them fall outside that list:
- `AI_GATEWAY_TOKEN`, for an authenticated AI Gateway (#95);
- `TYPESAFE_API_KEY`, for Jev at the end of turn (#100, [ADR-0018](0018-jev-direct-api.md));
- `ANTHROPIC_API_KEY`, which the code accepts next to `OPENAI_API_KEY`.

The store can't serve them. It lives in `channel-egress`, and by design none of its entrypoints returns a secret ([`docs/secrets.md`](../secrets.md)). `llm-gateway`, which makes the calls, has no way to read it.

## Decision

This amends ADR-0013 for one scope: the keys `llm-gateway` uses to call a model provider, AI Gateway or Jev are Worker secrets on `llm-gateway`.
- **Who sets them.** The owner, with `wrangler secret put` or `--secrets-file` at deploy. Only the first model key is required; the others are optional and turn their feature on.
- **What stays the same.** They never pass through chat.
- **What doesn't change.** Every other secret keeps ADR-0013's path, through the form into the store. That covers a bot token, and future tool or integration keys.

## Consequences

- **Adding or rotating such a key needs a terminal with `wrangler`.** A chat command can't do it, because runtime code holds no Cloudflare token (ADR-0013). The setup agent points the owner to the deploy docs instead.
- **These keys get no application-level encryption.** They are protected by Cloudflare's Worker secrets and the account's access control.
- **Their exposure is narrow.** `llm-gateway` has no public URL (`workers_dev` is off), other Workers reach it only through service bindings, and its failure logs redact every key.

## Alternatives considered

- **A `channel-egress` entrypoint that hands keys to `llm-gateway`.** It would break the store's rule that no entrypoint returns a secret, and widen what a compromised caller can read.
- **Calling providers from `channel-egress`.** That would mix model access with channel delivery, and put every model key next to the bot tokens.

## References

- [ADR-0013](0013-self-configuration.md): secrets never pass through chat
- [ADR-0018](0018-jev-direct-api.md): Jev through TypeSafe's API
- [`docs/secrets.md`](../secrets.md) and [`docs/admin-api.md`](../admin-api.md)
