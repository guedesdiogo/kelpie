# ADR-0069: Master answers, messages and ends the VPS's Claude Code sessions, while the Claude app still can

- Status: Accepted
- Date: 2026-10-22
- Issue: [#491](https://github.com/guedesdiogo/kelpie/issues/491)
- Decided by the owner on 2026-10-22:
  - «Gostaria de ter como permitir fazer tudo via kelpie porém também permitir eu interagir direto no claude code, mas pelo que entendi o hook trava e fica aguardando o kelpie, é isso?»;
  - the plan: «Aprovo os três (Recomendado)», for #489, #490 and #491.
- Amends: [ADR-0057](0057-vps-claude-code-sessions.md) §1, §3 and §5, and [ADR-0035](0035-agent-computer.md)'s open question for these sessions

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

- **The hook waits beside the app.** The `PermissionRequest` hook becomes synchronous for the sessions the owner opens:
  - it writes the request to the spool: the session, a random request id, the tool, and its input, redacted and cut to 500 characters;
  - it then waits for Kelpie's verdict in a file only the runner writes.
- **What it returns:**
  - `allow` or `deny`, when Kelpie's verdict comes;
  - no decision, so nothing changes, when the session moves on (the owner answered in the app), when no verdict comes, or at its timeout.
- **It never blocks a session:** it always exits 0, and any doubt returns no decision.
- **Kelpie tells the owner** in a fixed notice ([ADR-0027](0027-fixed-texts-in-three-languages.md)) with Approve and Deny:
  - the notice names the session's title, the tool and its input, as plain text, never as a link;
  - in the webchat, Approve and Deny are buttons; on Telegram, they are [ADR-0067](0067-master-reaches-every-owner-command.md)'s buttons, or the typed code.
- **The yes is the owner's act on that notice** (ADR-0026). Master's words never approve, and nor does a session's text.
- **A verdict is bound to its request id.** It counts once, and only while that request is open.

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

**If the app's prompt waits for the hook,** the fallback goes to the owner before anything is built: the hook would wait only while the owner has asked Master to answer through Kelpie, and return at once otherwise.

### 6. What doesn't change

- **Sessions Kelpie starts** (ADR-0035 §3) and **the chat route's sessions** (ADR-0037) keep their own relay.
- **ADR-0057's notices** of a wait still come, once a minute at most.
- **Channels** stay unused.

### 7. Amendments

- **[ADR-0057](0057-vps-claude-code-sessions.md):**
  - §1: Kelpie acts on the sessions, besides observing them;
  - §3: a pending request's tool and its input leave the server too;
  - §5: Master gains `message_session` and `end_session`, and a wait's notice gains Approve and Deny.
- **[ADR-0035](0035-agent-computer.md):** its open question, about the owner answering in the Claude app while a hook waits, gets §1's answer for the sessions the owner opens: the first answer wins, once §5's check confirms it.

## Consequences

- **The owner answers a session's prompt wherever they are,** in the Claude app or through Kelpie, and sends it a message or ends it from Master.
- **A synchronous hook runs on every permission of every session** the owner opens. It is small, bounded and tested. Removing it from `settings.json` restores ADR-0057's behavior.
- **The tool's input leaves the server,** redacted and cut. It reaches Cloudflare and the model's provider when Master reads it.
- **The runner's protocol version goes up.** A runner not yet updated answers `outdated`, and the tools say so.
- **No new cost:** a verdict is one more runner call, within the Workers Paid plan.
- **The story** is a sub-issue of [#19](https://github.com/guedesdiogo/kelpie/issues/19), listed on #491. Its tests cover:
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
