# The runner

The runner is the process on the owner's VPS that Kelpie's Workers call to use that machine ([ADR-0035](adr/0035-agent-computer.md)). Its code is in `tools/runner`. It runs with Bun, from a checkout of this repository, with only its own dependencies installed: the Claude Agent SDK and the MCP SDK, both pinned.

- **It listens on `127.0.0.1` only.** The server opens no port: Workers reach it through a Cloudflare Tunnel and a Workers VPC Service.
- **Every request needs its secret**, as `Authorization: Bearer <secret>`. Without it the runner answers 401, on any path.
- **It never calls Kelpie.** Its answers go back on the requests `channel-egress` makes (#294).
- **What it serves:**
  - `GET /health`, which answers its version and protocol version:

    ```json
    { "ok": true, "version": "0.2.0", "protocol": 2 }
    ```

  - the `claude-code` route's sessions (ADR-0037 §2, #295), described below:
    - `POST /sessions/:id/turns` runs a turn and streams its frames as NDJSON;
    - `POST /sessions/:id/tool-results` answers a tool call the turn asked for;
    - `DELETE /sessions/:id` closes a session.

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

## Setting it up

On the VPS, as the user whose claude.ai login Claude Code uses:

1. **Install Bun,** clone this repository into `~/kelpie`, and install the runner's dependencies only. `--production` leaves out the test tools, and `--frozen-lockfile` installs exactly the versions in `bun.lock`:

   ```bash
   curl -fsSL https://bun.sh/install | bash
   git clone https://github.com/guedesdiogo/kelpie.git ~/kelpie
   cd ~/kelpie && bun install --production --frozen-lockfile --filter @kelpie/runner
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
   cp ~/kelpie/tools/runner/kelpie-runner.service ~/.config/systemd/user/
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
- **Before you turn it on:** `describeRunner` must answer `ready`, on protocol 2, and the account must be logged in. Until then, every turn on the route fails, with a notice, and the tier's next route answers it.
- **Turning it off** stops new turns from reaching the runner. Its sessions close by themselves after 15 minutes.

## Operating it

- **Logs:** `journalctl --user -u kelpie-runner`. Each request logs its method, path and status, never its headers or body. Claude Code's stderr, and how a session ended, are logged there too.
- **Updating:** `git -C ~/kelpie pull --ff-only`, then `bun install --production --frozen-lockfile --filter @kelpie/runner` in `~/kelpie`, then `systemctl --user restart kelpie-runner`. When `tools/runner/kelpie-runner.service` changed, copy it to `~/.config/systemd/user/` again and run `systemctl --user daemon-reload` before the restart. A merge into `main` doesn't deploy the runner: it is the owner's server.
- **Rotating the secret:**
  1. Add the new secret as a second line of the file, and restart the runner. It now accepts both.
  2. Give Kelpie the new secret, through a new `connectRunner` form.
  3. Remove the old line, and restart again.
