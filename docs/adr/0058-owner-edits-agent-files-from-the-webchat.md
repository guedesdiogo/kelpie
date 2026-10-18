# ADR-0058: The owner edits an agent's own files from the webchat, committed directly as the owner's edit

- Status: Accepted
- Date: 2026-10-17
- Issue: [#381](https://github.com/guedesdiogo/kelpie/issues/381)
- The owner approved #381's plan, which proposed this decision, on 2026-10-16: «Aprovo os planos da #378, #379 e #381, incluindo a ADR proposta na #381 e os três preenchimentos da #377.»
- Amends:
  - [ADR-0016](0016-vault-second-brain.md), its writes: the owner's edits in the webchat's editor are a writer of their own, committed directly with no pull request, and neither the personal-data gate nor the sanitizer runs on them;
  - [ADR-0048](0048-master-configures-kelpie.md) §2, its table: the owner changes any agent's soul, rules, memory file and skills from the editor, with no agent involved;
  - [ADR-0056](0056-agent-editor-and-random-mascot.md) §3: ingress binds one more entrypoint, context-store's `AgentFiles`, its only path into the vault.

## Context

The owner, on 2026-10-16, asked for the files that define an agent in its editor (#379):

> «Vale ter como editar as informações que definem o agente também, como uma aba além da edição do visual do mascote, seguindo o mesmo padrão de design, mas trazendo uma aba para cada item que define o agente como o soul.md e etc. só o que é exclusive daquele agente»

What belongs to one agent only sits under `agents/<agent-id>/` (ADR-0016): `SOUL.md`, `AGENTS.md`, `memories/MEMORY.md` in Hermes's format, and `skills/`.

**Before this ADR:**
- **ADR-0016:** an agent proposes a change to its persona, rules or skills, and context-store opens a pull request for the owner. Every edit made outside Kelpie, on GitHub, in Obsidian or any editor, counts as the owner's and goes straight to the branch.
- **ADR-0048 §2:** another agent's soul, rules and skills change through Master, at the owner's request.
- **ADR-0020 §4** dropped the personal-data gate, so the sanitizer for secrets and credentials is what remains on Kelpie's own writes. ADR-0016 still says Kelpie's writes pass the gate.
- **Ingress had no path into the vault.** It binds context-store only for GitHub's webhook.
- **Kelpie reads no `memories/MEMORY.md`.** Its own memory lives in notes under `agents/<agent-id>/memory/` and the shared folders (ADR-0020). The file is Hermes's, which reads it.

## Decision

### 1. The owner's edits from the webchat are the owner's own

- **An edit in the agent's editor is the owner's, as an edit on GitHub is.** The owner is the one who approves, so no pull request opens.
- **One Save is one commit** on the vault's branch, through context-store, the single writer (ADR-0020 §3).
  - Its headline names the agent and what changed, and its trailer names the webchat: `Kelpie-Via: webchat`. It carries no `Kelpie-Agent`, since no agent wrote it.
  - The version it writes counts as the owner's in memory's provenance (#126), never Kelpie's.
- **Undo is one more commit** that writes the previous versions back.
- **Neither the personal-data gate nor the sanitizer runs on the owner's edits.**
  - The gate is gone since ADR-0020 §4.
  - The sanitizer would rewrite the owner's words with `[REDACTED]`, or refuse what the owner can already write on GitHub. Kelpie never rewrites an edit of the owner's, wherever it is made.
  - What the owner writes reaches the agent's prompt, and its model's provider, as an edit on GitHub would.
- **An installed skill is someone else's text, so it is reviewed** (§5). Once the owner installs it, it is the owner's edit like any other.

### 2. A narrow path into the vault

- **context-store gains an `AgentFiles` entrypoint, bound only by ingress,** with three methods and nothing else:
  - `files`, which reads one agent's files;
  - `save`, which writes them, in one commit;
  - `fetchSkill`, which stages a skill for review (§5).
- **It reaches only these files of one agent:**
  - `agents/<id>/SOUL.md`;
  - `agents/<id>/AGENTS.md`;
  - `agents/<id>/memories/MEMORY.md`;
  - `agents/<id>/skills/<name>/SKILL.md`, and an installed skill's other files under `agents/<id>/skills/<name>/`.

  Not the shared `AGENTS.md`, `skills/` or `USER.md`, not memory's notes, and not another agent's folder. Subagents have none (ADR-0036).
- **The entrypoint's shape is the control,** as `AgentEditor`'s is (ADR-0056 §3). It checks that the actor is the owner. The actor is ingress's word, so the check catches a mistake in ingress, not a compromised one.
- **The routes,** under #379's checks: the Access token, a request whose `Origin` is the page's and whose `Sec-Fetch-Site` is `same-origin`, the owner as the actor, and an agent the Registry lists, that isn't a subagent, and that the Directory admits this login to.
  - `GET /webchat/agents/<id>/files` reads them all, since they are small and the editor shows them together.
  - `PUT /webchat/agents/<id>/files` saves the changed ones. One Save is one request, so it is one commit.
  - `POST /webchat/agents/<id>/skills/fetch` stages a skill: a GitHub address or pasted text as JSON, or a `.zip` or `.skill` file's bytes.
  - Each takes only the body it expects, read up to a limit in bytes before anything is parsed.

### 3. A newer version is never overwritten

- **Each file's version is its git blob SHA** as the editor read it, and none for a file the vault doesn't have. A save names, for each file, the version it started from (ADR-0005).
- **Before it compares, context-store syncs with the branch,** so an edit pushed from GitHub or Obsidian counts.
- **A newer version is a conflict.** The save answers with the newer content and its version, and writes nothing to that file. The other files of the save still commit.
- **A file held with conflict markers** (#114) isn't written from the editor. The owner resolves it where it was pushed.

### 4. Each file keeps its format

- **`MEMORY.md` keeps Hermes's format exactly:**
  - entries joined by `\n§\n`, each one shows something, with no blank line around `§` and no frontmatter;
  - at most 2,200 characters, counted as Hermes counts them, in code points.

  context-store refuses any other, as Hermes's drift guard would.
- **A `SKILL.md` follows the Agent Skills specification:**
  - frontmatter whose `name` is its folder's name: 1 to 64 lowercase letters, digits and single hyphens, neither first nor last;
  - a `description` of 1 to 1,024 characters.
- **No file takes conflict markers,** which would hold it on the next sync. Each file is at most 1 MiB, and a save at most 2 MB.

### 5. A skill installs only after the owner reviews it

- **Three sources,** from the research on #381:
  - a GitHub repository or folder address, at a branch, a tag or a commit;
  - a `.zip` or `.skill` file;
  - pasted text, a `SKILL.md` alone.

  Not supported: registry slugs, following a branch, automatic updates, plugin manifests, npm packages, and an agent that fetches a skill and saves it without this review.
- **The fetch reaches two GitHub hosts and nothing else,** so the address can't send it anywhere.
  - It resolves the branch or tag to a commit through `github.com`'s Git refs, with no token. A commit SHA in full stands as it is, and the review says no branch or tag vouches for it, since GitHub serves a fork's commits under the repository's name too.
  - It takes the repository's archive at that commit from `codeload.github.com`.
  - The owner, the repository, the ref and the folder are checked before any fetch. It follows no redirect, and stops reading past the archive's size limit.
- **Staged outside the vault,** in the Vault object's own storage, for an hour. It never reaches git until Save.
- **Validated before the owner sees it:**
  - exactly one `SKILL.md`, valid as §4 says, and no second one inside the folder, in any case;
  - paths that stay inside the skill's folder, with no `..`, no absolute path, no link and no name a checkout would break on, nor two that differ only by case or Unicode's form;
  - Markdown and scripts that are UTF-8 text, so none slips past the scan;
  - at most 200 files, 1 MiB each and 2 MB in all, uncompressed;
  - no encrypted entry. Hidden files, such as `.DS_Store`, and `__MACOSX/` are left out.
- **Every file is kept, binary ones too,** as Hermes keeps them, so the folder in the vault is the folder at that commit. A binary file, such as a font, is committed as bytes and labeled in the review; an executable one, such as an `.exe` or a `.so`, is a finding. Kelpie's working copy still holds Markdown only (ADR-0005).
- **The review shows** the `SKILL.md`, every file, and a static scan with its findings by file and line, adapted from Hermes's `skills_guard`.
  - Scripts are kept and labeled "kept, not runnable in Kelpie", since no agent runs code by default.
  - The scan advises, with one exception: hidden characters, which can carry instructions the owner can't see, block the install. They are the characters that show nothing: format and default-ignorable characters, and joiners or variation selectors anywhere but after the emoji, the letters or the ideographs they shape.
  - Every binary file is scanned for the text it may hold too, and an archive or a PDF, whose packed contents the scan can't read, is a finding. The `SKILL.md`'s description is scanned as its YAML decodes it, since an escape can write a hidden character the file doesn't show.
- **The owner's Install adds a pending change,** and Save commits it under `agents/<id>/skills/<name>/`.
  - Save refuses it when the skill's folder changed in the vault since the review, or when the folder holds files and no `SKILL.md`, which no review showed.
  - The commit's trailers name its source, its commit and its content's hash: `Kelpie-Skill: <name>`, `Kelpie-Skill-Source`, `Kelpie-Skill-Commit` and `Kelpie-Skill-Hash`.
  - The Vault object also keeps them, with the files it wrote, to show an update's difference and to undo it.
- **Updates are explicit.**
  - "Look for an update" resolves the same branch or tag again and stages what it finds, with the difference. A skill pinned to a commit in its address stays at that commit.
  - A skill the owner edited since it was installed is never overwritten silently: the review says so before Install.

### 6. Who changes what

ADR-0048 §2's table gains a row:

| Change | Who may make it | The yes |
|---|---|---|
| Any agent's soul, rules, memory file or skills | the owner, in the webchat's editor | the owner's Save |

The other rows stand. An agent still proposes its own persona, rules and skills, as ADR-0020 §5 says, and Master still changes another agent's at the owner's request.

## Consequences

- The owner reads and edits an agent's soul, rules, memory file and skills beside its look (`docs/design-system.md` 5.25), and installs a skill there after reviewing it.
- **Ingress has a path into the vault,** limited to one agent's own files by `AgentFiles`' shape. A stolen Access session that is the owner's could change them, as it could on GitHub with the owner's login, and as it could talk to Master. The agent's next turn reads what was saved.
- **The vault's history shows each Save** with `Kelpie-Via: webchat`, and a wrong edit goes back with Undo, in git, or through the vault's own history.
- **The Memory section edits Hermes's `MEMORY.md`,** which no Kelpie agent reads yet. Whether Kelpie reads it into the prompt is a follow-up of its own.
- **An archive larger than its limit can't be installed from its address.** The owner downloads the skill's folder and uploads it as a `.zip`.

## Alternatives considered

- **Open a pull request for each Save.** The owner would approve their own edit twice.
- **Route the edits through Master.** Each save would cost a model turn and a confirmation the owner just gave with Save (ADR-0056's same reason).
- **Run the sanitizer on the owner's edits.** It would rewrite or refuse the owner's own words, which an edit on GitHub never meets.
- **Commit each file on its own.** A Save that changed the soul and a skill would land half-written, and Undo would need several commits.
- **Fetch skills through GitHub's REST API.** Without a token it allows 60 calls an hour per address, which Workers share; with the vault's App token it reaches only the vault's repository.
- **Stage the skill in the page.** The vault would then receive what the page sends, not what was fetched and reviewed, and the source and commit would be the page's word.
- **Leave binary files out.** A client that needs a skill's fonts or images, such as Hermes, would find the skill broken.

## References

- [#381](https://github.com/guedesdiogo/kelpie/issues/381): the plan, the research on how other agents install skills, the motion round, and the reference projects' findings.
- [ADR-0005](0005-context-store.md), [ADR-0016](0016-vault-second-brain.md), [ADR-0020](0020-shared-memory-engine.md), [ADR-0036](0036-agent-roles-models-and-subagents.md), [ADR-0048](0048-master-configures-kelpie.md), [ADR-0056](0056-agent-editor-and-random-mascot.md).
- [Agent Skills specification](https://agentskills.io/specification).
- [`docs/context-store.md`](../context-store.md), the `AgentFiles` entrypoint; [`docs/design-system.md`](../design-system.md) 5.25, the editor and its files.
