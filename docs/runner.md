# The runner

The runner is the process on the owner's VPS that Kelpie's Workers call to use that machine ([ADR-0035](adr/0035-agent-computer.md)). Its code is in `tools/runner`. It runs with Bun, from a checkout of this repository, and needs no `bun install`.

- **It listens on `127.0.0.1` only.** The server opens no port: Workers reach it through a Cloudflare Tunnel and a Workers VPC Service.
- **Every request needs its secret**, as `Authorization: Bearer <secret>`. Without it the runner answers 401, on any path.
- **It never calls Kelpie.** Its answers go back on the requests `channel-egress` makes (#294).
- **What it serves today:** `GET /health`, which answers its version and protocol version:

  ```json
  { "ok": true, "version": "0.1.0", "protocol": 1 }
  ```

## Setting it up

On the VPS, as the user whose claude.ai login Claude Code uses:

1. **Install Bun** and clone this repository into `~/kelpie`:

   ```bash
   curl -fsSL https://bun.sh/install | bash
   git clone https://github.com/guedesdiogo/kelpie.git ~/kelpie
   ```

2. **Create the secret.** It is 32 random bytes, in a file only this user can read. The runner refuses to start on a file others can read, or without a secret.

   ```bash
   install -d -m 700 ~/.config/kelpie-runner
   (umask 077; openssl rand -hex 32 > ~/.config/kelpie-runner/secret)
   ```

   It must be a regular file of this user, not a symlink.

3. **Install the service.** It restarts on failure, but not on a setting to fix (exit 78). It sets `NoNewPrivileges`, which every process the runner starts inherits, and `NODE_ENV=production`, so an error never answers with Bun's page of source.

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
3. **Give Kelpie the secret.** Ask the setup agent, in the webchat, to connect the runner: Kelpie sends a one-time link to a secure form. Open it, and paste the content of `~/.config/kelpie-runner/secret`, which `cat` shows on the server. `channel-egress` checks it with the runner's `/health` before storing it. The admin API's `connectRunner` command answers the same form's path (`docs/admin-api.md`).
4. **Check it:** ask the setup agent how the runner is, or use the `describeRunner` command. It answers `ready`, with the runner's version, when everything works.

A rollback to a build deployed before the variable was set leaves `channel-egress` without the binding until the next deploy. So does a deploy of `channel-egress` by hand (`docs/deploy.md`).

**One user on the server.** The secret file guards the runner from other users, and the loopback port doesn't. On a server shared with other users, one of them could take the port while the runner is down, and receive Kelpie's calls with the secret. Run the runner on a server that only its owner uses.

## Operating it

- **Logs:** `journalctl --user -u kelpie-runner`. Each request logs its method, path and status, never its headers.
- **Updating:** `git -C ~/kelpie pull --ff-only`, then `systemctl --user restart kelpie-runner`. A merge into `main` doesn't deploy the runner: it is the owner's server.
- **Rotating the secret:**
  1. Add the new secret as a second line of the file, and restart the runner. It now accepts both.
  2. Give Kelpie the new secret, through a new `connectRunner` form.
  3. Remove the old line, and restart again.
