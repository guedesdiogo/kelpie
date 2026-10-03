# ADR-0008: Models are reached with API keys, plus an owner-only subscription opt-in

- Status: Accepted
- Date: 2026-10-03
- Issue: [#3](https://github.com/guedesdiogo/kelpie/issues/3)

## Context

The brief asked for OpenAI and Anthropic access by API key or by subscription login (ChatGPT, Claude). The providers' terms:

- **Anthropic** reserves subscription OAuth for Claude Code and its own apps. Its policy says developers "may not collect, store, or intermediate Claude.ai credentials or session tokens", and it forbids routing requests through Free, Pro or Max credentials on behalf of users.
- **OpenAI**'s Sign in with ChatGPT developer docs open plan usage to open-source projects that run locally, and ask paid or remotely hosted apps to join a waitlist. Its terms require tokens to be stored locally under the user's control, outside "a remote or managed environment", and forbid another user's activity from triggering requests on the subscriber's account. (The terms page was read for research note 07; it refused automated access during the cross-check.)

Hermes Agent offers both. Its own code calls the Anthropic path the "Claude Code OAuth identity", and its docs say that path only draws on paid "extra usage" credits. Its OpenAI path identifies itself honestly to the official Codex endpoint, but it uses the Codex device-code login rather than the Sign in with ChatGPT flow, so whether those terms govern it is unverified.

Kelpie runs on Cloudflare. That alone puts subscription login outside both providers' terms, even when only the owner uses it: Anthropic reserves the OAuth for Claude Code, and OpenAI requires local token storage. Serving colleagues breaks the terms a second time. Single-tenancy doesn't change the conclusion.

## Decision

- **API keys** are the supported way to reach models. Native adapters exist for Anthropic Messages and OpenAI Responses, through AI Gateway in passthrough mode with `byok_only` on. Provider fallback lives in Kelpie's `ModelRouter`.
- **Subscription login** is offered as an opt-in, in the style of Hermes:
  - restricted to the owner's own conversations; colleagues always go through API keys;
  - off by default;
  - documented in the README with the policy conflict and the risk of account suspension.
- Version 1 ships API keys only. The opt-in is planned for phase 3.

## Consequences

- The Anthropic opt-in conflicts with Anthropic's written policy. That is an owner decision, taken with the risk stated, and the README must say so plainly.
- For OpenAI, the reading most likely to fit the terms is a local companion on the owner's machine. It would keep the refresh token and hand short-lived access tokens to the owner's instance for the owner's own conversations. That is a reading, not legal advice. OpenAI's waitlist for remotely hosted apps may still apply, and both points are designed when the opt-in is built.
- Cost control relies on API pricing: cheap tiers for most turns, prompt caching, and a budget that reserves the worst case before each call.

## Alternatives considered

- **API keys only.** Fully within both providers' terms. Not chosen by the owner.
- **Subscription login for every user.** Breaks both providers' terms outright.
- **OpenRouter OAuth PKCE**, where users connect and pay for their own account. A possible later adapter.

## References

- [Viability study §8](../viability-study.md#8-subscription-login), [§4.10](../viability-study.md#410-models)
- [Research 07 §1, §2](../research/07-llm-providers-and-auth.md)
- [Research 00: C5 (fallback in the ModelRouter)](../research/00-cross-check.md)
