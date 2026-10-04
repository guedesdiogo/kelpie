# ADR-0014: Agents are assistants, with a browser and no machine execution

- Status: Accepted
- Date: 2026-10-03
- Issue: [#18](https://github.com/guedesdiogo/kelpie/issues/18) (phase 2 epic, owner decision), with stories [#49](https://github.com/guedesdiogo/kelpie/issues/49) and [#50](https://github.com/guedesdiogo/kelpie/issues/50)

## Context

The owner asked two things: whether Kelpie can work like Hermes Agent on this architecture, and whether agents can use a browser for sites that need manual steps.

Part of Hermes's reach comes from running on a machine: a shell, arbitrary binaries, a filesystem and local stdio MCP servers. Kelpie runs on Workers without containers ([viability study §4.1](../viability-study.md#41-requirements-at-a-glance-current-scope)), so it can't run processes.

Cloudflare Browser Run (formerly Browser Rendering) runs full Chrome sessions driven by code. Facts checked on 2026-10-03:
- **Live View** lets a person watch or control a session in real time, for logins, MFA, CAPTCHA or sensitive input. A Live View URL carries a signed token, and whoever holds it can control the session. The URL must be opened within 5 minutes by default; that deadline can be raised to at most 1 hour. Once connected, the view lasts as long as the session.
- **Sessions can be recorded.** A recording keeps the page's DOM and its network activity, with input fields masked. It stays at Cloudflare for 30 days. It is viewed in the dashboard, or fetched through the REST API with a Cloudflare API token.
- **Pricing, on Workers Paid:**
  - 10 browser hours a month are included, then US$ 0.09 an hour;
  - up to 200 concurrent browsers per account;
  - with Workers bindings, US$ 2.00 per concurrent browser above 10, as a monthly average.
- **Timeouts.** A session closes after 60 s of inactivity. `keep_alive` raises that inactivity timeout to at most 10 minutes; it isn't a limit on how long a session lasts.
- **The Agents SDK's own browser tool** runs CDP code written by the model in Code Mode, on Dynamic Workers. That is a beta, paid surface, flagged as a cost risk in viability study §9 and §10.

## Decision

- **Kelpie's agents are assistants.** They have conversation, memory, skills, scheduled and autonomous tasks, other agents, SaaS integrations through Composio and remote MCP, and a browser.
- **The browser arrives in phase 2,** after a spike (Story 4.2) on keeping a session alive during a human handoff. It is Kelpie's own `browser` tool on Browser Run sessions (Story 4.3), not the Agents SDK's Code Mode tool:
  - high-level page actions (open, read, click, type, extract), implemented by Kelpie;
  - one session per task, with an isolated context per user;
  - a domain allowlist per agent;
  - a confirmation before forms with real effects.
- **Handoff to a person.**
  - When a step needs a person, the agent sends a Live View link only to the user who asked, in a direct conversation, never in a group. The link has a short connection deadline (5 minutes by default, at most 1 hour).
  - The task moves to Waiting (ADR-0011), and the agent resumes after the person replies.
  - If the session or the link expired in the meantime, the agent starts the step again with a new link.
  - The agent never types credentials.
- **Session recording is opt-in per agent,** for audit and debugging. Recordings are viewed in the Cloudflare dashboard, because agents hold no Cloudflare token (ADR-0013). They can contain personal data that Kelpie's erasure workflow (ADR-0006) can't reach before Cloudflare deletes them at 30 days, so the privacy notes must say so.
- **Executing shell commands, arbitrary binaries or files on a machine is out of the current scope.** If it is ever needed, it arrives as one more adapter behind the tool layer, such as a container sandbox or an external runner, without changing the core.

## Consequences

- The README must say plainly what Kelpie is not: a computer-use or coding agent.
- The tool layer keeps a general `ToolProvider` interface, so an execution adapter could be added later with little impact.
- Browser usage is metered, and its cost shows up in the per-agent budget.

## Alternatives considered

- **Containers for a shell and a filesystem now.** That would break the no-containers rule for a capability the current focus doesn't need.
- **The Agents SDK's Code Mode browser tool.** It is flexible, but the model writes the code, and it runs on a beta, paid surface.
- **No browser.** It would leave out sites with no API, and every step that needs a person.

## References

- [Browser Run: Live View](https://developers.cloudflare.com/browser-run/features/live-view/), [Human in the Loop](https://developers.cloudflare.com/browser-run/features/human-in-the-loop/), [Session recording](https://developers.cloudflare.com/browser-run/features/session-recording/), [limits](https://developers.cloudflare.com/browser-run/limits/)
- [Agents: Browser tool](https://developers.cloudflare.com/agents/tools/browser/)
- [Viability study §7, Hermes Agent](../viability-study.md#7-reference-projects-what-to-take)
