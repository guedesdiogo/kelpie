# ADR-0001: Kelpie is single-tenant, self-hosted and for internal use

- Status: Accepted
- Date: 2026-10-03
- Issue: [#12](https://github.com/guedesdiogo/kelpie/issues/12)
- Amended by: [ADR-0015](0015-single-player-first.md), until multi-user lands (single-player)

## Context

The original brief asked for a multi-tenant platform with many agents per tenant. The research priced what multi-tenancy costs on Cloudflare:
- a tenant key in every Durable Object name and every query;
- envelope encryption for per-tenant secrets, because the Secrets Store holds 100 secrets per account;
- vendor ceilings shared by every tenant;
- Meta Tech Provider onboarding for WhatsApp;
- tenant onboarding and billing.

While reviewing the study, the owner described the product differently: something that works like Hermes Agent, without a VPS, on serverless infrastructure, cheap to start and able to scale, used internally by the owner and their work partners, with each agent acting as an extra employee.

## Decision

One Kelpie instance belongs to one owner, a person or a company, and runs on the owner's Cloudflare account. An instance has many agents and many internal users. There is no tenant layer, not even a dormant one "for the future". If multi-tenancy is ever needed, it gets its own ADR.

## Consequences

- Durable Object names, storage keys and queries carry no tenant identifier.
- Platform secrets (channel tokens, API keys) live in Worker secrets and the Secrets Store. Secrets added at runtime, through Kelpie's self-configuration, go to an encrypted store instead ([ADR-0013](0013-self-configuration.md)). Tokens stored per user, such as MCP OAuth tokens, are still encrypted at the application level under a key kept as a secret.
- Vendor ceilings (Jev's 200 requests per minute per gateway, GitHub's 500 writes per hour, Composio's rate limit) apply to one instance, which suits internal use.
- On WhatsApp, a company uses its own number. Tech Provider onboarding, which serves other businesses' numbers, is not expected to apply (inference; to confirm during the WhatsApp work).
- Multi-agent orchestration, per-user memory isolation, erasure rights and access control stay in scope.
- Subscription login does not become compliant through single-tenancy ([ADR-0008](0008-llm-authentication.md)).

## Alternatives considered

- **Multi-tenant SaaS.** It shows SaaS architecture, but at several times the scope, and most of that work wouldn't serve the stated use.
- **Single-tenant with a dormant tenant key everywhere.** Cheap insurance in theory; in practice an abstraction for a hypothetical requirement.

## References

- [Viability study §2 Scope](../viability-study.md#2-scope)
- [Research 05: hard constraints R12–R14](../research/05-cloudflare-limits-and-architecture.md)
- [Research 00 §3: viability under the multi-tenant brief](../research/00-cross-check.md#3-requirement-by-requirement-viability)
