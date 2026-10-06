# Context Store

The `context-store` Worker is the only part of Kelpie that reads or writes the vault: the owner's private GitHub repository of Markdown ([ADR-0005](adr/0005-context-store.md), [ADR-0016](adr/0016-vault-second-brain.md), [ADR-0020](adr/0020-shared-memory-engine.md)). Agents never see Git: they call it over RPC.

## What it does

- **A working copy.** Its one `Vault` Durable Object keeps the Markdown of the vault's default branch in SQLite. It skips hidden folders such as `.obsidian/` and files over 1 MiB, whether they arrive in a full read or in a push.
- **Reads for a turn.** `compile(agent)` returns the agent's persona (`agents/<agent>/SOUL.md`), the shared `AGENTS.md`, the agent's own `AGENTS.md`, and the skills it can see:
  - `skills/**/SKILL.md` and `agents/<agent>/skills/**/SKILL.md`;
  - each named and described by its frontmatter.

  `conversation-runtime` builds each turn's system prompt from them: the persona, or the configured prompt when there is none, then the rules, then the skills. A change to any of them starts a new prompt version.
- **Writes, as the single writer** (ADR-0020 §3).
  - **Memory and knowledge:** `write` covers `memory/`, `knowledge/`, `areas/`, `projects/`, `conversations/` and the agent's own `agents/<agent>/memory/`.
    - Reads see a write at once.
    - The object commits the writes made within about five seconds in one commit, up to 100 writes or 2 MB per commit.
    - Each commit names its agents in its trailer: `Kelpie-Agent: <agent-id>`.
    - One call holds up to 50 changes and 1 MB, with no file over 1 MiB; more answers `too_large`.
    - Removing a file the vault doesn't have does nothing.
  - **Persona, rules and skills:** `propose` puts the change on a new branch and opens a pull request for the owner, because approval is on, the default (ADR-0020 §5). The setting per item and the confidence floor come with #113.
    - The same change proposed again returns the first pull request, and at most 10 proposals are opened an hour.
    - The agent's reason goes into the pull request as a code block, so it renders as text.
    - If GitHub fails midway, the branch it left is removed and the call answers `failed`.
- **Edits made elsewhere.** GitHub, Obsidian through obsidian-git, or any editor:
  - **How they arrive:** through GitHub's push webhook, a second after it, and through a reconcile every 15 minutes, because GitHub doesn't redeliver a failed webhook.
  - **Kelpie's own commits** come back the same way and change nothing. That includes a commit that landed although GitHub's answer was lost: the queued writes it holds count as done.
  - **A file both changed:** if the owner changed a file Kelpie had queued, the owner's version wins. Kelpie's writes are kept in the object's `conflicts` table, marked `owner_won`, and the log says how many; merging the two is #114's.
- **When GitHub fails.**
  - The object retries after a minute, then twice as long each time, up to an hour. Queued writes wait.
  - A batch GitHub refuses five times in a row is set aside in `conflicts`, marked `refused`, so later writes go through.
- **A README.** A vault without one gets a `README.md` that describes the layout, so people and other agents can find their way.

## Setting it up

The vault needs a GitHub App with access to the vault repository alone. Spike #28's App works, or a new one.

1. **The App's permissions** (repository): Contents read & write, Pull requests read & write, Metadata read.
2. **The App's webhook:**
   - URL: `https://<ingress hostname>/github/webhook`;
   - a secret you generate. This copies it to the clipboard without printing it (macOS), to paste into the App's settings:
     ```bash
     openssl rand -hex 32 | tr -d '\n' | pbcopy
     ```
   - subscribed to the **Push** event.

   Accept the new permissions on the installation if GitHub asks.
3. **Install the App** on the vault repository only.
4. **Note three values:**
   - the App ID, from the App's settings page;
   - the installation ID, the number at the end of the installation's URL;
   - the repository, as `owner/name`.

   They belong to one deployment, so they go in as `--var` flags and never into this repository.
5. **Convert the App's private key** to PKCS#8, which WebCrypto needs (spike #28). It goes to a folder only you can read:
   ```bash
   ( umask 077; mkdir -p ~/.kelpie; openssl pkcs8 -topk8 -nocrypt -in <app>.private-key.pem -out ~/.kelpie/github-app.pkcs8.pem )
   ```
   Then delete the key GitHub downloaded. A new one can be generated in the App's settings when needed:
   ```bash
   rm <app>.private-key.pem
   ```
6. **Deploy with both secrets.** They go through a file only you can read, which is deleted right after.
   - Paste the webhook secret into the prompt; it isn't echoed:
     ```bash
     read -rs WEBHOOK_SECRET
     ```
   - Write the secrets file. The secret goes to this one command, not to every program the shell starts:
     ```bash
     ( umask 077; WEBHOOK_SECRET="$WEBHOOK_SECRET" node -e 'process.stdout.write(JSON.stringify({GITHUB_APP_PRIVATE_KEY: require("fs").readFileSync(process.argv[1], "utf8"), GITHUB_WEBHOOK_SECRET: process.env.WEBHOOK_SECRET}))' ~/.kelpie/github-app.pkcs8.pem > ~/.kelpie/context-store.secrets.json )
     ```
   - Deploy:
     ```bash
     bunx wrangler deploy -c apps/context-store/wrangler.jsonc --secrets-file ~/.kelpie/context-store.secrets.json --var GITHUB_APP_ID:<app id> --var GITHUB_INSTALLATION_ID:<installation id> --var VAULT_REPOSITORY:<owner/name>
     ```
   - Clean up:
     ```bash
     rm ~/.kelpie/context-store.secrets.json ~/.kelpie/github-app.pkcs8.pem && unset WEBHOOK_SECRET
     ```

   Later deploys need the same three `--var` flags. Without them, Wrangler removes the vars and the vault is off again. The secrets stay.
7. **Deploy the Workers after it:** `conversation-runtime` and `ingress`, in the order of [`admin-api.md`](admin-api.md).

The secrets are Worker secrets on `context-store` ([ADR-0021](adr/0021-vault-app-secrets.md)).

**Without the three values or the private key, the vault is off.** `compile` returns nothing, writes and proposals answer `vault_off`, and agents run on their configured prompts.

## Checking it

- **The webhook:** GitHub's App settings show its deliveries.
  - 202: a push was accepted and the vault syncs a second later.
  - 401: the secret doesn't match.
  - 200: a ping.
- **Persona:** an edit to `agents/<agent>/SOUL.md` on GitHub reaches the agent's next turn.
- **Logs:**
  - `Vault: a GitHub call failed; retrying` gives the number of failures in a row.
  - `GitHub kept refusing a batch` means writes were set aside in `conflicts`.
- **The vault's branch:** it needs at least one commit. A renamed default branch is picked up at the next sync.
