# ADR-0035: Agents get a computer: a shell by default, and on request a Cloudflare Sandbox or the owner's VPS, where they code through Claude Code

- Status: Accepted
- Date: 2026-10-12
- Issue: [#267](https://github.com/guedesdiogo/kelpie/issues/267)
- Decided by the owner in the conversation of 2026-10-12; his answers are quoted on #267
- Amended by: [ADR-0037](0037-conversations-through-claude-code.md), the VPS's login also serves the `claude-code` chat route (§4)
- Amended by: [ADR-0069](0069-master-acts-on-vps-sessions.md), the open question on the owner answering in the Claude app while a hook waits gets an answer for the sessions the owner opens: the first answer wins

## Context

[ADR-0014](0014-agent-tool-scope.md) kept running shell commands, binaries or files on a machine out of scope, and expected that capability to come back as "one more adapter behind the tool layer, such as a container sandbox or an external runner". On 2026-10-12 the owner asked for agents that can code, and for a machine Kelpie can use for more than coding.

The research is on #267:
- the options: Cloudflare's Sandbox and shell, Workers VPC, Claude Managed Agents, Claude Code routines, GitHub Actions, and other sandbox vendors;
- their costs at list prices;
- the reference check of Hermes Agent, moltworker and OpenClaw.

The owner's choices:
- **Runners.** Two for now: the owner's VPS, and a Cloudflare Sandbox. The VPS is preferred when one is configured.
- **Claude Code is the only coding harness.** The owner trusts it, and follows its sessions in the Claude app.
- **Remote Control** is on in every Claude Code session, unless a setting turns it off.
- **Approvals.** Every approval goes through the Kelpie agent, in contact with the real user.
- **Credentials.** The subscription runs Claude Code for now; API keys may come later. The owner accepts the conflict with Anthropic's terms.
- **A shell by default,** for simple tasks, because it adds no cost in most cases.
- **Opt-in for cost.** Coding is off by default, even on the Sandbox. Any feature that adds cost turns on only at the user's explicit request and with their approval (`CLAUDE.md`, design rules).
- **Merge** is the user's rule, not Kelpie's. The question is asked when an agent that can code is created.

The [spikes](../spikes/agent-computer.md) checked that:
- Kelpie can drive an interactive Claude Code session from outside;
- it can relay the session's approvals to the user and read its replies;
- a Worker reaches a runner on the VPS through Workers VPC, with no public port.

## Decision

**1. A `Computer` port, chosen by configuration, with three adapters.**

| Adapter | Default | Runs | Cost |
|---|---|---|---|
| `shell` | **on** for every agent | `@cloudflare/shell` on Dynamic Workers: a virtual filesystem kept in Durable Object storage, and an interpreted bash. Files and text tasks; no real processes | within the Workers Paid plan in most cases: 1,000 unique Dynamic Workers a month are included, then US$ 0.002 per Worker per day |
| `cloudflare-sandbox` | **off**; turned on at the owner's request, with confirmation | Sandbox SDK 1.0: a container per agent, `standard-3` by default (2 vCPU, 8 GiB, 16 GB), with a snapshot of its files | per hour of use; about US$ 0.08–0.12 an hour in typical use |
| `vps` | **off**; turned on by configuring a runner | the owner's server, reached through a Cloudflare Tunnel and a Workers VPC Service | the owner's server |

- **Which adapter serves a request:** the VPS when one is configured, then the Sandbox when it is on, then the shell.
- **The shell's workspace** is named per agent and reused, so unique Dynamic Workers stay within the included amount.
- **The Sandbox** reaches only allow-listed hostnames. The Worker adds credentials to outbound requests, and the container sleeps when idle.
- **The VPS runner** is one process on the server, reachable only through its VPC Service. It authenticates Kelpie with a shared secret, and the server opens no public port.

**2. Coding ("Kelpie Code") is Claude Code, on the VPS or the Sandbox.**
- It is off by default, per agent, and turned on at the owner's request with confirmation (ADR-0013, ADR-0026).
- **The shell can't run Claude Code.**
- **The session:**
  - The runner starts Claude Code interactive, in tmux, on a workspace it has already trusted.
  - On the VPS it starts it **without `CLAUDE_CODE_OAUTH_TOKEN`**, so the machine's claude.ai login is used. A `setup-token` can't open Remote Control.
- **Remote Control** is on by default, with a setting to turn it off. The owner follows and steers the session in the Claude app.

**3. Kelpie sits between the user and Claude Code.**
- **Input:** Kelpie sends the user's messages to the session through the runner.
- **Hooks:** the session's hooks of `type: "http"` post to the runner, which forwards them to Kelpie:
  - `PermissionRequest`: the tool and its input. Kelpie asks the user (buttons or a code, ADR-0026) and returns `allow` or `deny`. A timeout denies. Content from tools, pages or other agents never approves.
  - `Notification`: the session waits on the user.
  - `Stop`: the reply, in `last_assistant_message`, which Kelpie relays in the conversation.
- **The runner keeps the VPS free of inbound traffic.** It talks to Kelpie through its outbound connection; the stories choose the transport.

**4. Coding credentials belong to the runner, apart from the chat model routes.** An agent may chat on any provider while it codes with Claude Code.
- **On the VPS:** the server's own Claude login, the owner's subscription. Kelpie never holds it.
- **On the Sandbox:** a credential the owner configures for coding, an API key by default. A claude.ai login inside the container is possible for Remote Control, but commands run there could read it.

**5. Merging follows a per-agent policy,** asked when coding is turned on:
- on the user's request in chat, after the agent explains what is delivered in plain language (the default when unanswered);
- after the owner's review;
- never.

Kelpie's GitHub App performs the merge, so the rule lives in Kelpie whatever the runner. CI and branch protection always apply.

This amends:
- **ADR-0014:** machine execution comes into scope through the `Computer` port. Its "no machine execution" no longer holds, and the README no longer calls Kelpie container-free.

## Consequences

- **Cost.**
  - The shell stays within the plan in most cases.
  - The Sandbox costs per hour of use. Cheaper than a VPS on demand; dearer if kept on all month.
  - The model is the dominant cost: a subscription is fixed, while an API key costs about US$ 13 per active day according to Anthropic.
  - The cost reports of #269 cover the computer once it exists.
- **Security.**
  - An agent that reads the web and memory gets a shell on the owner's machine, with the owner's credentials.
  - Relayed approvals, deny rules and the owner's own Claude Code rules reduce that risk without removing it. The owner accepted it.
  - On the Sandbox, credentials stay in the Worker.
- **Availability.** The subscription has weekly limits. The spike hit one, and a coding session then answers only with the limit's notice.
- **Previews and betas.** Each sits behind the port, so a change hits one adapter:
  - Dynamic Workers (open beta);
  - Workers VPC (beta, free meanwhile);
  - `wrangler tunnel` (experimental);
  - the Sandbox's snapshots (public beta).
- **Anthropic's terms.** Driving Claude Code on a subscription from a bot conflicts with Anthropic's written policy, as ADR-0008 already notes. It is the owner's decision, and API keys remain the fallback.
- **Verified together:** Remote Control and the approval relay worked in one session, once the claude.ai login moved to the owner's second account. **Still open:** what happens when the owner answers in the Claude app while the hook waits.
- **Docs.** Setting up a VPS as Kelpie's computer is documented later (#268).

## Alternatives considered

- **Claude Managed Agents.** No server to run, but billed per session-hour on top of API tokens, with no subscription and no Claude Code CLI.
- **Other sandbox vendors** (E2B, Daytona, Modal, Vercel Sandbox). They cost more per hour than Cloudflare's Sandbox, which bills CPU only while active, and each adds a vendor.
- **Claude Code routines.** Subscription-friendly, but a research preview, with rate limits and no live relay.
- **GitHub Actions.** Billed per minute. The owner already moved his runners to a VPS.
- **Code Mode on Dynamic Workers for coding.** No Linux, no child processes and no git.
- **A Claude Code channel for input.** A research preview that needs a development flag; tmux and hooks cover the same ground.
- **A harness other than Claude Code.** The owner's choice.

## References

- [#267](https://github.com/guedesdiogo/kelpie/issues/267): the owner's answers, the cost comparison, the reference check and the spike results
- [Spike: Kelpie drives Claude Code on a VPS through Workers VPC](../spikes/agent-computer.md)
- [Cloudflare Sandbox: Run coding agents in a sandbox](https://developers.cloudflare.com/sandbox/coding-agents/), [Workers VPC](https://developers.cloudflare.com/workers-vpc/), [Dynamic Workers pricing](https://developers.cloudflare.com/dynamic-workers/pricing/)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks), [Remote Control](https://code.claude.com/docs/en/remote-control), [authentication](https://code.claude.com/docs/en/authentication)
