# Spike: Kelpie drives Claude Code on a VPS through Workers VPC

- **Date:** 2026-10-12
- **Issue:** [#267](https://github.com/guedesdiogo/kelpie/issues/267)
- **Status:** both paths work. Remote Control and the approval relay in one session are still unverified, because the subscription's weekly limit was hit.
- **Source:** throwaway scripts in the session's scratch space, not committed. Everything the spike created was removed afterwards: the tmux sessions, the stub listeners, the tunnel and the VPC Service.

## Questions

1. Can Kelpie drive an interactive Claude Code session with Remote Control from outside? That means sending input, relaying approvals to the user, and reading replies.
2. Can a Worker reach a runner on the owner's VPS without a public port?

## Method

- **Machine:** the owner's VPS, `diogo-dev` (Ubuntu, 4 vCPU, 15 GiB), with Claude Code 2.1.296.
- **Spike 1:**
  - a throwaway git repo with project hooks of `type: "http"` for `SessionStart`, `UserPromptSubmit`, `PermissionRequest`, `Notification` and `Stop`;
  - the hooks pointed at a local stub standing in for Kelpie, which logged each POST;
  - the stub held a `PermissionRequest` until a decision file appeared, simulating the user's answer relayed by Kelpie;
  - Claude Code ran interactive in tmux, and the input was sent with `tmux send-keys`.
- **Spike 2:**
  - `wrangler tunnel create` and `wrangler tunnel run` in the `diogoaguedes` account; wrangler fetched cloudflared by itself, so nothing was installed;
  - `wrangler vpc service create --type http --ipv4 127.0.0.1 --http-port 47832`;
  - a stub runner on `127.0.0.1:47832` that answers 401 without a shared-secret header;
  - a test Worker with a `vpc_services` binding, run with `wrangler dev` and the binding remote, called the runner five times with the secret and once without.

## Results

### Spike 1

| Question | Result |
|---|---|
| Credential | By default `claude` used `CLAUDE_CODE_OAUTH_TOKEN` (`authMethod: oauth_token`), and Remote Control failed with "Claude.ai login was rejected". With the variable unset, the same CLI used the stored claude.ai login (`authMethod: claude.ai`, `subscriptionType: max`). |
| Remote Control | Active on the claude.ai login: "/remote-control is active · Continue here, on your phone, or at https://claude.ai/code/session_…". |
| Hooks in an interactive Remote Control session | `UserPromptSubmit` arrived with `session_id`, `transcript_path`, `permission_mode` and `prompt`. |
| Input from outside | Text sent with `tmux send-keys` became a prompt. |
| Approvals | `PermissionRequest` arrived with `tool_name`, `tool_input` and `permission_suggestions` while the local dialog showed. A reply of `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}` closed the dialog: "Allowed by PermissionRequest hook". Three approvals were relayed (Write, two Bash). |
| A prompt waiting | `Notification`, `notification_type: permission_prompt`, "Claude needs your permission". |
| The reply | `Stop`, with the final text in `last_assistant_message`. |
| The owner's rules | They apply: the session read `~/ops/alerts-open` first, and rtk rewrote its Bash. |
| `SessionStart` over HTTP | Didn't arrive. |
| A new folder | Shows the workspace-trust dialog on its first run. |

The account behind the claude.ai login hit its weekly limit after Remote Control came up ("resets 2pm America/Sao_Paulo"). The approval relay was then run on the setup-token session, without Remote Control.

### Spike 2

- **The path works:** Worker → VPC Service → Tunnel → `127.0.0.1:47832` on the VPS. No public port, no inbound rule.
- **Shared secret:** 200 with it, 401 without it.
- **Latency:** 33, 36, 69, 32 and 57 ms per call. That includes this machine's hop to Cloudflare, because the remote binding runs at the edge.

## What's left

- Remote Control and the approval relay in one session, once the weekly limit resets. That includes an approval answered in the Claude app while the hook waits.
- `Stop` when the turn ends on an API error.
- Latency from a deployed Worker rather than `wrangler dev`.
