# ADR-0033: The deploy wakes the Directory, the Registry and every AgentHost through a signed deep probe

- Status: Accepted when the pull request for #234 merges
- Date: 2026-10-12
- Issue: [#234](https://github.com/guedesdiogo/kelpie/issues/234)
- Amends: [ADR-0029](0029-continuous-deployment-and-rollback.md), its probes and its automatic rollback
- Requested by the owner on 2026-10-12: «pode abrir as issues e pode paralelisar todos os 4 itens»

## Context

- **ADR-0029's probes reach ingress, channel-egress and its `SecretStore`, and context-store.** Its residual:
  - conversation-runtime, llm-gateway and admin-api are judged only by analytics, which a single owner's traffic rarely feeds in the 10-minute watch;
  - `Directory`, `Registry` and each `AgentHost` apply their Drizzle migrations on their first request, possibly after the watch ended.
- **Each Durable Object migrates in its constructor,** inside `blockConcurrencyWhile`. Any call waits for the migrations, and fails if they fail.
- **A route that wakes objects can't be public.** It needs a secret that the pipeline holds. The pipeline's secrets live in GitHub's `production` environment, which only `main` can use.
- **Cloudflare refuses a rollback across a secret change** unless forced (error 10220). Forcing restores the older version's secrets. In this tool, `force` on request also crosses destructive SQL migrations.
- **The reference projects** (#233's check): none of them wakes state after a deploy. invokta's bounded probe, with separate verdicts per part, is the shape adapted here.

## Decision

1. **A deep probe.**
   - ingress answers `POST /deploy/probe` with `{ directory, registry, agentHosts, gateway }`, each `ok` or `failed`, with no ids and no data.
   - It pings the `Directory`. A `DeployProbe` entrypoint in conversation-runtime, bound only by ingress, pings the `Registry` and every `AgentHost` it lists, ten at a time.
   - llm-gateway's `ping()` loads its route table, provider settings and embedding provider, and calls no model.
   - Each `ping()` answers once its object's migrations ran.
2. **Signed, never sent.**
   - The header is `<unix seconds>.<hex HMAC-SHA256 of those seconds, keyed with DEPLOY_PROBE_TOKEN>`.
   - ingress accepts a time within two minutes of its clock, and compares the MAC in constant time.
   - Anything else, a missing secret, or a secret under 32 characters gets the 404 of an unknown path, and wakes nothing.
3. **The deploy's settle and watch run it as a fifth probe,** when the token is set and the origin is https. A failed part fails the probe like any other, so the automatic rollback covers these objects. Rollback checks, automatic and on request, keep ADR-0029's four probes: an older build has no route.
4. **The token's lifecycle.**
   - It lives in the `production` environment and in ingress, nowhere else. Only ingress's `wrangler deploy` gets it, through a private file, `--secrets-file`.
   - **Upload once:** a deploy uploads it only when the live ingress has no `DEPLOY_PROBE_TOKEN`.
   - **Rotation, by dispatch:** the Deploy workflow's `rotate-probe-token` input uploads it even though ingress holds one. Merges never rotate.
   - **Immediate revoke:** `wrangler secret delete` on ingress, then a new value in the environment.
   - A missing or malformed token skips the upload and the deep probe with a warning. It never stops a deploy.
5. **Rollbacks and the token.**
   - The automatic rollback forces ingress only when this deploy uploaded the token. The version it restores is the one the deploy replaced, so the only secret change it undoes is the deploy's own.
   - Otherwise ADR-0029's rule stands: crossing a secret change takes `force`, on request.
   - Either report warns when ingress went back past an upload, and says what to run.

## Consequences

- **ADR-0029's coverage residual narrows.** admin-api is still judged by analytics. Each conversation's object still migrates on its first request. A broken model call still shows only in analytics.
- **ingress holds one more secret.** A leaked token wakes objects and tells whether each part answers; it reveals no data. A header that reaches a log expires in two minutes.
- **A rollback past an upload or a rotation** needs `force` on request, and leaves ingress on that version's token, or none. After a rolled-back rotation, the deep probe fails every deploy until the rotation runs again; the reports say so.
- **Not verified until the first real deploy:** how Cloudflare's 10220 check treats the first upload of a secret.

## Alternatives considered

- **Sending the token itself in the header.** Simpler, but Workers Logs can record headers, and a logged token would work until rotated.
- **Uploading the token on every deploy.** Each upload is a secret change, so every rollback of ingress on request would need `force`, which also crosses destructive migrations. `force` would become routine and stop marking risk.
- **Probing through admin-api.** It sits behind Access, so CI would need an Access service token, a second secret with more reach.
- **Waking the objects at Worker startup.** A Durable Object runs no code until something calls it.
