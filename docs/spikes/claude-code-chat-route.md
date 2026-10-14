# Spike: Kelpie's chat turns through the Agent SDK on the VPS

- **Date:** 2026-10-13
- **Issue:** [#278](https://github.com/guedesdiogo/kelpie/issues/278)
- **Status:** a Kelpie-like turn works on the owner's subscription, through the unmodified Claude Code binary. The account's claude.ai connectors must be turned off. Not measured: a usage limit.
- **Source:** a throwaway script in the session's scratch space, not committed. The script, its `node_modules` and the session files it wrote under `~/.claude/projects/` were deleted afterwards.

## Questions

1. Can a chat turn run through the Agent SDK on the VPS, on the server's claude.ai login, with Kelpie's system prompt and only Kelpie's tools?
2. How long does a turn take: to the first text, and to its end, cold and in a live session?
3. Does Kelpie's tool loop work through MCP, an approval gate included?
4. What reaches the caller when a turn fails?

## Method

- **Machine:** the owner's VPS, `diogo-dev`.
- **Software:** `@anthropic-ai/claude-agent-sdk` 0.3.296, with its Claude Code 2.1.296. Model `claude-haiku-5-5`.
- **Credential:**
  - The subprocess got the process environment without `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_CUSTOM_HEADERS`. Claude Code then used the stored claude.ai login: `apiKeySource: none`, and `claude auth status` reported `authMethod: claude.ai` and `subscriptionType: max`.
  - The script never read a credential.
- **Identity:** `CLAUDE_AGENT_SDK_CLIENT_APP=kelpie-spike/0.0 (kelpie#278)`, and a short Kelpie system prompt that replaced Claude Code's.
- **Isolation:** `tools: []` and `settingSources: []`. The second run added `strictMcpConfig: true` and `settings: { disableClaudeAiConnectors: true }`.
- **Tools:** an in-process MCP server (`createSdkMcpServer`) with two fakes:
  - `memory_search`, listed in `allowedTools`;
  - `memory_write`, left to `canUseTool`, which logged the call and allowed it.
- **Turns:**
  - a cold turn without a tool;
  - a turn that searches memory;
  - a turn that writes to memory;
  - a turn resumed from the first one's session id;
  - a bad model;
  - two messages in one live session, fed by streaming input.

## Results

### The account's connectors

The first run, without the last two isolation settings, loaded every claude.ai connector of the account as tools:
- Claude Docs, Google Drive, Notion and the Cloudflare Developer Platform, about 100 tools;
- `notion-delete-pages`, Drive's `trash_file`, and Cloudflare's D1, KV and R2 delete tools among them.

The context then reached about 107,000 cached tokens on a turn with a tool.

With `strictMcpConfig: true` and `disableClaudeAiConnectors: true`:
- `init` listed only `mcp__kelpie__memory_search` and `mcp__kelpie__memory_write`;
- a turn used about 2,000 tokens of context.

### Timings

Each turn was timed once, from the call to `query()` to its result.

| Turn | First text | Whole turn | API time | Context (cache read + write) |
|---|---|---|---|---|
| Cold, no tool | 1.6 s | 5.0 s | 0.7 s | 1,530 |
| Memory search (MCP, allowed) | 3.3 s | 7.7 s | 2.5 s | 3,212 |
| Memory write (behind `canUseTool`) | 3.5 s | 6.6 s | 2.6 s | 3,237 |
| Resumed session | 1.8 s | 4.5 s | 1.7 s | 1,580 |
| Live session, 1st message | 1.9 s | 3.6 s | 1.0 s | 1,532 |
| Live session, 2nd message, with a tool | 3.4 s | 5.0 s | 4.3 s | 3,278 |

- **Process start** costs about 3–4 s a turn. In a live session the second message paid about 0.7 s over its API time.
- **Text streamed**, through `includePartialMessages`.
- **Usage came per turn,** with 1-hour cache writes. The SDK's notional cost was about US$ 0.0003 a turn. On a subscription it isn't billed, but it counts toward the plan's limits.

### Tools and approvals

- Both tools ran through MCP, and their answers shaped the replies:
  - "A Ana mora em Lisboa, segundo a sua nota 'Ana Souza'";
  - "Anotado: reunião com a Ana na sexta-feira às 10h."
- `canUseTool` ran for `memory_write`.
- The SDK warned that `memory_search`, listed bare in `allowedTools`, skips `canUseTool` ("Bare allowedTools entries auto-approve the whole tool before the callback is consulted").
- The resumed session recalled the first message.

### Failures

- A bad model ended the turn with `is_error: true`, and the SDK's iterator threw "Claude Code returned an error result: There's an issue with the selected model…".
- A usage limit couldn't be triggered on demand. Anthropic's docs say limit messages also appear in "sessions that another application hosts through the Agent SDK".

## Conclusions for ADR-0037

1. **The route works on the subscription** through the unmodified binary, on the server's login, with no credential in Kelpie's hands.
2. **The isolation settings are mandatory** on every call: `tools: []`, `settingSources: []`, `strictMcpConfig: true` and `disableClaudeAiConnectors: true`.
3. **One live session per conversation** keeps a turn near the API's own time. A process per turn adds 3–4 s.
4. **Approval gates stay in Kelpie's tool handlers,** because `allowedTools` bypasses `canUseTool`.
5. **An error result reaches the caller,** so the provider can tell the owner and fall back.
