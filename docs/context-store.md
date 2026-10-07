# Context Store

The `context-store` Worker is the only part of Kelpie that reads or writes the vault: the owner's private GitHub repository of Markdown ([ADR-0005](adr/0005-context-store.md), [ADR-0016](adr/0016-vault-second-brain.md), [ADR-0020](adr/0020-shared-memory-engine.md)). Agents never see Git: they call it over RPC.

## What it does

- **A working copy.** Its one `Vault` Durable Object keeps the Markdown of the vault's default branch in SQLite. It skips hidden folders such as `.obsidian/` and files over 1 MiB or not UTF-8, whether they arrive in a full read or in a push; a file that grows past the limit leaves the working copy.
- **Reads for a turn.** `compile(agent)` returns the agent's persona (`agents/<agent>/SOUL.md`), the shared `AGENTS.md`, the agent's own `AGENTS.md`, and the skills it can see:
  - `skills/**/SKILL.md` and `agents/<agent>/skills/**/SKILL.md`;
  - each named and described by its frontmatter.

  `conversation-runtime` builds each turn's system prompt from them: the persona, or the configured prompt when there is none, then the rules, then the skills. A change to any of them starts a new prompt version.
- **Writes, as the single writer** (ADR-0020 §3).
  - **Memory and knowledge:** `write` covers `memory/`, `knowledge/`, `areas/`, `projects/`, `conversations/` and the agent's own `agents/<agent>/memory/`.
    - Reads see a write at once.
    - The object commits the writes made within about five seconds in one commit, up to 100 writes or 2 MB per commit.
    - Each commit names its agents in its trailer: `Kelpie-Agent: <agent-id>`.
    - One call holds up to 50 changes and 2 MB, with no file over 1 MiB; more answers `too_large`.
    - Writing what a file already holds, or removing a file the vault doesn't have, does nothing.
  - **Persona, rules and skills:** `propose` puts the change on a new branch and opens a pull request for the owner, because approval is on, the default (ADR-0020 §5). The setting per item and the confidence floor come with #113.
    - The same change proposed again returns the first pull request, whether or not it is still open. At most 10 proposals are attempted an hour, failed ones included.
    - The agent's reason goes into the pull request as a code block, so it renders as text.
    - If GitHub fails midway, the branch it left is removed and the call answers `failed`.
