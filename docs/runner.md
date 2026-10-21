# The runner

The runner is the process on the owner's VPS that Kelpie's Workers call to use that machine ([ADR-0035](adr/0035-agent-computer.md)). Its code is in `tools/runner`. It runs with Bun, from a checkout of this repository, with only its own dependencies installed: the Claude Agent SDK and the MCP SDK, both pinned.

- **It listens on `127.0.0.1` only.** The server opens no port: Workers reach it through a Cloudflare Tunnel and a Workers VPC Service.
- **Every request needs its secret**, as `Authorization: Bearer <secret>`. Without it the runner answers 401, on any path.
- **It never calls Kelpie.** Its answers go back on the requests `channel-egress` makes (#294).
- **What it serves:**
  - `GET /health`, which answers its version and protocol version:

    ```json
    { "ok": true, "version": "0.3.0", "protocol": 3 }
    ```

  - the `claude-code` route's sessions (ADR-0037 §2, #295), described below:
    - `POST /sessions/:id/turns` runs a turn and streams its frames as NDJSON;
    - `POST /sessions/:id/tool-results` answers a tool call the turn asked for;
    - `DELETE /sessions/:id` closes a session.
  - every other Claude Code session on the server, read only (ADR-0057, #433), described in "The server's Claude Code sessions" below:
    - `GET /sessions` lists them;
    - `GET /sessions/waits?since=<epoch ms>` lists the waits on the owner opened since then and still open.

## Claude Code sessions

The `claude-code` route reaches Claude through the runner ([ADR-0037](adr/0037-conversations-through-claude-code.md)). Each conversation has one live session: one `query()` of the Agent SDK, fed by streaming input.

- **Who calls these routes:** `llm-gateway`'s `claude-code` provider, through `channel-egress`'s `RunnerChat` entrypoint, and only while the owner has the route on ("Using the route", below).
  - A turn that follows its session's last one sends only its new messages. Any other turn starts a new session, seeded with the conversation so far: one marked transcript, one JSON line per message, its checkpoint and core included.
  - On `409` (`lost`, `unfinished` or `mismatched`), the provider starts a new session, once, with a new id.
  - It reads the runner's own `429` and `503`, an unreachable or refused runner, and a call cut on the way, as when `channel-egress` is redeployed, as a route that can't serve now, never as a Claude usage limit or login: those come only as `error` frames. Kelpie then falls back to the tier's next route, with a notice.
  - It skips `ping` frames, and fails a turn whose line passes 4 MiB, or whose reply passes 1 MiB, more than a history row holds.
  - It gives a turn the agent's tool bound plus 10 minutes. Every call to the runner races that deadline, and the turn is cancelled when it passes, as is one whose start comes after it.

- **Its id is Kelpie's,** a lowercase UUID. A new session takes it, and a resumed one goes on from it: live, or from its transcript after a restart or an idle close.
- **A turn's frames** are `text`, `round` (a reply whose tool calls Claude Code runs, with its usage), `tool_call` (a call to run now), `finish` and `error`. Each maps onto one of Kelpie's model events, or onto its error. Their shapes are in `packages/channels/src/runner.ts`.
  - A reply that didn't stream, as after Claude Code fell back from a failed stream, goes out the same way.
  - A `ping` frame opens every turn's stream, so its headers go out at once: Bun sends them with the first chunk, and Claude Code's first reply can take longer than `channel-egress` waits for a turn to start.
  - A `ping` frame also follows each 20 seconds the stream stays silent, as while Kelpie runs a tool, so the connections on the way stay open. It maps onto no event. Bun's idle timeout is lifted for a turn's stream only.
- **Kelpie's tools** are an in-process MCP server, `kelpie`. A tool call goes out as a `tool_call` frame, and its result comes back on `/tool-results`. Without a result within the agent's tool bound plus 2 minutes, the turn fails.
- **Isolation, on every call:** no built-in tool, no settings file or `CLAUDE.md`, no MCP server but Kelpie's, and no claude.ai connector. Kelpie's system prompt replaces Claude Code's, and a message's text goes as written, so `@path` and slash commands do nothing. `canUseTool` lets only Kelpie's own tools run.
  - **Checked on each turn:** when Claude Code's `init` lists a tool other than Kelpie's, an MCP server other than its own, or a credential other than the login (`apiKeySource` other than `none`), the turn fails, the runner logs why, and the session closes as unfinished.
- **The environment:** Claude Code's process gets only `HOME`, `PATH`, `LANG` and `TMPDIR` from the runner's, plus Kelpie's client name and the switches that turn off its compaction and its memory. So `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_CUSTOM_HEADERS` never reach it, and it uses the server's own login.
- **Failures** come from Claude Code's structured signals: a usage limit (with its reset), spent usage, a billing error (unverified), a failed login or an account that may not use Claude Code, or any other error. Each is a retryable `error` frame with a fixed message. What Claude Code writes on stderr goes to the runner's journal only, on one line and cut at 2,000 characters.
- **Closing:** a session closes after 15 minutes without a turn, when its conversation starts a new one, on `DELETE`, or when a turn fails or its stream is dropped. A session whose turn didn't finish is never resumed: the runner remembers its id, and deletes its transcript once its process has exited.
- **A process must begin with its `init`:** a reply, a stream event or a result before it fails the turn, and the session closes as unfinished. Other messages before the `init` pass, unread.
- **Limits:** at most 4 sessions are live, and the runner starts at most 30 turns a minute.
  - A closed session's process counts until it exits. A new session past 4 closes the one idle the longest, which stays resumable, so at most 5 processes run. When no session can make room, because every live one runs a turn or a closed one hasn't exited yet, the new one answers 503 with `reason: "full"`.
  - Until a closed session's process has exited, a turn on its id answers 409 `unfinished`: the process may still write the transcript.
  - A process that hasn't exited 30 seconds after its session closed stops counting, and the runner logs it. Its id is never resumed, and its transcript stays until the process exits.
  - A turn counts toward the minute's when it is admitted, so a burst can't go past 30. A turn the runner then refuses gives its place back. Past 30, a turn answers 429 with `reason: "rate"`, and `Retry-After` in seconds.
- **409:** a turn answers 409 with a `reason` when its session is `lost` (neither live nor on disk), `unfinished` (a turn still runs, or the last one failed) or `mismatched` (another conversation, prompt, model, tools or tool bound, or a new session's id already taken). Kelpie then starts a new session.
- **Transcripts:** Claude Code keeps them under `~/.claude/projects/`, in the folder for the work folder (`KELPIE_RUNNER_WORK_DIR`).

## The server's Claude Code sessions

The runner tells Kelpie what every Claude Code session on the server is doing: the owner's, from the Claude app or a terminal, and Kelpie Code's once it exists ([ADR-0057](adr/0057-vps-claude-code-sessions.md)). It only reads: it never sends a session input, answers its prompts, or ends or archives it.

- **Two sources:**
  - **The session files** Claude Code keeps in `~/.claude/sessions/`, one per running session: its id, its folder, its title (`name`), its `status` and when that changed, when it started, what started it (`entrypoint`), and its process, checked with signal 0. Their fields aren't documented: a field that is missing, or holds a value the runner doesn't know, reads as unknown, never as an error.
  - **The session-event hook,** which the owner installs in `~/.claude/settings.json` (below). It writes one line per event to a spool only the runner reads, and the last reply's excerpt.
- **Left out:** the `claude-code` route's own sessions, those in the runner's work folder (`KELPIE_RUNNER_WORK_DIR`), compared by real path and by name, or whose id the runner holds.
- **Each session's state,** with the time it began (ADR-0057 §4, and ADR-0059 for the session file's own waits):
  - `waiting_permission` or `waiting_answer`: a wait is open. A session has one at most, opened by a hook or by its session file:
    - **a hook's wait** opens on `PermissionRequest`, or on a `Notification` of type `permission_prompt` or `elicitation_dialog`. A prompt within 60 s of an open wait joins it, as the `permission_prompt` that follows a request by 6 s; a later one is the next prompt, and replaces it, so a lost close can't hide it. `AskUserQuestion`'s request and an elicitation are questions; anything else is a permission. It closes on the session's next `UserPromptSubmit`, `PermissionDenied`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `StopFailure` or `SessionEnd`, or when its session file turns `idle`, or `busy` again, after the wait opened. So an answer in the Claude app clears it too;
    - **a file's wait** opens while the session file says `status: "waiting"`, at its `statusUpdatedAt`; a file that doesn't say since when opens none. Its kind comes from `waitingFor`: `permission prompt` is a permission, `input needed` a question, and anything else, or nothing, a wait of unknown kind, shown as waiting on an answer. Only that kind is kept, never Claude Code's text. It closes when the file no longer says `waiting`, or is gone, or on one of the hook events above after it opened;
    - **the two are one wait** when both are open within 60 s of each other, as when the same prompt fires the hooks and changes the file: it opened at the earlier time, and has the hook's kind, which says more. So `/sessions/waits` gives each wait one session id and one opening time, and a notice tells it once;
    - **further apart,** the later one is the next prompt, and the earlier is stale and dropped, as when a hook's close was lost: a file that says `waiting` again 90 s after a hook's wait opened is a new wait.
  - `ended`: its process is gone, or a `SessionEnd` whose reason isn't `clear` or `resume` came, and no event since. A running process whose session file started after that end took the session up again, as the app does after a reboot: the end is stale, and the session's excerpt stays.
  - otherwise, its session file's `status`: `working` for `busy`, `idle` for `idle`. The list shows the file's own status beside the state.
  - **Archive candidates** (`archivable`): the app's sessions that ended, or have been idle for 3 hours or more. Only the app archives a session, so a terminal's shows only as ended.
- **Each session's details:** its repository (the main checkout's folder name) and branch, read from git's own files in its folder, never by running git; what started it (`app` for `claude-desktop`, `terminal` for `cli`, else `unknown`); its title; its last GitHub pull request link, from its transcript's last 1 MiB, of which only the `pr-link` entries are read; and the excerpt of its last reply. A transcript not where its folder's name says is found in an index of the project folders, built once per list. The title, the repository and the branch go on one line: each break becomes a space, and what shows nothing (Unicode's default-ignorable characters: bidi controls, zero-width spaces and joiners, the BOM, fillers, tag characters; and the Braille blank) is removed, from the excerpt too. `channel-egress` refuses an answer whose one-line field still holds either.
- **Secrets never leave.** The hook redacts the reply's first 16 KiB before it cuts it to 1,000 characters, and the runner redacts every text again on the way out, at most 4,096 characters of each, its own secret by value first, before it cuts the excerpt to 500. What shows nothing is removed first, in the hook and in the runner, so it can't split a key that would then pass redaction and show rejoined. Every pattern runs in linear time, so a hostile reply of any size costs milliseconds. So a secret only the runner knows, as a passphrase, is whole when it is redacted, even where it straddles the 500th character. What goes:
  - the value of a name that says key, token, secret, pass, pwd, credential, auth, cookie, dsn or signature, as `Authorization` and `Proxy-Authorization` do: `NAME=value`, a flag's `--name=value` or `--name value`, a YAML or header line's `name: value`, with or without the space after the colon, keeping a header's scheme (`Basic`, `Bearer`, `Digest`, `Token`, `Negotiate`) in front, a quoted `"name": value`, and a header within a quoted command. A YAML name with nothing after its colon, or only a block indicator (`|`, `>-`, `|2+` and the like), has its value on the lines below, each 1 to 8 spaces more indented than the name's, 20 at most: after a block indicator they all go, and after nothing they go up to one that is a nested mapping's `key: value` or a list's `- item`, so `auth:` over a more-indented `method: basic` stays. Not the counts `tokens` names, `author`, `authority`, `authors`, `authorized` and `authorize`, `passed`, `passing` and `passes`, a flag such as `--passWithNoTests`, a line `pass:` or `auth:` whose value is a status (`ok`, `yes`, `no`, `true`, `false`, `on`, `off`, `passed`, `failed`, `green`, `red`, `n/a`, `all green`) or a count, as `458/458` or a bare number of at most three digits, since a longer one may be a PIN, the shell's `PWD` and `OLDPWD`, a quoted `null`, `true`, `false` or number of at most three digits, maybe signed and with up to three decimals, since a longer one may be a PIN, nor a line that only says a type, maybe an array's or optional, as `token: string;`, `token: string | null;` or `token: string[];`, though a value that only starts with one, as `token: any-secret`, goes, or names nothing after its colon;
  - a URL's password (`scheme://user:password@`, the user maybe empty, as `redis://:password@`), curl's `-u user:password`, a Slack webhook's path, and bearer and basic tokens that look like one: a digit, a symbol, or a capital past the first letter, so `Bearer authentication` stays;
  - keys of a known format (`sk-`, `ghp_`, `gho_`, `github_pat_`, AWS's `AKIA` and `ASIA`) and PEM blocks;
  - runs of 32 or more hex digits, but a commit's 40 lowercase ones right after a whole word that says so, with only separators between (spaces, `:`, `=`, `#`, `-`, `/`), as `commit `, `merged `, `sha: `, `HEAD = ` or `/commit/`. Not after `header` or `review`, nor after `sha1 secret: `;
  - runs of 32 or more base64 characters, `/` and `+` included, that mix cases and digits, as AWS's secret keys and `openssl rand -base64`, unless they read as a path: two or more of their `/`-separated pieces are a word of four letters or more, maybe capitalized, maybe numbered. Of 30,000 random keys of each shape, about 0.13% of 40-character keys, 0.06% of 44-character ones, and none of 88 pass whole, nearly all for want of a digit or a case.

  A PR link the redaction would change isn't shown.
- **Bounds:** at most 200 sessions or waits per answer, 512 KiB for the list and 64 KiB for the waits. Past those, the runner drops excerpts, then titles, PR links, branches and repositories, from the least recent session up, then sessions, and says `truncated`. It reads at most 1,000 session files, and a transcript's last 1 MiB.
- **The spool,** in `~/.local/state/kelpie-runner/session-events/`:
  - a directory only the runner's user may open (`0700`), with files only it may read (`0600`). The runner ignores, and logs once, a spool directory others may open;
  - `events.ndjson`, one line per event: its name, a notification's type or a `SessionEnd`'s reason, the session's id, whether a permission request is `AskUserQuestion`'s, and the time. Never a prompt, a tool's input or output, or a path. At 512 KiB it becomes `events.1.ndjson`, replacing the older one, so the spool keeps at most 1 MiB;
  - `excerpt-<session id>.json`, each session's last reply, redacted and cut to 1,000 characters at a word. It is deleted when its session ends, when its session file is gone, or after 7 days. A file the runner can't delete is logged once, and never stops an answer;
  - a session id is checked as a UUID before it names a file.
- **Who calls these routes:** `channel-egress`'s read-only `RunnerSessions` entrypoint, with its calls `list()` and `waits(since)`, which only `conversation-runtime` binds, for Master's tool and the notices below.

### How you see them

- **Ask Master** what is running on the VPS: its `vps_sessions` tool lists the sessions, grouped as waiting on you, working, idle, could be archived and ended, each with its age, title, repository and branch, pull request and the excerpt of its last reply. Only you can ask, in your own conversation with Master; a task's run never gets the tool. Archive a session in the Claude app: Kelpie can't (`docs/admin-api.md`, "The VPS's Claude Code sessions").
- **A notice when a session waits on you.** Within about a minute of a session asking for your permission or an answer, Kelpie sends you one fixed message on Telegram, or in the webchat while it is open, naming the session's title and repository and what it waits for. Answer it where the session runs, in the Claude app or its terminal: the notice confirms nothing, and Kelpie never answers for you. A session idle after its reply, or ended, gets no notice.
  - **The title and repository leave the server with it,** to your channel: on Telegram they pass through Telegram's servers, stay in the chat, and can show on your phone's lock screen.
  - **Waits already open are told too,** up to a day old, the first time Kelpie reads the runner's waits, as once the runner is connected or updated.
  - The waits come from the session files without the hook, and from the hook once you install it (below), which also catches a prompt the file doesn't show.
  - Kelpie checks once a minute while the runner is connected, from Master's next turn on. It stops while the runner isn't connected, and, after three answers that the runner is outdated, for an hour at least: a runner below protocol 3 lists no sessions, so update it ("Operating it").

### Installing the session-event hook

The hook is `tools/runner/hooks/session-event.ts`, run with Bun from the runner's checkout. It reads the event from its input, writes the spool, and always exits 0, within 1.5 seconds even when its input never ends: Claude Code doesn't time out a hook that runs in the background. It never uses the network, and holds no secret. It takes about 25 ms and 26 MB per event, on every tool call, since `PostToolUse` is one of its events.

Running sessions pick up an edit to `settings.json` without a restart (#416). On the server, as the runner's user, with the runner's checkout in `~/Repos/kelpie` and `jq` installed:

```bash
f=$(readlink -f ~/.claude/settings.json)
if [ -z "$f" ] || [ ! -f "$f" ]; then
  echo "settings.json unchanged: ~/.claude/settings.json doesn't lead to a file"
else
  [ -e "$f.bak" ] || cp -p "$f" "$f.bak"
  hook='{"type":"command","command":"cd \"$HOME/Repos/kelpie/tools/runner\" && exec \"$HOME/.bun/bin/bun\" --no-env-file --config=hooks/bunfig.toml hooks/session-event.ts","async":true,"timeout":2}'
  if cp -p "$f" "$f.new" && jq --argjson hook "$hook" '
  def ours: any((.hooks // [])[]; (.command // "") | tostring
    | contains("kelpie/tools/runner") and contains("hooks/session-event.ts"));
  reduce ("Notification", "PermissionRequest", "PermissionDenied", "PostToolUse",
          "PostToolUseFailure", "UserPromptSubmit", "Stop", "StopFailure", "SessionEnd") as $event
    (.; .hooks = (.hooks // {})
      | .hooks[$event] = (((.hooks[$event] // []) | map(select(ours | not))) + [{ hooks: [$hook] }]))
  ' "$f" > "$f.new" && jq -e . "$f.new" > /dev/null; then
    mv "$f.new" "$f"
  else
    rm -f "$f.new"
    echo "settings.json unchanged"
  fi
fi
```

- **It keeps the file safe:** it follows `settings.json` to the real file when it is a symlink, so the link stays. It backs that file up to `settings.json.bak` unless a backup is already there, writes the result beside it with the same mode, checks that it is JSON, and only then moves it over. A `settings.json` that isn't JSON, or a link that leads to no file, stays as it was, and the command says `settings.json unchanged`.
- **It adds one group per event,** beside the hooks already there, and replaces its own on a second run: any hook whose command names `kelpie/tools/runner` and `hooks/session-event.ts`.
- **The command moves to the runner's checkout first.** Claude Code runs a hook from the session's folder, and Bun would load that folder's `bunfig.toml`, its `preload` included, and its `.env`: a repository could then run code as you on its first event. So the hook runs from `~/Repos/kelpie/tools/runner`, with the empty `hooks/bunfig.toml` as its settings and no `.env`. Claude Code runs the command through `sh`, which expands `$HOME`.

Each event gets this entry:

```json
{
  "hooks": {
    "Notification": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "cd \"$HOME/Repos/kelpie/tools/runner\" && exec \"$HOME/.bun/bin/bun\" --no-env-file --config=hooks/bunfig.toml hooks/session-event.ts",
            "async": true,
            "timeout": 2
          }
        ]
      }
    ]
  }
}
```

The same goes under `PermissionRequest`, `PermissionDenied`, `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, `Stop`, `StopFailure` and `SessionEnd`. Updating the runner's checkout updates the hook too. The runner's tests run both snippets on made-up settings (`tools/runner/test/docs.test.ts`).

**Removing it** turns the hooks' waits, the endings it reports and the excerpts off. The list still shows each session's busy or idle state, and the waits its session file says. It leaves every other hook as it was, with the same care:

```bash
f=$(readlink -f ~/.claude/settings.json)
if [ -z "$f" ] || [ ! -f "$f" ]; then
  echo "settings.json unchanged: ~/.claude/settings.json doesn't lead to a file"
else
  [ -e "$f.bak" ] || cp -p "$f" "$f.bak"
  if cp -p "$f" "$f.new" && jq '
  def ours: (.command // "") | tostring
    | contains("kelpie/tools/runner") and contains("hooks/session-event.ts");
  def mine: any((.hooks // [])[]; ours);
  . as $before
  | if (.hooks | type) != "object" then . else
      reduce (.hooks | keys[]) as $event (.;
        if (.hooks[$event] | type) == "array" and any(.hooks[$event][]; mine) then
          .hooks[$event] |= map(if mine then (.hooks |= map(select(ours | not))) | select(.hooks != []) else . end)
          | if .hooks[$event] == [] then del(.hooks[$event]) else . end
        else . end)
      | if .hooks == {} and $before.hooks != {} then del(.hooks) else . end
    end
  ' "$f" > "$f.new" && jq -e . "$f.new" > /dev/null; then
    mv "$f.new" "$f"
    rm -rf ~/.local/state/kelpie-runner/session-events
  else
    rm -f "$f.new"
    echo "settings.json unchanged"
  fi
fi
```

## Setting it up

On the VPS, as the user whose claude.ai login Claude Code uses:

1. **Install Bun,** clone this repository into `~/Repos/kelpie`, where the service and the hook's command expect it, and install the runner's dependencies only. `--production` leaves out the test tools, and `--frozen-lockfile` installs exactly the versions in `bun.lock`:

   ```bash
   curl -fsSL https://bun.sh/install | bash
   git clone https://github.com/guedesdiogo/kelpie.git ~/Repos/kelpie
   cd ~/Repos/kelpie && bun install --production --frozen-lockfile --filter @kelpie/runner
   ```

   This user must be logged in to Claude Code with the claude.ai account that the `claude-code` route uses (ADR-0037 §5): the Agent SDK's Claude Code reads that login from `~/.claude`.

2. **Create the secret.** It is 32 random bytes, in a file only this user can read. The runner refuses to start on a file others can read, or without a secret.

   ```bash
   install -d -m 700 ~/.config/kelpie-runner
   (umask 077; openssl rand -hex 32 > ~/.config/kelpie-runner/secret)
   ```

   It must be a regular file of this user, not a symlink.

3. **Install the service.** It restarts on failure, but not on a setting to fix (exit 78). It sets `NoNewPrivileges`, which every process the runner starts inherits, and `NODE_ENV=production`, so an error never answers with Bun's page of source.

   It also bounds what the runner and its Claude Code sessions may use. A session's process takes up to about 420 MB (53 `claude` processes measured on the VPS: median 259 MB, max 419 MB) and about 20 threads. The bounds cover 4 sessions, one more closing, and the runner, about 2.2 GB:
   - past `MemoryHigh=2560M` the kernel reclaims the service's memory;
   - at `MemoryMax=3G` its OOM killer kills one process, most likely a session's. `OOMPolicy=continue` keeps the runner up, and that session's turn fails. systemd's default policy, `stop`, would stop the whole runner;
   - `TasksMax=256` caps their threads.

   ```bash
   mkdir -p ~/.config/systemd/user
   cp ~/Repos/kelpie/tools/runner/kelpie-runner.service ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now kelpie-runner
   sudo loginctl enable-linger "$USER"
   ```

   Lingering keeps user services running when nobody is logged in.

4. **Check it** on the server. The header goes through standard input, so the secret never shows in the process list:

   ```bash
   printf 'Authorization: Bearer %s' "$(cat ~/.config/kelpie-runner/secret)" | curl -s -H @- http://127.0.0.1:47832/health
   ```

### Settings

The service reads these from its environment, through `Environment=` lines in the unit:

| Variable | Default | What it sets |
|---|---|---|
| `KELPIE_RUNNER_PORT` | `47832` | the loopback port, which the VPC Service points at |
| `KELPIE_RUNNER_SECRET_FILE` | `~/.config/kelpie-runner/secret` | the secret file |
| `KELPIE_RUNNER_WORK_DIR` | `~/.local/state/kelpie-runner/claude-code` | the empty folder Claude Code runs in, created `0700`; its sessions' transcripts are kept for this folder, apart from the owner's own sessions. A folder already there must be a directory of the runner's user that no one else may open, or the runner doesn't start (exit 78) |
| `KELPIE_RUNNER_CLAUDE_DIR` | `~/.claude` | Claude Code's own folder, whose `sessions/` and `projects/` the runner reads for the server's sessions |

## The tunnel and the VPC Service

Cloudflare's [Workers VPC](https://developers.cloudflare.com/workers-vpc/) is in beta, and free during it.

1. **Create a remotely managed tunnel** in the Cloudflare dashboard, under Networking, Tunnels. `wrangler tunnel` works too, but its commands are experimental.
2. **Run `cloudflared` as a system service** on the VPS, version 2025.7.0 or later.
   - **The token:** put the tunnel's token, from its install command in the dashboard, in `/etc/cloudflared/kelpie-runner.token`, owned by root, mode `0600`.
   - **The service:** this unit gives the token to `cloudflared` as a systemd credential, so it never shows in the process list, as it would with `cloudflared service install <TUNNEL_TOKEN>`. It runs `cloudflared` as a throwaway unprivileged user.

   ```ini
   # /etc/systemd/system/cloudflared-kelpie-runner.service
   [Unit]
   Description=Cloudflare Tunnel for Kelpie's runner
   After=network-online.target
   Wants=network-online.target

   [Service]
   Type=notify
   TimeoutStartSec=30
   DynamicUser=yes
   LoadCredential=token:/etc/cloudflared/kelpie-runner.token
   ExecStart=/usr/bin/cloudflared --no-autoupdate tunnel run --token-file ${CREDENTIALS_DIRECTORY}/token
   Restart=on-failure
   RestartSec=5s
   NoNewPrivileges=yes
   ProtectSystem=strict
   ProtectHome=yes
   PrivateTmp=yes

   [Install]
   WantedBy=multi-user.target
   ```

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now cloudflared-kelpie-runner
   ```

   Its journal shows "Registered tunnel connection" four times. Warnings about ICMP and `ping_group_range` are harmless: the runner needs no ping.

   It connects out over QUIC, on outbound UDP port 7844. The tunnel needs no ingress rules for Workers VPC. **Don't give it a public hostname for the runner:** the secret would then be the runner's only protection.
3. **Create the VPC Service**, pointing at the runner:

   ```bash
   bunx wrangler vpc service create kelpie-runner --type http --tunnel-id <TUNNEL_ID> --ipv4 127.0.0.1 --http-port 47832
   ```

## Kelpie's side

`channel-egress` is the only Worker that calls the runner, and it keeps the runner's secret in Kelpie's secret store (`docs/secrets.md`).

1. **Let the deploy bind it.** The deploy's API token needs the account's **Connectivity Directory Bind** permission (`docs/deploy.md`, "One-time setup"). Without it, binding fails with `code: 10196`, and the deploy rolls back.
2. **Give the deploy the VPC Service's id,** as a variable of GitHub's `production` environment ([ADR-0042](adr/0042-runner-vpc-service-id-in-github.md)):

   ```bash
   gh variable set RUNNER_VPC_SERVICE_ID --env production --repo guedesdiogo/kelpie --body <VPC_SERVICE_ID>
   ```

   The next deploy gives `channel-egress` its `RUNNER` binding (`docs/deploy.md`). A merge that ships nothing deploys nothing, so the first time it takes a deploy by hand, with `always` (`docs/deploy.md`, "By hand"). Its log says "kelpie-channel-egress gets the runner's VPC Service as its RUNNER binding".

   If that deploy fails on `channel-egress`, every later one will too. Delete the variable (`gh variable delete RUNNER_VPC_SERVICE_ID --env production`), then check the id against `wrangler vpc service list`, and check that the deploy's API token may bind a VPC Service.
3. **Give Kelpie the secret.** Ask Master to connect the runner: Kelpie sends a one-time link to a secure form. Open it, and paste the content of `~/.config/kelpie-runner/secret`, which `cat` shows on the server. `channel-egress` checks it with the runner's `/health` before storing it. The admin API's `connectRunner` command answers the same form's path (`docs/admin-api.md`).
4. **Kelpie tells you.** Once the runner accepts the secret, Master says in the same conversation that the runner is connected, and its version, without you telling it (#328). Later, ask it how the runner is, or use the `describeRunner` command: it answers `ready`, with the runner's version, when everything works.

A rollback to a build deployed before the variable was set leaves `channel-egress` without the binding until the next deploy. So does a deploy of `channel-egress` by hand (`docs/deploy.md`).

**One user on the server.** The secret file guards the runner from other users, and the loopback port doesn't. On a server shared with other users, one of them could take the port while the runner is down, and receive Kelpie's calls with the secret. Run the runner on a server that only its owner uses.

### Using the route

The `claude-code` route is off until you turn it on (#295, #421): ask Master, which asks for your confirmation, or use the admin API's `setClaudeCode` command (`docs/admin-api.md`, "The claude-code route").
- **What it spends:** each turn on it spends the weekly usage limit of the claude.ai account logged in on this server, which your own coding with Claude Code here shares (ADR-0037 §5). If the account has extra usage on, a turn may draw from it.
- **What it serves:** your own direct conversations with Kelpie's agents, after the Anthropic API route fails, or first where the model settings name `claude-code` for conversations. Tasks and memory never reach it.
- **Before you turn it on:** `describeRunner` must answer `ready`, on protocol 3, and the account must be logged in. Until then, every turn on the route fails, with a notice, and the tier's next route answers it.
- **Turning it off** stops new turns from reaching the runner. Its sessions close by themselves after 15 minutes.

## Operating it

- **Logs:** `journalctl --user -u kelpie-runner`. Each request logs its method, path and status, never its headers or body. Claude Code's stderr, and how a session ended, are logged there too.
- **Updating:** `git -C ~/Repos/kelpie pull --ff-only`, then `bun install --production --frozen-lockfile --filter @kelpie/runner` in `~/Repos/kelpie`, then `systemctl --user restart kelpie-runner`. When `tools/runner/kelpie-runner.service` changed, copy it to `~/.config/systemd/user/` again and run `systemctl --user daemon-reload` before the restart. A merge into `main` doesn't deploy the runner: it is the owner's server.
  - **A pull alone updates it too.** The runner runs the checkout's code from its next restart, as after a failure or a reboot, and the hook from its next event. So when something else pulls the checkout, as a daily fast-forward of `main`, run the install after any pull that changed `bun.lock`: otherwise the runner restarts on new code with the old dependencies. The hook imports no package, so it needs no install.
  - **Work on Kelpie in another worktree.** Keep this checkout on `main`, with nothing uncommitted: a branch or an edit there is what the runner runs from its next restart, and the hook at once.
- **Rotating the secret:**
  1. Add the new secret as a second line of the file, and restart the runner. It now accepts both.
  2. Give Kelpie the new secret, through a new `connectRunner` form.
  3. Remove the old line, and restart again.
