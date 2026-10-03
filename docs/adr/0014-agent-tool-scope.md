# ADR-0014: Agents are assistants, with a browser and no machine execution

- Status: Accepted
- Date: 2026-10-03
- Issue: [#18](https://github.com/guedesdiogo/kelpie/issues/18) (phase 2 epic), with stories [#49](https://github.com/guedesdiogo/kelpie/issues/49) and [#50](https://github.com/guedesdiogo/kelpie/issues/50)

## Context

The owner asked whether Kelpie can work like Hermes Agent on this architecture, and whether agents can use a browser for sites that need manual steps.

Hermes's reach comes partly from running on a machine: a shell, arbitrary binaries, a filesystem, and local stdio MCP servers. Workers without containers can't run processes (ADR-0002, research note 05).

Cloudflare Browser Run (formerly Browser Rendering) runs full Chrome sessions driven by code, with three features that matter here:
- Live View lets a person watch or control a session in real time, for logins, MFA, CAPTCHA or sensitive input;
- sessions can be recorded;
- on Workers Paid, 10 browser hours a month are included, then US$ 0.09 an hour, with up to 200 concurrent browsers per account.

A session closes after 60 s of inactivity, or after at most 10 minutes with `keep_alive`.

## Decision

- **Kelpie's agents are assistants.** They have conversation, memory, skills, scheduled and autonomous tasks, other agents, SaaS integrations through Composio and remote MCP, and a browser.
- **The browser arrives in phase 2,** after a spike (Story 4.2) on keeping a session alive during a human handoff. It is a `browser` tool on Browser Run (Story 4.3):
  - high-level page actions;
  - one session per task, with an isolated context per user;
  - a domain allowlist per agent;
  - a confirmation before forms with real effects;
  - session recordings.

  When a step needs a person, the agent posts a Live View link in chat, the task moves to Waiting (ADR-0011), and the agent resumes after the person replies. The agent never types credentials.
- **Executing shell commands, arbitrary binaries or files on a machine is out of the current scope.** If it is ever needed, it arrives as one more adapter behind the tool layer, such as a container sandbox or an external runner, without changing the core.

## Consequences

- The README must say plainly what Kelpie is not: a computer-use or coding agent.
- The tool layer keeps a general `ToolProvider` interface, so an execution adapter could be added later with little impact.
- Browser usage is metered, and its cost shows up in the per-agent budget.

## Alternatives considered

- **Containers for a shell and a filesystem now.** That would break the no-containers rule for a capability the current focus doesn't need.
- **No browser.** It would leave out sites with no API, and every step that needs a person.

## References

- [Browser Run: Live View](https://developers.cloudflare.com/browser-run/features/live-view/), [Human in the Loop](https://developers.cloudflare.com/browser-run/features/human-in-the-loop/), [limits](https://developers.cloudflare.com/browser-run/limits/)
- [Agents: Browser tool](https://developers.cloudflare.com/agents/tools/browser/)
- [Viability study §7, Hermes Agent](../viability-study.md#7-reference-projects-what-to-take)
