# ADR-0069: Master answers, messages and ends the VPS's Claude Code sessions, while the Claude app still can

- Status: Accepted
- Date: 2026-10-22
- Issue: [#491](https://github.com/guedesdiogo/kelpie/issues/491)
- Decided by the owner on 2026-10-22:
  - «Gostaria de ter como permitir fazer tudo via kelpie porém também permitir eu interagir direto no claude code, mas pelo que entendi o hook trava e fica aguardando o kelpie, é isso?»;
  - the plan: «Aprovo os três (Recomendado)», for #489, #490 and #491.
- Amends: [ADR-0057](0057-vps-claude-code-sessions.md) §1, §2, §3 and §5, [ADR-0026](0026-confirmation-by-owner-act.md) (a press that resolves a request in code), and [ADR-0035](0035-agent-computer.md)'s open question for the sessions the owner opens in the app

## Context

[ADR-0057](0057-vps-claude-code-sessions.md) has Kelpie only observe the VPS's Claude Code sessions: «Through it, Kelpie never sends input, never answers a prompt, and never ends or archives a session.» The owner now asks to do everything through Kelpie, and to keep acting in Claude Code directly.

**What the VPS and the docs show,** read on 2026-10-22:
- **The Claude app is the permission host of its sessions.** All 29 app sessions running on the VPS were started with `--permission-prompt-tool=stdio` [observed, in each process's command line].
- **Hooks run beside such a host.** The hooks reference says: "For a call that reaches a `--permission-prompt-tool` or the Agent SDK's `canUseTool` callback, the hooks run alongside your host, and whichever decides first applies." [doc]
  - A `PermissionRequest` hook may return `decision.behavior` `allow` or `deny`. One that returns no decision leaves the permission flow unchanged [doc].
  - A command hook's default timeout is 600 seconds [doc].
- **Cross-session messaging.** Claude Code binds an inbox socket for each session, and a process of the same OS user may post a message there [doc].
  - Hooks get the socket's path in `CLAUDE_CODE_MESSAGING_SOCKET` [doc].
  - The session reads such a message as coming from another session, not from the owner: "it can't approve anything", "it can't change configuration", and its permission prompts still fire [doc].
  - The VPS runs Claude Code 2.1.303, past the 2.1.224 the feature needs [observed].
- **Channels** relay prompts too, and both answers stay live. But a session must be started with `--channels`, which the app doesn't pass. A custom channel also needs a development flag with a warning dialog [doc].
- **Archiving** still has no supported path outside the app.

The reference check is on #491.

## Decision

### 1. Approving and denying a permission

- **The hook waits beside the app.** The `PermissionRequest` hook becomes synchronous, with a timeout of 600 seconds, the hooks' default:
  - it writes the request to the spool: the session, a random request id, the tool, and its input, redacted and cut to 500 characters;
  - it then waits for Kelpie's verdict in a file the runner writes.
- **Where it waits:** only in a session the Claude app opened, whose session file's `entrypoint` is the app's, and which the runner didn't start. In any other session it returns no decision at once:
  - a terminal's session has no host beside the hook, so a waiting hook could hold its prompt back;
  - the sessions Kelpie starts keep their own relay (ADR-0035 §3).
- **What it returns:**
  - `allow` or `deny`, when Kelpie's verdict comes;
  - no decision, so nothing changes, when the session moves on (the owner answered in the app), when no verdict comes, or at its timeout.
- **It never blocks a session:** it always exits 0, and any doubt returns no decision.
- **Questions aren't approved this way.** A `PermissionRequest` for `AskUserQuestion` returns no decision at once: an `allow` would dismiss the question. The owner answers it in the app, or sends the session a message (§2).
- **Kelpie tells the owner** in a fixed notice ([ADR-0027](0027-fixed-texts-in-three-languages.md)) with Approve and Deny, for a pending permission request only:
  - the notice names the session's title, the tool and its input, as plain text, never as a link;
  - a wait with no pending request, opened by a `Notification` or by a session file (ADR-0059), keeps ADR-0057's notice, with no buttons.
- **The buttons resolve the request in code,** with no model turn: a press is the verdict.
  - In the webchat, they are Kelpie's buttons, bound to the request's random id, by ADR-0026 §3's rules for a press.
  - On Telegram, they are inline buttons on the callback path of [ADR-0067](0067-master-reaches-every-owner-command.md) §3, whose data is the request's random id.
  - A press counts only from the owner: in the webchat, the owner's own socket; on Telegram, the paired owner's account, in the chat where Kelpie sent the notice.
  - It counts once, and only while that request is open. A press after the app answered, or after the timeout, changes nothing, and the notice says so.
  - There is no typed code for these: the app stays the other way to answer.
- **Master's words never approve,** and nor does a session's text.

### 2. Sending a session a message

- **Master's tool `message_session`** has the runner post the text to the session's inbox socket. The `SessionStart` hook records the socket's path in the spool.
- **It arrives as another session's message,** so it approves nothing and changes no configuration there.
- **When it runs:** only in a turn the owner typed. ADR-0064 holds it after outside content. Since `vps_sessions` marks its turn, a message sent right after listing waits for the owner's yes.

### 3. Ending a session

- **Master's tool `end_session`** has the runner send `SIGTERM` to the session's process.
- **First, the runner checks the process:** a Claude Code process of the owner's user, named in a session file whose id is a UUID.
- **It takes the owner's confirmation.**
- **Archiving stays in the Claude app.**

### 4. What leaves the server

Besides ADR-0057 §3's fields, a pending request's tool and its input leave the server:
- redacted twice, in the hook and in the runner, with ADR-0057 §3's rules;
- cut to 500 characters.

The owner accepted the title and the excerpt in ADR-0057. This adds the tool's input.

### 5. Not determined yet

The story checks these first, on the VPS:
- that the app's prompt shows while the hook waits, and that the first answer wins;
- what happens to the waiting hook when the app answers first;
- that the runner's message is delivered, not held, in an app session;
- that `SIGTERM` ends a session cleanly, and how the app then shows it.

**If the app's prompt waits for the hook,** the fallback goes to the owner before the hook is built: it would wait only while the owner has asked Master to answer through Kelpie, and return at once otherwise.

### 6. What doesn't change

- **Sessions Kelpie starts** (ADR-0035 §3) and **the chat route's sessions** (ADR-0037) keep their own relay.
- **ADR-0057's notices** of a wait still come, once a minute at most.
- **Channels** stay unused.

### 7. Amendments

- **[ADR-0057](0057-vps-claude-code-sessions.md):**
  - §1: Kelpie acts on the sessions, besides observing them;
  - §2: the `PermissionRequest` hook becomes synchronous, with a timeout of 600 seconds, in the app's sessions only. The other hooks stay asynchronous, with their 2 seconds;
  - §3: a pending request's tool and its input leave the server too;
  - §5: Master gains `message_session` and `end_session`, and a wait's notice gains Approve and Deny.
- **[ADR-0026](0026-confirmation-by-owner-act.md):** a press on Approve or Deny resolves a VPS session's request in code, by the rules of a press: the owner only, once, while it is open.
- **[ADR-0035](0035-agent-computer.md):** its open question, about the owner answering in the Claude app while a hook waits, stays open for the sessions Kelpie starts. For the sessions the owner opens in the app, §1 answers it: the first answer wins, once §5's check confirms it.

## Consequences

- **The owner answers a session's prompt wherever they are,** in the Claude app or through Kelpie, and sends it a message or ends it from Master.
- **A synchronous hook runs on every permission of every app session.** It is small, bounded and tested. Rolling back means putting the asynchronous `PermissionRequest` entry of ADR-0057 back in `settings.json`, as `docs/runner.md` will say.
- **The tool's input leaves the server,** redacted and cut. It reaches Cloudflare, Telegram when the notice goes there, and the model's provider when Master reads it.
- **A verdict file is a convention, not a lock.** Sessions run as the owner's user, as the runner does, so a session could write a verdict for itself. That gives it nothing it lacks: a process of the owner's user can already change the owner's settings.
- **The runner's protocol version goes up.** A runner not yet updated answers `outdated`, and the tools say so.
- **No new cost:** a verdict is one more runner call, within the Workers Paid plan.
- **The story** is [#497](https://github.com/guedesdiogo/kelpie/issues/497), a sub-issue of [#19](https://github.com/guedesdiogo/kelpie/issues/19). Its tests cover:
  - the hook's timeout, and its return of no decision;
  - the redaction;
  - a verdict's binding to its request id;
  - the process check before `SIGTERM`.

## Alternatives considered

- **Channels.** They need `--channels` at launch, which the app doesn't pass.
- **Keep observing only.** The owner asked to do everything through Kelpie.
- **A hook that waits only while the owner is away.** It is the fallback if the app's prompt waits for the hook, since it needs a switch the owner must remember.
- **Typing into the session.** The app's sessions read their input from the app, over stdio. Only the inbox socket reaches them from outside.

## References

- [#491](https://github.com/guedesdiogo/kelpie/issues/491): the reference check
- Claude Code docs: [hooks](https://code.claude.com/docs/en/hooks), [cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging), [channels reference](https://code.claude.com/docs/en/channels-reference)
- [ADR-0026](0026-confirmation-by-owner-act.md), [ADR-0027](0027-fixed-texts-in-three-languages.md), [ADR-0035](0035-agent-computer.md), [ADR-0037](0037-conversations-through-claude-code.md), [ADR-0057](0057-vps-claude-code-sessions.md), [ADR-0064](0064-outside-content-asks.md)
- Hermes Agent at [`41dfcf2`](https://github.com/NousResearch/hermes-agent/tree/41dfcf2c1bd7146d4ad46aea08b7dd007900602e): [Claude Code through tmux, answering its own prompts](https://github.com/NousResearch/hermes-agent/blob/41dfcf2c1bd7146d4ad46aea08b7dd007900602e/skills/autonomous-ai-agents/claude-code/SKILL.md#L92-L126)
- invokta at [`f1e2f04`](https://github.com/vinilana/invokta/tree/f1e2f04f98c967ab4bb73bd02c3fa581f04ce0e5): [a `PermissionRequest` hook that only records](https://github.com/vinilana/invokta/blob/f1e2f04f98c967ab4bb73bd02c3fa581f04ce0e5/examples/agent-session-engine/hooks/claude-code.settings.json#L69-L79)
