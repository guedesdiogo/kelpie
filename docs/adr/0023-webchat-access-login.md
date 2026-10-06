# ADR-0023: The webchat logs in with the owner's Cloudflare Access identity

- Status: Accepted
- Date: 2026-10-06
- Issue: [#40](https://github.com/guedesdiogo/kelpie/issues/40)
- Accepted by the owner on 2026-10-06: «Sim»

## Context

Story 3.7 adds a webchat: a page and a WebSocket where the owner chats with an agent. It is also where the setup agent of Story 3.11 talks to the owner.

The plan approved on 2026-10-03 gave it a login of its own. The admin API would issue a one-time code, and the page would trade it for a short-lived signed token. Since then, three things changed:
- [ADR-0015](0015-single-player-first.md) made Kelpie owner-only;
- the owner chose reversed pairing (#39);
- the owner's Cloudflare Access login became a Directory identity of source `cloudflare-access`. The first-run bootstrap registers it, and the admin API admits it for the agent id `*`.

Two options were compared on #40:
- **(a) A login of its own.** It needs code issuance and redemption, token signing, a new secret, cookie flags, an Origin check, expiry and revocation, and a `webchat` identity paired once.
- **(b) Cloudflare Access.** The page and the socket sit behind Access, and `ingress` admits the owner's existing Access identity.

The owner chose (b) on 2026-10-06, answering «b».

The reference check on #40 found that Hermes ships (a) and uses Access only as an outer layer. Kelpie therefore verifies the Access token itself, as the admin API already does.

## Decision

This amends [ADR-0004](0004-access-control.md) and ADR-0015 for the webchat:

1. **The webchat has no identity or pairing of its own.**
   - Its login is the owner's Access identity. Its ownership was proven when the bootstrap registered it, with the one-time token of [ADR-0013](0013-self-configuration.md).
   - ADR-0004's rule, that each channel identity is enabled after a pairing step, stays for every other channel.
2. **`ingress` admits that identity for chatting,** not only for the admin API's `*`.
   - It verifies the Access token on every webchat request, with the admin API's verifier, now in `@kelpie/access`.
   - It then asks the Directory to admit `{ cloudflare-access, sub }`.
   - The Directory admits the owner for any agent id (ADR-0015), so `ingress` also checks that the agent in the page's address is in the registry.
3. **The socket's upgrade must come from the page's own origin.** Browsers send the Access cookie with any site's WebSocket, so a check on the token alone isn't enough.
4. **The conversation's object trusts only what `ingress` tells it.** `ingress` opens the socket with a request it builds, carrying the admission in a header. The browser's headers, its cookies and its token never reach the conversation.
5. **Until the instance configures Access for the webchat, the webchat is off and answers 404.**

## Consequences

- **One login for the admin API and the webchat.** No webchat-specific secret, token or pairing code exists.
- **Each instance takes one more Access step:** the `/webchat` path behind Access, and two `--var` flags on every `ingress` deploy (`docs/admin-api.md`). `ACCESS_AUD` must be the AUD of the application that covers `/webchat`, or every webchat request is refused.
- **Access settings now gate a channel as well as the admin API.** Whoever passes the policy and holds the Access identity the Directory knows can chat. That is the owner alone, under ADR-0015.
- **A changed Access `sub` locks the webchat out** as it locks out the admin API, and the same token-gated recovery replaces it (#71).
- **Multi-user later** can let colleagues in through Access policies per email. Their identities would still need their own Directory entries, and the Directory would then have to honour grants per agent (ADR-0004), which it doesn't need to while only the owner is admitted.

## Alternatives considered

- **(a) A login of its own,** as approved on 2026-10-03. It is the larger security surface, and it needs a code from somewhere outside the webchat on the first run.
- **Access in front, but a pairing step for a `webchat` identity anyway.** That proves again what the bootstrap already proved, for no gain while Kelpie is single-player.

## References

- [#40](https://github.com/guedesdiogo/kelpie/issues/40): the plan update, the owner's decision and the reference check
- [Cloudflare Access application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)
