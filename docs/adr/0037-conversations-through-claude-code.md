# ADR-0037: Conversations reach Claude through the API key's plan credits first, then through Claude Code on the owner's subscription

- Status: Accepted
- Date: 2026-10-13
- Issue: [#278](https://github.com/guedesdiogo/kelpie/issues/278)
- Decided by the owner in the conversations of 2026-10-12 and 2026-10-13; his answers are quoted on #278

## Context

[ADR-0008](0008-llm-authentication.md) reaches models with API keys, plus an owner-only subscription opt-in planned for phase 3. Its Anthropic half conflicts with Anthropic's written policy, and the owner took that risk.

**#258 checked that half on 2026-10-12.**
- Kelpie called the Messages API with the owner's subscription token, saying it was Kelpie. Both runs answered `429 rate_limit_error`.
- The same token answered in Claude Code, on the same model, minutes apart.

**Anthropic's pages, read on 2026-10-13:**
- **[Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)** has developers use API keys. It doesn't permit them "to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users", and "developers may not collect, store, or intermediate Claude.ai credentials or session tokens".
- **The same page allows a hosted binary:** "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code."
- **The Help Center** ([Agent SDK with your plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), update of 2026-10-07) says "You can still use the Claude Agent SDK, `claude -p`, and third-party apps with your subscription limits."
- **Max and Team plans now include [monthly API credits](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers),** "to build and run your own applications and agents". Any API key in the Claude Console organization linked to the plan spends them. The owner's plan gets US$ 200 a month, and the owner set Kelpie's Anthropic key from that organization on 2026-10-13.

**[ADR-0035](0035-agent-computer.md)** gives agents a computer. On the owner's VPS, Claude Code uses "the server's own Claude login, the owner's subscription. Kelpie never holds it."

**The owner's choices:**
- **Both routes.** «kelpie fica com os dois, quando usarmos via subscription usamos via claude code».
- **The API key's credits first,** then the subscription.
- **A failed route is never silent** («Não deixe que o error 429 em uma subscription da anthropic esteja silencioso»). The owner is told, and Kelpie falls back to the next route; a setting can make it stop instead.
- **The owner's own conversations.** «não aceitamos conversas de grupo no projeto atual». A later group integration will only gather context for the owner's decisions, and will never run tasks anyone but Kelpie's user asks for.
- **The VPS's current login,** the owner's second account (Max), «por hora».

The [spike](../spikes/claude-code-chat-route.md) ran Kelpie-like turns through the Agent SDK on the VPS, on the server's login:
- It found that the account's claude.ai connectors join as tools unless they are turned off.
- It measured about 5 s for a turn with a tool in a live session, against about 8 s when every turn starts a new process.

## Decision

**1. Two routes to Claude, in this order in the route table.**

| Order | Provider | Reaches Claude through | Paid by |
|---|---|---|---|
| 1 | `anthropic` | the Messages API, with the owner's API key from the Console organization linked to the plan | the plan's monthly API credits, then any credits bought |
| 2 | `claude-code` | the Agent SDK, which runs the unmodified Claude Code binary, on ADR-0035's VPS runner | the owner's subscription, within its usage limits |

- Each is one adapter behind the existing provider interface.
- In the model settings of #282, `claude-code` is one more provider.

**2. The `claude-code` provider.**
- **Where it runs:** on the VPS runner only. The shell and the Sandbox don't serve it.
- **Credentials:**
  - It uses the server's own claude.ai login.
  - The runner starts the SDK's subprocess without `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_CUSTOM_HEADERS`.
  - Kelpie never collects, stores or relays a Claude credential.
- **Isolation, on every call:**
  - `tools: []`, so Claude Code's built-in tools are off;
  - `settingSources: []`, so no settings file or `CLAUDE.md` loads;
  - `strictMcpConfig: true`;
  - `settings: { disableClaudeAiConnectors: true }`.

  Without the last two, the account's claude.ai connectors join as tools, the owner's Drive, Notion and Cloudflare among them.
- **Identity:**
  - `CLAUDE_AGENT_SDK_CLIENT_APP` names Kelpie and its version.
  - Kelpie's system prompt replaces Claude Code's.
  - Nothing Kelpie sends presents it as Claude Code.
- **Kelpie's tools** are an MCP server on the runner, whose handlers call Kelpie through the runner's connection. The tool loop runs inside Claude Code.
- **Approvals** stay in Kelpie's tool handlers (ADR-0026). The SDK skips `canUseTool` for any tool listed in `allowedTools`, so that callback can't be the only gate.
- **Sessions:**
  - one live session per conversation, fed by streaming input;
  - after a restart, it resumes from its session id.

**3. Scope: the owner's own conversations** (ADR-0015). Kelpie takes no group conversations.

**4. No route fails silently.**
- A route fails on:
  - a usage limit;
  - a refusal;
  - an error result from Claude Code;
  - an unreachable runner;
  - the API's answer that the credits are spent ("Your credit balance is too low…"), whatever status it comes with.
- Kelpie then tells the owner in the conversation, with a fixed notice (ADR-0027) naming the route and the reason.
- It falls back to the next route unless the owner's setting says to stop. The default is to fall back.

**5. The account:** the VPS's current claude.ai login, for now. Its weekly limit is shared with the owner's own Claude Code sessions on that server.

This amends:
- **ADR-0008:**
  - the Anthropic half of the subscription opt-in goes through Claude Code, through the Agent SDK on the owner's VPS, and never through the Messages API;
  - the API-key route may spend a Max or Team plan's monthly API credits.
- **ADR-0035, §4:** the VPS's login also serves the `claude-code` chat route, so chat and coding share the plan's limits there.

## Consequences

- **Cost.**
  - The credits are spent first. They expire each billing cycle, and a request after they run out stops until the next cycle, unless credits were bought.
  - The subscription adds no cost per turn, but its weekly limits also cover the owner's coding.
- **Latency**, measured once on the VPS (spike):
  - a turn with a tool took 5.0 s in a live session, 4.3 s of it on the API;
  - a cold turn took 5–8 s.

  The API-key route has no process to start.
- **Security.**
  - The isolation settings are mandatory. A test checks that each call sets them.
  - A message can reach only Kelpie's MCP tools and their gates.
  - The login file on the VPS is readable by processes there, as ADR-0035 already accepts.
- **Anthropic's terms.**
  - The legal page allows an end user's own login in the unmodified binary on a platform that hosts it. Running Claude Code in a product also takes the Commercial Terms "unless we've mutually agreed otherwise".
  - The plans' limits assume "ordinary, individual usage". Kelpie's use is the owner's own.
  - Anthropic may enforce its rules "without prior notice". The API-key route is the way back.
  - Asking Anthropic about Kelpie's case (#258) is on hold until the owner decides.
- **Order of work:**
  - the provider ships after ADR-0035's VPS runner story;
  - the failure notice and the fallback setting come with it;
  - the API's answer to spent credits gets its own handling in `errorFromStatus`.
- **Not measured:** a usage limit's exact result. Any error result counts as a route failure.

## Alternatives considered

- **The Messages API with the subscription token, as Kelpie.** #258 measured a 429, and Anthropic's page doesn't allow it.
- **Presenting Kelpie as Claude Code,** as Hermes Agent and ai-memory do. It misrepresents the client.
- **Reading Claude Code's stored credentials,** as ai-memory does with the Codex CLI's login. The legal page forbids it.
- **`claude -p` per turn instead of the Agent SDK.** It runs the same binary, but the SDK gives typed messages, in-process MCP servers and `canUseTool`. `claude -p` stays the fallback if the SDK lacks something.
- **The subscription first.** The credits expire if unused, and the subscription's limits also serve coding, so the owner chose the credits first.
- **Claude Code channels.** They don't serve Kelpie's agents (the owner, 2026-10-12).

## References

- [#278](https://github.com/guedesdiogo/kelpie/issues/278): the owner's answers, the reference check and the spike results; [#258](https://github.com/guedesdiogo/kelpie/issues/258) and [#230](https://github.com/guedesdiogo/kelpie/issues/230)
- [Spike: Kelpie's chat turns through the Agent SDK on the VPS](../spikes/claude-code-chat-route.md)
- [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview), [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), [API credits for Max and Team plans](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers)
