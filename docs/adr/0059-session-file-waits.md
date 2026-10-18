# ADR-0059: A session file's own "waiting" also opens a wait, beside the hooks

- Status: Accepted
- Date: 2026-10-17
- Issue: [#416](https://github.com/guedesdiogo/kelpie/issues/416)
- Decided by the owner in the session of 2026-10-17; his answer is quoted on #416
- Amends: [ADR-0057](0057-vps-claude-code-sessions.md) §2 (the excerpt's cut) and §4 (waits and endings)

## Context

[ADR-0057](0057-vps-claude-code-sessions.md) has the runner know which Claude Code sessions on the owner's VPS wait on him from his hooks only.
- The session files Claude Code keeps in `~/.claude/sessions/` said only `busy` or `idle`. The research of 2026-10-17 saw no `waiting` in them.
- So a wait needed the hooks in the owner's `settings.json`. A session started before them, or one whose event was lost, never showed as waiting.

**Part A of #416 (#433) found otherwise the same evening.** Claude Code now writes a wait into the session's file: `status: "waiting"`, with `waitingFor` set to `"permission prompt"` or `"input needed"`. Of 39 live sessions, 2 had it, both started by the Claude app. The other 37 were 3 `busy` and 34 `idle`.

## Decision

**1. A session file's `waiting` also opens a wait.**
- **When it opens:** at the file's `statusUpdatedAt`.
- **Its kind:**
  - `"permission prompt"` is a wait on a permission;
  - `"input needed"` is a wait on an answer;
  - any other value, or none, is a wait on an answer too.
- **What leaves the server:** only that kind. Never `waitingFor`'s own text, which is Claude Code's free text.
- **When it closes:** once the file no longer says `waiting`, or on any event that closes a wait under ADR-0057 §4.

**2. One wait per session, whichever source saw it.**
- A file wait and a hook wait are the same wait when they open within 60 seconds of each other. It keeps the earliest opening time.
- **Further apart, they are two waits, and the later one wins,** whichever source saw it. The older wait is dropped as stale. So a lost closing event can't hide the next prompt, whose notice would otherwise never go out.
- **Its kind comes from the hook when there is one,** since a hook names the tool. `AskUserQuestion` makes it a question.
- **The notices of ADR-0057 §5** tell each wait once, by its session and opening time, whichever source opened it.

**3. The hooks stay.** They still bring what the file doesn't: the excerpt of the last reply, the endings and their reasons, and the closing events.

**4. A live session that started after its last `SessionEnd` hasn't ended.** A file whose process is alive, and whose `startedAt` comes after that event, means the session was started again, as after a reboot. ADR-0057 §4 had only a later hook event bring an ended session back. Its excerpt, deleted at that end, comes back with its next reply.

**5. The hook keeps a longer excerpt, and the runner cuts it.** The hook redacts the last reply and keeps up to 1,000 characters on disk. The runner then redacts again, including its own secret by value, and cuts to 500 before anything leaves. A hook can't read that secret, so cutting first could leave a prefix of a secret that isn't hex. ADR-0057 §2 had the hook cut to 500.

## Consequences

- **Waits work before the owner installs the hooks,** and when a hook event is lost. A session that started before the hooks shows its waits too.
- **The file's field is undocumented, like the rest of the file** (ADR-0057, Consequences). If Claude Code stops writing it, the hooks still open waits.
- **"Input needed" is read as a wait on an answer.** A finished turn shows as `idle` in the same file, so this doesn't bring back the notice after every turn that ADR-0057 §5 avoided.

## Alternatives considered

- **The file only, with no hooks.** This needs no change to the owner's settings. But it loses the last reply's excerpt, which the owner chose to have (ADR-0057 §3), unless it is read from the transcript, which ADR-0057 avoided.
- **The hooks only, as ADR-0057 had it.** The file's status would travel beside each session as information only. Then a session without hooks never shows as waiting.

## References

- [#416](https://github.com/guedesdiogo/kelpie/issues/416): the owner's answer, part A's finding, and the spike's results
- [#433](https://github.com/guedesdiogo/kelpie/issues/433): part A, which implements this
- [ADR-0057](0057-vps-claude-code-sessions.md)
