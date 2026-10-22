# ADR-0057: Kelpie sees every Claude Code session on the owner's VPS, and tells the owner when one waits on him

- Status: Accepted
- Date: 2026-10-17
- Issue: [#413](https://github.com/guedesdiogo/kelpie/issues/413)
- Decided by the owner in the session of 2026-10-17; his answers are quoted on #413
- Amended by: [ADR-0059](0059-session-file-waits.md), a session file's own `waiting` also opens a wait (§2, §4)
- Amended by: [ADR-0069](0069-master-acts-on-vps-sessions.md), Master answers a session's permission prompts beside the Claude app, sends it messages through its inbox socket and ends it; a pending request's tool and input leave the server, redacted and cut (§1, §3, §5)

## Context

On 2026-10-17 the owner asked Master in the webchat: «o que esta rolando no runner? quais sessões estão em trabalho agora? Quais estão esperando algo? Quais ja finalizaram e podem ser arquivadas?» Master couldn't tell. Asked which sessions he meant, the owner chose every Claude Code session on the VPS, including the ones he opens from the Claude app.

**Today:**
- **The runner** (#294) serves only `GET /health`. It never calls Kelpie ([runner.md](../runner.md)).
- **`channel-egress`** is the only Worker that calls the runner, through a VPC Service binding ([runner.md](../runner.md), [ADR-0042](0042-runner-vpc-service-id-in-github.md)).
- **[ADR-0035](0035-agent-computer.md) §3** covers only the sessions Kelpie starts. Their hooks relay approvals and replies. The owner's own sessions are outside it.

**What the VPS offers.** The research is on #413, read on 2026-10-17.
- **Session files.** Claude Code keeps one file per running session in `~/.claude/sessions/`. The folder is documented, but its fields aren't.
  - Each file holds the session's id, its directory, a `name`, and a `status` of `busy` or `idle` with the time it last changed.
  - That day there were 45 live sessions, 3 of them busy, and none `waiting`.
- **`claude agents --json`.** The docs call it the supported way to read session state from outside. It adds a `waiting` status.
- **User-level hooks.**
  - The docs say they apply to remote sessions.
  - On the VPS, the Claude app's transcripts record the user-level `PreToolUse`, `PostToolUse`, `Stop` and `SessionStart` hooks running, by a count of their entries.
  - `Notification` would tell when a session shows a permission prompt (`permission_prompt`), asks a question (`elicitation_dialog`), or sits idle after its reply (`idle_prompt`).
  - `Stop` carries the last reply.
  - Today's user-level hooks are herdr's, `rtk`'s and ai-memory's. None listens to `Notification` or `PermissionRequest`.
- **Transcripts.** Their line format isn't documented. A pending permission looks like a long-running tool, and a transcript holds the whole conversation.
- **Archiving.** Only the Claude app archives a session. No supported path exists outside it.

**Not determined yet.** The story checks these first:
- whether a session that is already running picks up hooks added later;
- whether `Notification` (with each of its three types) and `PermissionRequest` fire in the Claude app's sessions;
- whether a session file's `name` is the title the app shows;
- how to tell what started a session: every session file seen said `entrypoint: claude-desktop`, so no terminal value has been observed;
- whether `claude agents --json` starts a background process, and whether it lists the app's sessions.

**The reference check** (#413):
- **ai-memory** spools its command hooks locally, so a server that is down never stalls a session. It also strips and sanitizes each session's last reply by default.
- **invokta** keeps hook events without their payload.
- **Hermes Agent** derives "waiting" from a pending request, and drops it once the request is gone.

## Decision

**1. Scope: every Claude Code session on the owner's VPS.**
- **Whatever started it:** the Claude app, a terminal, or Kelpie Code (ADR-0035 §2).
- **This feature only observes.** Through it, Kelpie never sends input, never answers a prompt, and never ends or archives a session.
- **Sessions Kelpie starts** are listed like any other, but raise no notice here. Their waits go through ADR-0035 §3's relay, which this ADR doesn't change.
- **The sessions behind Kelpie's own chat route** (ADR-0037) aren't listed.
- **Telling them apart:** the runner marks the sessions it starts itself, Kelpie Code's and the chat route's, by their ids. It takes a terminal from the session file's `entrypoint`, once the story has seen what a terminal session writes there.

**2. The runner knows the state from two sources.**
- **The session files** say which sessions run, and whether each is busy or idle, since when.
  - An unknown or missing field is shown as "unknown", never as an error.
  - **`claude agents --json`** replaces the files only if the story's check finds it starts no background process and lists the app's sessions, and the owner agrees.
- **Hooks in the owner's `~/.claude/settings.json`** tell when a session waits on him, and when it ends.
  - **Command hooks, not `type: "http"` ones.** They ship in `tools/runner`. An HTTP hook would need the runner's secret in every session's environment.
  - **What a hook writes:** one line to a spool only the runner reads, holding the event, its type or `SessionEnd`'s reason, the session's id and the time. No network, and no secret.
  - **Never in the way:** each hook runs asynchronously where Claude Code allows it, has a timeout of 2 seconds, and always exits 0. A hook that fails never stops a session.
  - **The events:**
    - `Notification`;
    - `PermissionRequest`;
    - `PermissionDenied`;
    - `PostToolUse`;
    - `PostToolUseFailure`;
    - `UserPromptSubmit`;
    - `Stop`;
    - `StopFailure`;
    - `SessionEnd`.

    The events past "permission, question and end" are there to close a wait (§4).
  - **The excerpt:** `Stop` also writes the last reply. The hook first redacts the whole reply (§3), then cuts it to 500 characters, dropping a trailing partial word. The owner's second answer had the hooks write only the event, the session and the time; his third answer adds this excerpt.
- **The PR link:** the owner's third answer includes it. The runner reads only the transcript's `pr-link` entries, and never its messages. It reads at most the transcript's last 1 MB, so a link written before that shows as none, and the address must be a GitHub pull request.
- **Bounds on disk:**
  - The spool and the excerpts live in a directory only the owner's user can open (`0700`), in files only it can read (`0600`).
  - The spool keeps at most 1 MB, and drops the oldest lines past that.
  - A session's excerpt is deleted when the session ends, or after 7 days.
  - A session id must be a UUID before the runner uses it in a path.
- **Installing the hooks:** the owner does it, following [runner.md](../runner.md), since the file is his settings. If running sessions don't pick them up, those sessions show only busy and idle until they restart.

**3. What leaves the server, for each session:**
- its state, with its age: working, waiting on a permission, waiting on an answer, idle since its last reply, or ended;
- its repository and branch, taken from its directory;
- what started it: the app, a terminal or Kelpie;
- its title, from the session file's `name`;
- its PR link, when there is one;
- the excerpt of its last reply.

- **The owner accepted** that the title and the excerpt, which describe his work, reach Cloudflare and the model's provider.
- **Secrets never leave.** The hook redacts the excerpt before cutting it (§2), and the runner redacts everything again before it goes out:
  - its own secret;
  - lines shaped like `NAME=value` whose name says key, token, secret or password;
  - bearer tokens;
  - well-known key formats.

  A test covers each, including a token that straddles the cut.
- **Where it stays:**
  - **Kelpie keeps no copy of its own.** Master's tool asks the runner when it runs.
  - **The tool's result** stays in that conversation's history, as every tool result does (ADR-0025). The story keeps it out of checkpoints, session pages and the vault's memory, as [ADR-0028](0028-setup-step-notes.md) does for Kelpie's notes.
  - **The notices** (§5) keep only which waits they already told: the session's id and the time the wait began.
- **Titles and excerpts are untrusted content,** like a tool's output. They confirm nothing and start no configuration command ([ADR-0013](0013-self-configuration.md)), and an address in them shows as text.

**4. A session's life.**
- **A wait opens** on `PermissionRequest`, or on a `Notification` of type `permission_prompt` or `elicitation_dialog`. A session has at most one open wait, so a `permission_prompt` that follows a `PermissionRequest` joins the same wait.
- **A wait closes** in two cases:
  - on the session's next `UserPromptSubmit`, `PermissionDenied`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `StopFailure` or `SessionEnd`;
  - when its session file turns `idle`, or `busy` again, with a change time later than the wait's opening. Whatever status the file held when the wait opened doesn't close it.

  So an answer the owner gives in the Claude app clears the wait too.
- **A session has ended** when its process is gone, or after a `SessionEnd` whose reason isn't `clear` or `resume`. Any later event from a live process brings it back.
- **Archive candidates** are sessions the owner can archive in the Claude app:
  - one that has ended;
  - one idle for 3 hours or more since its last reply.

  Kelpie shows each one's age and its PR link. Sessions a terminal started can't be archived in the app, so they show only as ended. **The owner archives** in the Claude app.

**5. When Kelpie speaks.**
- **On request:** a Master tool lists the sessions, grouped as working, waiting on the owner, idle, and could be archived.
  - Only the owner can call it, and a task's run doesn't get it ([ADR-0048](0048-master-configures-kelpie.md)).
  - It reads the sessions through a new read-only `channel-egress` entrypoint, since `channel-egress` alone calls the runner.
  - When the runner can't be reached, the tool says so.
- **Notices:** while the runner is connected, Kelpie asks it once a minute for waits that are still open and haven't been told.
  - **The notice:** one fixed notice per wait ([ADR-0027](0027-fixed-texts-in-three-languages.md)), in the owner's direct conversation with Master, on the channel Kelpie reaches him on.
  - **What it names:** the session's title and repository, and what it waits for.
  - **Untrusted text inside it:** the title and the repository show as plain text, cut to 80 characters, without line breaks or control characters, and never as a link. The notice confirms nothing.
- **No notice for a session idle after its reply** (`idle_prompt`). The owner's answer named waits on a permission or an answer from him. A notice after every finished turn would also be constant; the list shows those sessions instead.

**6. Cost.** Nothing beyond the Workers Paid plan:
- one runner call a minute, about 44,000 a month, within the plan's included requests;
- Workers VPC Services are free while in beta.

Kelpie doesn't call the runner while it isn't connected.

## Consequences

- **The owner can ask** Master what is running on the VPS, and get every session.
- **A session that stops on a permission or a question reaches the owner where he is,** within about a minute: up to 60 s of the check, plus the 6 s Claude Code waits before `permission_prompt`. This holds only if those events fire in the app's sessions, which the story checks first.
- **The owner's settings change,** for every session on the VPS.
  - The hooks are small, bounded and tested. `PostToolUse` starts a process on every tool call, so it must stay cheap.
  - Removing the hooks from `settings.json` turns waits off, and leaves busy and idle.
- **Undocumented fields can change** with a Claude Code update. The runner then shows "unknown" rather than failing, and the story's tests run on recorded session files.
- **The owner's work leaves the server:** titles and 500-character excerpts, with secrets redacted. They reach Cloudflare, the model and the conversation's raw history.
- **The runner's protocol gains a sessions endpoint, and its version goes up.** A runner not yet updated answers `outdated`, as #294 set up.
- **ADR-0035's open question** asked what happens when the owner answers in the Claude app while a hook waits.
  - For the sessions this feature watches, a wait just clears on the session's next event.
  - For the sessions Kelpie starts, the question stays open in ADR-0035.

## Alternatives considered

- **Session files only.** This needs no change to the owner's settings, but it can't tell that a session waits on him: no session was `waiting` in the research's snapshot.
- **Hooks only.** Sessions started before the hooks, or whose event was lost, stay invisible: until their next event, or until they restart if running sessions don't pick up new hooks.
- **`type: "http"` hooks to the runner.** Each session's environment would need the runner's secret. A local spool, as ai-memory does, avoids it.
- **The runner calling Kelpie.** It doesn't today, and this design needs no outbound connection: Kelpie polls.
- **Reading transcripts.** Their format is undocumented, they can't tell a pending permission from a long tool, and they hold the whole conversation.
- **The app's local socket and files.** They are undocumented and private to the app, and could change with any update.
- **ai-memory's database.** It has no waiting state, and covers only allowlisted projects.
- **No title, or no excerpt.** The owner chose the excerpt, because it says what each session was doing.
- **Kelpie ending finished sessions' processes.** The owner chose to only list them. Ending one wouldn't archive it in the app anyway.
- **A notice for every idle session.** It would come after every finished turn, and the owner asked about waits on him.

## References

- [#413](https://github.com/guedesdiogo/kelpie/issues/413): the research, the reference check and the owner's answers
- Claude Code docs: [hooks](https://code.claude.com/docs/en/hooks), [desktop](https://code.claude.com/docs/en/desktop)
- [ADR-0013](0013-self-configuration.md), [ADR-0025](0025-turn-tool-loop.md), [ADR-0027](0027-fixed-texts-in-three-languages.md), [ADR-0028](0028-setup-step-notes.md), [ADR-0035](0035-agent-computer.md), [ADR-0037](0037-conversations-through-claude-code.md), [ADR-0042](0042-runner-vpc-service-id-in-github.md), [ADR-0048](0048-master-configures-kelpie.md)
- [runner.md](../runner.md)
