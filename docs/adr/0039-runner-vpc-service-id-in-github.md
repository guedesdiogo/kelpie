# ADR-0039: The runner's VPC Service id is a variable of GitHub's production environment

- Status: Accepted when the pull request for #294 merges
- Date: 2026-10-14
- Issue: [#294](https://github.com/guedesdiogo/kelpie/issues/294)
- Amends: [ADR-0029](0029-continuous-deployment-and-rollback.md) §3, which keeps instance values out of GitHub

## Context

- **The binding.** [ADR-0035](0035-agent-computer.md) §1 has Workers reach the owner's runner through a Workers VPC Service. Story 5.9 gives that binding to `channel-egress`, the only Worker that calls the runner.
- **`wrangler deploy` takes vars as flags, but no binding.** A binding lives in the Worker's config. The VPC Service's id belongs to one instance, so it can't sit in the committed `wrangler.jsonc`, which every instance deploys.
- **ADR-0029 §3** carries instance vars from the live version, "so their values stay out of the repository and out of GitHub". Carrying a binding the same way would need:
  - the release tool to read it from Cloudflare's API, in a shape nobody has checked yet;
  - a first deploy by hand, with a config of its own.
- **A precedent:** [ADR-0033](0033-deploy-deep-probe.md) already keeps `DEPLOY_PROBE_TOKEN` in GitHub's `production` environment, which only `main` can use.

## Decision

- **Where the id lives:** the variable `RUNNER_VPC_SERVICE_ID` of GitHub's `production` environment. It isn't a secret: it names a resource that only the account's own tokens can use.
- **How it reaches the binding:** when the variable holds a UUID, the release tool deploys `channel-egress` with its committed config plus the `RUNNER` binding. It writes that config to a file beside the committed one, and deletes the file right after. Without the variable, `channel-egress` deploys as before.
- **Logs:** the deploy masks the id.

## Consequences

- **Timing.** Setting the variable takes effect at the next deploy. The first time, that is a deploy by hand with `always` (`docs/runner.md`).
- **Losing the binding.** A deploy of `channel-egress` by hand, or a rollback to a build from before the variable, drops the binding until the next deploy through the pipeline. Meanwhile the runner reads as `not_configured`.
- **A wrong id** fails every deploy at `channel-egress`, which then rolls back. Deleting the variable restores deploys.

## Alternatives considered

- **Carrying the binding from the live version, as vars are.** It keeps the id out of GitHub, but needs a deploy by hand to set it, and an API shape not checked yet. It stays the way to go if values kept in GitHub become a problem.
- **Committing the id in `wrangler.jsonc`.** It would tie the public repository to one account, and break other instances' deploys.

## References

- [#294](https://github.com/guedesdiogo/kelpie/issues/294): the plan, its correction, and the reviews
- [docs/runner.md](../runner.md) and [docs/deploy.md](../deploy.md)
- [Workers VPC Services](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/)