- **Edits made elsewhere.** GitHub, Obsidian through obsidian-git, or any editor:
  - **How they arrive:** through GitHub's push webhook, a second after it, and through a reconcile every 15 minutes, because GitHub doesn't redeliver a failed webhook.
  - **Kelpie's own commits** come back the same way and change nothing. That includes a commit that landed although GitHub's answer was lost: the queued writes it holds count as done.
  - **A file both changed** (#114): when the owner changed a file Kelpie has queued writes for, the two merge line by line from the version both started from (diff3).
    - Kelpie's lines that don't overlap the owner's stay. Lines both added at the same place both stay, the owner's first. Where both changed the same lines, the owner's side wins.
    - The result keeps the owner's line endings.
    - Kelpie's writes that lost lines are kept in the object's `conflicts` table, marked `owner_won`, and the log says how many.
    - **The owner's version wins whole when:**
      - there is no common version: a file both created, or one that was empty;
      - either side removed the file;
      - a version runs past 500 lines, since the merge runs inside the sync;
      - the merge would hold conflict markers.
  - **A file pushed with conflict markers** (#114): git's `<<<<<<<`, `=======` and `>>>>>>>` lines, committed unresolved, found in one pass over each line.
    - These don't count: a line of `=======` alone under text, which is a heading's underline, and markers quoted in a fenced code block that closes. A fence left open protects nothing.
    - **Held:** the file is kept as pushed in the object's `held` table.
      - Reads, the agent's prompt (persona, rules and skills) and memory see its version from before the conflict, never the markers. A file stays held while the vault still has it as pushed, even through `forget`.
      - Kelpie's queued writes to it stay out of commits.
      - **The exception:** the pages Kelpie writes, the memory report and Dream's page under `memory/_lint/`, lose their hold on `forget`, and Dream's page also when Dream is turned off. The next report writes them again over the conflict, which git history keeps.
    - **Resolved by the model,** one held file at a time, after GitHub's work.
      - **What it sees,** through llm-gateway's `generate`: the vault's layout, its `AGENTS.md`, the file as the vault had it before the push, and the file as pushed.
      - **The answer:** it must leave no markers, keep every line outside the conflicts verbatim and in order, take each conflict's lines only from its sides or its base, and keep its frontmatter parseable. The model resolves; it can't rewrite. The answer ends as the file ends, with or without a final newline.
      - **Limits:** tries come at least 5 minutes apart. Files over 48,000 characters aren't tried.
      - **The owner wins a race:** before the resolution is applied, the object syncs. If the owner fixed the file meanwhile, the resolution is dropped.
    - **Applied** until per-item approval exists (#113):
      - a file an agent may write is written as the owner's clean edit would be, and queued writes merge on top of it;
      - a persona, rules or an agent's skill becomes a pull request that says the model wrote it. The file stays held until a clean version is pushed, as when the pull request merges. A pull request closed unmerged leaves it held and listed;
      - any other file stays held.
    - **Waiting:** after three failed tries, the file waits for the owner. `/commands/listHeldFiles` lists what waits ([admin-api.md](admin-api.md)), and a clean push of the file ends its hold.
    - **Audit:** a resolved file stays in `held`, as pushed, alongside git's history, except Kelpie's own pages, as above.
- **When GitHub fails.**
  - **A call fails** (GitHub down, a timeout, a rate limit): the object retries after a minute, then twice as long each time, up to an hour. Queued writes wait and stay readable; new writes and pushes wait for the retry too.
  - **GitHub refuses a commit:**
    - the batch is split in half until one write is refused alone;
    - that write is set aside in `conflicts`, marked `refused`, only once the next write, also alone, goes through;
    - if GitHub refuses that one too, it is refusing everything (a branch rule, a revoked permission), and nothing is set aside: the writes wait for the retry.
  - **A commit fails on a large batch:** the next try commits half as many writes, and the batch grows back after a flush that commits everything.
- **A README.** A vault without one gets a `README.md` that describes the layout, so people and other agents can find their way.
- **Memory** (#110). The same object keeps memory's index ([memory-format.md](memory-format.md#the-index)) next to the working copy:
  - **Indexing:** every move of the head, a sync or one of its own commits, is applied to the index as one step.
    - A step is applied as a change set only when the index stood exactly at the previous head. Otherwise the index is brought to the new head from the working copy. That covers a crash between a move and its indexing, a new schema, and a branch the owner rewound.
    - The alarm and each recall check that the index stands at the head. Notes that haven't changed are skipped, so a check is cheap.
    - "As of" therefore means as of when the Context Store synced, not when the owner's device committed.
  - **Dream** (#112, [memory-format.md](memory-format.md#dream)): after the report, the alarm runs one step of Dream.
    - **A step** is at most one model call. It proposes an abstract for a note Kelpie wrote, a summary of one day of one conversation, or a merge of Kelpie's duplicates. A merge of the same content needs no call.
    - **Activity:** a recall, search, read or write marks memory as active, and Dream waits for 30 minutes of quiet.
    - **What it keeps:** its proposals in `dream_proposals`, and its runs, with what each call used, in `dream_runs`.
    - **What it writes:** an abstract, for an operation the owner lets write, goes through the queue (`dream_writes` keeps what it wrote for a week).
    - **Day summaries and merges,** while dry, are kept in `dream_summaries` and `dream_merges` and shown on Dream's page, `memory/_lint/dream.md`.
  - **Embeddings:** the alarm embeds the notes that have no vector yet, through llm-gateway's `embed`, four batches of 64 a run, until none is left.
    - The model is the one `EMBEDDING_PROVIDER` chooses on llm-gateway. A recall that sees a new model arms the alarm, which embeds every note again; until then the vector stream finds what it can.
    - This runs after GitHub's work and fails on its own, so an llm-gateway outage never delays the vault's writes. A call that doesn't answer in 40 s is given up.
  - **`core(agent, budgetTokens)`:** the agent's always-loaded core (#112, [memory-format.md](memory-format.md#retrieval)), as one block.
    - **Within the budget:** at most 8,000 tokens, as recall's.
    - **What goes in:** the notes the owner pinned in the global scope or the agent's own, then the owner's profile, then the agent's self-model.
    - **What it doesn't do:** it counts no access, and never waits behind a commit to GitHub.
    - **Off or failing:** with the vault off, or on any failure, it answers an empty block.
  - **`recall(agent, question, {scopes, budgetTokens, asOf?, validAt?, qualifier?})`:** the memories that answer a question, packed for one turn.
    - The question is read up to 2,000 characters.
    - Its vector joins the retrieval if llm-gateway answers within 2 s.
    - Retrieval fetches the 30 best hits. The agent's qualifier (Clef, or Jev if the agent chose it) reranks them, if it answers within 3 s, and the 10 best are packed. Otherwise the fused order stays.
    - The block holds at most 8,000 tokens.
    - `scopes` is required, at most 64 of them: `"all"` for a private chat with the owner, or the scopes a turn may see.
    - It never waits behind a commit to GitHub, only behind the first sync of a vault never synced.
    - Its only write is the access count.
    - It returns each note's provenance beside its path (#126). A note is Kelpie's while the vault holds a version Kelpie's own commit wrote, including its lines merged into an owner's edit. An edit made elsewhere, or a conflict the model resolved from the file's own lines, makes it the owner's.
      - The record is a table of the blobs Kelpie committed (`authored`), outside memory's index, so a rebuild keeps it.
      - A merged version also holds the owner's lines, so the owner's-word rule still guards it (#160): `owner_merges` keeps its content while the vault holds it, or while the merged write waits to commit; the daily report's run drops it after that.
    - With the vault off, or on any failure, it answers an empty block, and the turn goes on without memory.
  - **`search(agent, query, {scopes, k?, asOf?, validAt?, qualifier?})`,** for the agent's `memory_search` (#126).
    - It is recall's retrieval and rerank, answered as hits instead of a packed block, in #110's fence: 3 by default, 10 at most.
    - It returns each hit's scope, validity and provenance too, and counts no access.
    - It answers `vault_off` or `unavailable` instead of an empty list, so the model doesn't take a failing memory for an empty one.
  - **`readNote(agent, path, {scopes, offset?})`,** for the agent's `memory_read` (#126).
    - **What opens:** only a current note of memory's index within the scopes. Anything else is "not found", the same answer whether the file exists or not.
    - **A page:** under 9,500 characters, fence included, with `nextOffset`.
    - **The first page** lists the links the scopes allow, and counts as one access.
  - **`writeNote(agent, input, {scopes, sources})`,** the single writer behind the agent's `memory_write` (#126).
    - **Checks first:** it runs `writeMemory`'s checks, removes secrets, refuses session pages and conflict markers, and keeps a found note's kind and scope.
    - **A found note** keeps what the model left out ([memory-format.md](memory-format.md#retrieval)).
    - **Writes:** it queues the note like any write, under a headline that doesn't name it, and answers `written` or `unchanged`, with the path. The path is chosen and the write queued in one stretch, without a pause.
    - **Provenance:** a commit whose answer was lost still counts as Kelpie's. A file the owner removes, or a force-push takes away, leaves no record.
    - **Refusals:** `invalid` comes with the problems found, for the model to fix. A path the turn can't see is `not_found`, the same as a missing note. A scope the turn can't write to is `scope_not_allowed`.
  - **Access counts:** each recall counts the notes it packed, in one write, in a table outside the index. A rebuild keeps them, and they never reach git.
  - **The memory report** (#111): once a day, after the embeddings and the held files, the alarm writes what memory's index finds (cold notes, duplicates, possible contradictions), and Dream's plan, to `memory/_lint/report.md`, or removes the page when memory is clean ([memory-format.md](memory-format.md#the-daily-report)).
    - The page is queued only when it changed, so a quiet day makes no commit.
    - It reads the index at the head, bringing it there first; if that fails, it tries again at the next alarm.
    - Agents can't write under `memory/_…/`, so no one else writes the page.

## Setting it up

`context-store` reaches llm-gateway through its `LLM_GATEWAY` service binding, for memory's embeddings and rerank, so llm-gateway deploys first. Without llm-gateway's models, recall works on full text, entities and links alone.

Its `ContextStore` entrypoint serves the Workers that run conversations. `ContextStoreAdmin` holds the owner's actions: listing held files, forgetting erased content, and turning Dream off or back to dry runs (#112). Only admin-api binds it, so nothing a conversation reaches can call them.

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

## Obsidian

The owner edits the vault in Obsidian through [obsidian-git](https://github.com/Vinzent03/obsidian-git), which commits and pushes to GitHub. These settings keep its pushes and Kelpie's writes from undoing each other:

- **Sync method: Merge.** obsidian-git always merges on mobile.
- **Merge strategy: None.**
  - With `theirs`, Kelpie's commits would win over the owner's edits on the device.
  - With None, a conflict stops obsidian-git's auto-commit and blocks its push until the owner resolves it on the device.
  - If one is pushed unresolved anyway, the Context Store resolves it, as above.
- **An auto commit-and-sync interval.** It is off by default. It decides how soon an edit reaches the agent: a few minutes is enough.
- **Never "Other sync service".** It moves the branch without updating the files. The next commit then silently reverts Kelpie's writes, and nothing lands in `conflicts`.

## Export

The vault is the export: clone the repository. Every memory, person, conversation page and rule is a Markdown file in it ([memory-format.md](memory-format.md)).

The Context Store's tables hold mostly copies of it: the working copy, memory's index, writes still queued, and counts. Two tables hold what git may not:
- `conflicts`: Kelpie's writes that lost to the owner's edits, or that GitHub refused;
- `held`: files pushed with conflict markers, as pushed.

## Erasing content

Git keeps every version, so erasing content means rewriting the vault's history. Kelpie never rewrites it. These steps are the owner's.

1. **Rewrite the history** on a fresh clone, with [`git filter-repo`](https://github.com/newren/git-filter-repo):
   - `--path <file> --invert-paths` removes a file from every commit;
   - `--replace-text` removes a passage.

   The memory report, `memory/_lint/report.md`, lists notes by title and path, and Dream's plan adds an abstract of each note it lists, which a model wrote from the note's content (#112). When an erased note was ever in it, rewrite the report's history too, with the same `--replace-text` or by removing the file. Dream's page, `memory/_lint/dream.md`, holds summaries a model wrote of conversations and merged bodies of notes: rewrite its history too.

   Then push the result with `--force` to every branch that held the content.
2. **Make Kelpie forget its copies, right away:** `/commands/forgetVaultPaths` with the erased paths ([admin-api.md](admin-api.md)). Doing it at once keeps Kelpie's queued writes from committing the content back onto the rewritten branch.
   - **What it does:**
     - it syncs to the rewritten head;
     - it rebuilds memory's index from the vault as it is now, which drops every old version, of every file, with the vectors of content no version holds anymore;
     - it deletes the rows that name the paths in `queue`, `conflicts`, `held`, `proposals`, `recall_counts`, `authored`, `owner_changes`, `owner_merges`, `dream_proposals`, `dream_writes`, `dream_summaries` and `dream_merges`, and a day summary or a merge that read a forgotten path;
     - it drops a memory report or Dream's page wherever a copy waits: in the queue, set aside in `conflicts`, merged with the owner's edit in `owner_merges`, or held. A conflict the owner left on one of these pages goes too; git history keeps it. It wakes within seconds, or at a retry already pending, and the next two alarms write the pages again from what is left, one queuing and one committing, while GitHub answers.

     It never touches git.
   - **Paths:** a path ending in `/` names a whole folder. Rows are matched by path, so a passage removed with `--replace-text` needs every file that held it named, or its folder.
   - **The answer** lists, in `stillInVault`, the named files the vault still has. After removing whole files, a path in that list means the rewrite didn't reach the default branch. After removing a passage, the file stays, as expected.
   - **The always-loaded core** (#112): a conversation keeps the core it loaded until its next checkpoint. For every agent with `memoryCore` on, set it off and then on again (`/commands/configureAgent`).
     - Each change starts a new prompt version.
     - Every conversation then loads its core from the rebuilt index on its next turn.
3. **Re-clone every device.** A device that still has the old history would push the content back: obsidian-git's pull doesn't notice a rewritten branch. Delete the vault's folder on each device and clone it again, or reset the device's branch to the rewritten one. Then run step 2 again, in case a device pushed before it was re-cloned.
4. **Ask GitHub to drop its copies.** Pull requests (Kelpie's proposals included) and GitHub's cached views keep the old commits. GitHub removes them only through its support, as its guide to [removing sensitive data from a repository](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository) explains. Close Kelpie's open proposals that touched the content, and delete their branches.

**Not covered:**
- **Conversations:** each conversation's raw history, kept in its Durable Object in `conversation-runtime` (#109), and the checkpoints that summarize it. Neither is pruned today. A conversation that mentioned the content can also bring it back into a new session page.
- **Model logs:** the model calls that resolved held files sent the files to the model's provider, through Cloudflare's AI Gateway. Their logs follow the provider's and the gateway's retention.
- **Durable Object storage:** Cloudflare's point-in-time recovery can restore a Durable Object's storage to an earlier moment, within the window Cloudflare documents.

## Checking it

- **The webhook:** GitHub's App settings show its deliveries.
  - 202: a push was accepted and the vault syncs a second later.
  - 401: the secret doesn't match.
  - 200: a ping.
- **Persona:** an edit to `agents/<agent>/SOUL.md` on GitHub reaches the agent's next turn.
- **Held files:** `/commands/listHeldFiles` lists the files pushed with conflict markers that still wait, with their tries.
- **Logs:**
  - `Vault: a GitHub call failed; retrying` gives the number of failures in a row.
  - `Vault: resolving a conflict failed` or `a conflict's resolution failed its check`: a try that didn't resolve a held file.
  - `GitHub refused a write; it was set aside` gives GitHub's reason; the write is in `conflicts`.
- **The vault's branch:** it needs at least one commit. A renamed default branch is picked up at the next sync.
