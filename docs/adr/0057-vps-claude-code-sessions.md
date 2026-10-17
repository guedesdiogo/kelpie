# ADR-0057: Kelpie sees every Claude Code session on the owner's VPS, and tells the owner when one waits on him

- Status: Accepted
- Date: 2026-10-17
- Issue: [#413](https://github.com/guedesdiogo/kelpie/issues/413)
- Decided by the owner in the session of 2026-10-17; his answers are quoted on #413

## Context

On 2026-10-17 the owner asked Master in the webchat: «o que esta rolando no runner? quais sessões estão em trabalho agora? Quais estão esperando algo? Quais ja finalizaram e podem ser arquivadas?» Master couldn't tell. Asked which sessions he meant, the owner chose every Claude Code session on the VPS, including the ones he opens from the Claude app.

**Today:**
- **The runner** (#294, [runner.md](../runner.md)) serves only `GET /health`. It never calls Kelpie.
- **`channel-egress`** is the only Worker that calls the runner, through a fetch-only VPC Service ([ADR-0042](0042-runner-vpc-service-id-in-github.md)).
- **[ADR-0035](0035-agent-computer.md) §3 covers only the sessions Kelpie starts.** Their hooks relay approvals and replies. The owner's own sessions are outside it.

**What the VPS offers.** The research is on #413, read on 2026-10-17.
- **Session files:** Claude Code keeps one file per running session in `~/.claude/sessions/`. The folder is documented; its fields aren't. Each file holds the session's id, its directory, its title and a `status` of `busy` or `idle`, with the time it last changed. That day there were 45 live sessions, 3 of them busy.
- **`claude agents --json`** is documented as the supported way to read session state from outside. It adds a `waiting` status. It wasn't run, so two things are unknown: whether it starts a background process, and whether it lists the app's sessions.
- **User-level hooks reach the app's sessions too.** The docs say so for remote sessions, and the VPS confirms it.
  - `Notification` tells when a session shows a permission prompt (`permission_prompt`), asks a question (`elicitation_dialog`), or sits idle after its reply (`idle_prompt`).
  - `Stop` carries the session's last reply, and `SessionEnd` tells when a session ends.
  - Today's user-level hooks are herdr's, `rtk`'s and ai-memory's. None listens to `Notification` or `PermissionRequest`.
- **Transcripts:**
  - their line format isn't documented;
  - a pending permission looks like a long-running tool;
  - they hold the whole conversation.
- **Archiving:** only the Claude app archives a session. No supported path exists outside it.

**The reference check** (#413):
- **ai-memory** spools its command hooks locally, so a server that is down never stalls a session. It also strips each session's last reply by default.
- **invokta** keeps hook events without their payload.
- **Hermes Agent** derives "waiting" from a pending request, and drops it once the request is gone.

## Decision

**1. Scope: every Claude Code session on the owner's VPS, read only.**
- **Whatever started it:** the Claude app, a terminal, or Kelpie itself.
- **Kelpie only observes.** It never sends input to these sessions, never answers their prompts, and never ends or archives them.
- **ADR-0035 §3 is unchanged.** It stays the path for the sessions Kelpie starts, and it covers relaying approvals and replies.

**2. The runner knows the state from two sources.**
- **The session files** say which sessions run, and whether each is busy or idle, since when.
  - A file whose process is gone is an ended session.
  - An unknown or missing field is shown as "unknown", never as an error.
- **Hooks in the owner's `~/.claude/settings.json`** say when a session waits on him, and when it ends.
  - **What they are:** command hooks shipped in `tools/runner`, not `type: "http"` ones. HTTP hooks would put the runner's secret in every session's environment.
  - **What they record:** each appends one line to a spool only the runner reads. The line holds the event, its notification type, the session's id and the time.
  - **The events:**
    - `Notification`;
    - `PermissionRequest`;
    - `PostToolUse`;
    - `UserPromptSubmit`;
    - `Stop`;
    - `StopFailure`;
    - `SessionEnd`.
  - **When a wait ends:** the session's next `UserPromptSubmit`, `PostToolUse`, `Stop` or `SessionEnd` ends it. So an answer the owner gives in the Claude app clears the wait too.
  - **Never in the way:** a hook doesn't wait on the network, always exits 0, and never blocks or slows a session for more than a line's write.
  - **The excerpt:** from `Stop`, the hook keeps the last reply cut to 500 characters. Only the latest one per session is kept, in a file only the owner's user can read.
  - **Installing them:** the owner does it, following [runner.md](../runner.md). The file is his settings. A session started before the hooks shows only busy or idle until its next event.
- **The PR link:** the runner reads only the transcript's `pr-link` entries, never its messages.
- **`claude agents --json`:** the story checks it. If it starts no background process and lists the app's sessions, it replaces reading the session files, because it is documented.

**3. What leaves the server, for each session:**
- its state, with its age. The states are working, waiting on a permission, waiting on an answer, idle since its last reply, and ended;
- its repository and branch, taken from its directory;
- the title the Claude app shows;
- the PR link, when there is one;
- the excerpt of its last reply.

The owner accepted that the title and the excerpt, which describe his work, reach Cloudflare and the model's provider.

- **Kelpie stores none of it.** Master's tool asks the runner when it runs. The notices (§5) keep only which waits they already told: the session's id and the event's time.
- **Titles and excerpts are untrusted content,** as a tool's output is. They confirm nothing and start no configuration command ([ADR-0013](0013-self-configuration.md)), and an address in them shows as text.

**4. Archiving: Kelpie lists the candidates.**
- **A candidate** is a session that ended, or one idle for 3 hours or more since its last reply.
- **Kelpie shows** each candidate's age, and its PR link when there is one.
- **The owner archives** in the Claude app.

**5. When Kelpie speaks.**
- **On request:** a Master tool lists the sessions, grouped as working, waiting on the owner, idle, and could be archived.
  - It reads them through a new read-only `channel-egress` entrypoint, because `channel-egress` alone holds the runner's binding (ADR-0042).
  - When the runner can't be reached, the tool says so.
- **Notices:** while the runner is connected, Kelpie asks it once a minute for waits it hasn't told.
  - **What raises one:** a session that starts waiting on a permission or on a question (`permission_prompt`, `elicitation_dialog` or `PermissionRequest`).
  - **What it is:** one fixed notice ([ADR-0027](0027-fixed-texts-in-three-languages.md)) in the owner's direct conversation with Master, on the channel Kelpie reaches him on. It names the session's title, its repository, and what it waits for.
  - **How often:** one notice per wait.
- **No notice for a session idle after its reply** (`idle_prompt`). Every finished turn would raise one; the list shows it instead.

**6. Cost.** Nothing beyond the Workers Paid plan:
- one runner call a minute, about 44,000 a month, among the plan's included requests;
- Workers VPC Services are free while in beta.

The check doesn't run while the runner isn't connected.

## Consequences

- **What the owner gets:** asked "what is running?", Master answers for every session on the VPS. A session that stops on a permission or a question reaches the owner where he is, within about a minute: up to 60 s of the check, plus the 6 s Claude Code waits before `permission_prompt`.
- **The owner's settings change,** for every session on the VPS. The hooks are kept small and are checked by tests. Removing them from `settings.json` turns waits off, and leaves busy and idle.
- **Undocumented fields can change** with a Claude Code update. The runner then shows "unknown" rather than failing. The story's tests run on recorded session files, and §2's check of `claude agents --json` may move to the documented path.
- **The owner's work content leaves the server:** titles and 500-character excerpts. They reach Cloudflare and the model, when Master lists them.
- **The runner's protocol gains a sessions endpoint,** and its version goes up. A runner not yet updated answers `outdated`, as #294 set up.
- **ADR-0035's open question** was what happens when the owner answers in the Claude app while a hook waits. For these sessions it doesn't arise: a wait clears on the session's next event, whoever answered it.

## Alternatives considered

- **Session files only:** no change to the owner's settings, but no way to tell that a session waits on him. The app's sessions never wrote a `waiting` status.
- **Hooks only:** sessions started before the hooks, or whose event was lost, stay invisible until their next event.
- **`type: "http"` hooks to the runner:** each session's environment would need the runner's secret. A local spool, as ai-memory does, avoids it.
- **The runner calling Kelpie:** it never does ([runner.md](../runner.md)), and its VPC Service carries calls one way (ADR-0042); Kelpie polls.
- **Reading transcripts:** an undocumented format, which can't tell a pending permission from a long tool, and holds the whole conversation.
- **The app's local socket and files:** undocumented, and private to the app.
- **ai-memory's database:** it has no waiting state, and covers only allowlisted projects.
- **No title, or no excerpt:** the owner chose the excerpt.
- **Kelpie ending finished sessions' processes:** the owner chose to only list them.
- **A notice for every idle session:** one after every finished turn.

## References

- [#413](https://github.com/guedesdiogo/kelpie/issues/413): the research, the reference check and the owner's answers
- Claude Code docs: [hooks](https://code.claude.com/docs/en/hooks), [desktop](https://code.claude.com/docs/en/desktop)
- [ADR-0013](0013-self-configuration.md), [ADR-0027](0027-fixed-texts-in-three-languages.md), [ADR-0035](0035-agent-computer.md), [ADR-0042](0042-runner-vpc-service-id-in-github.md), [ADR-0048](0048-master-configures-kelpie.md)
- [runner.md](../runner.md)
