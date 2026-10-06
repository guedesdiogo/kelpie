# Memory format

Kelpie's memory lives in the owner's vault: Markdown files in a private git repository ([ADR-0016](adr/0016-vault-second-brain.md)), in a format of Kelpie's own ([ADR-0020](adr/0020-shared-memory-engine.md)). This page is the spec for that format and for the index Kelpie derives from it. The code is in [`packages/memory`](../packages/memory).

The rules that shape everything below:
- **The vault is the truth.** Every index is derived from it and can be rebuilt from it. Deleting the index loses nothing.
- **A file holds only the current version of a memory.** Git keeps every earlier version, and the index keeps them too, each pointing at its commit.
- **People read and edit these files,** in Obsidian or any editor. Kelpie's own writes are strict; its reads are lenient, and never drop a note for a bad value.
- **The format is Kelpie's own.** It borrows ideas from ai-memory, but isn't compatible with it.

## Where memory lives

The path decides a note's scope. A note's kind comes from its kind folder when it has one.

| Scope | Folder | Example |
|---|---|---|
| `global` | `memory/` | `memory/people/ana-souza.md` |
| `global`, the owner's free notes | `knowledge/` | `knowledge/receitas.md` |
| `agent/<agent-id>` | `agents/<agent-id>/memory/` | `agents/kelpie/memory/preferences/tone.md` |
| `area/<name>`, an area of life or work | `areas/<name>/` | `areas/work/decisions/vendor.md` |
| `project/<name>`, kept for coding later | `projects/<name>/` | `projects/kelpie/procedures/release.md` |
| `conversation/<name>` | `conversations/<name>/` | `conversations/family/sessions/2026/2026-12-24-natal.md` |

Under a scope's folder, the first folder may name a kind:

| Kind | Folder | Default tier |
|---|---|---|
| `preference` | `preferences/` | semantic |
| `commitment` | `commitments/` | semantic |
| `event` | `events/` | episodic |
| `person` | `people/` | semantic |
| `place` | `places/` | semantic |
| `decision` | `decisions/` | semantic |
| `procedure` | `procedures/` | procedural |
| `note` | `notes/` | semantic |
| `session` | `sessions/` | episodic |

Rules for paths:
- **A scope's name is its folder's name,** such as `areas/Saúde & Bem-estar/`. It can't hold a slash, a backslash, or a control or bidirectional character, and can't start or end with a dot or a space; notes in such a folder are outside the index.
- **Under `knowledge/`, folders are the owner's own** and never name a kind. A note there takes its kind from its frontmatter, or is a `note`.
- **A note outside a kind folder** takes its kind from the frontmatter, or is a `note`. Examples: `areas/work/meeting-notes.md`, `memory/loose-note.md`.
- **Kind folders may have subfolders.** Kelpie files dated memories (sessions, events) under their year, date first: `sessions/2026/2026-10-06-family-chat.md`.
- **File names are readable.** Kelpie writes the title in lowercase ASCII, diacritics folded, with words joined by hyphens: "Café sem açúcar" becomes `cafe-sem-acucar.md`. The owner's own notes keep whatever names they have.
- **Outside the memory index:**
  - root files (`README.md`, `AGENTS.md`, `USER.md`, `index.md`, `log.md`);
  - skills (`skills/`) and each agent's `SOUL.md`, `AGENTS.md` and `skills/`, which the Context Store loads separately;
  - hidden folders (`.obsidian/`, `.trash/`);
  - anything that isn't `.md`.

## A memory file

YAML frontmatter, then a `# Title` heading, then the body. This is a person, as Kelpie writes it:

```markdown
---
id: 3f9a1c2b7d4e5f60
kind: person
scope: global
tier: semantic
level: explicit
confidence: 0.9
sources:
  - "[[2026-10-06-family-chat]]"
  - telegram:-100123/456
entities:
  - Ana Souza
  - Lisboa
valid_from: 2026-01-01
evergreen: true
abstract: The owner's sister; she lives in Lisbon.
updated: 2026-10-06T12:00:00Z
---

# Ana Souza

The owner's sister. Lives in [[Lisboa]] and works in design.
```

A commitment that holds for a while, with a contradiction it resolves:

```markdown
---
id: 9c0d5e4f3a2b1c8d
kind: commitment
scope: area/work
tier: semantic
level: deduced
confidence: 0.8
sources:
  - "[[2026-10-06-weekly-sync]]"
valid_from: 2026-11-01
invalid_at: 2026-12-01
relations:
  contradicts:
    - "[[report-due-in-october]]"
updated: 2026-10-06T15:20:00Z
---

# Monthly report due on the 5th

From November, the monthly report is due on the 5th of each month, not the 30th.
```

The owner's own note, which needs no frontmatter at all:

```markdown
# Bolo de fubá

Receita da avó: milho, ovos, leite. Ver [[Receitas]].
```

## Frontmatter

Every key is optional when reading. When Kelpie writes, it always sets `id`, `kind`, `scope`, `tier`, `level`, `confidence` and `updated`, and it sets the others only when they have a value.

| Key | Value | Meaning | When missing or invalid |
|---|---|---|---|
| `id` | 1–64 of `A-Z a-z 0-9 . _ : -`, starting with a letter or digit; Kelpie writes 16 hex digits | The memory's stable id (see below) | none |
| `kind` | a kind from the table above | What the memory is | the kind folder, else `note` |
| `scope` | `global`, or `agent/…`, `area/…`, `project/…`, `conversation/…` | Who the memory belongs to | the path's scope |
| `tier` | `episodic`, `semantic`, `procedural` | How long it is expected to matter; decay reads it (#111) | the kind's default |
| `level` | `explicit`, `deduced`, `inferred` | Said by the owner, deduced from what was said, or guessed | none |
| `confidence` | a number from 0 to 1 | How sure the writer was | none |
| `sources` | up to 20 strings, each one line of up to 300 characters | Where it came from: a wikilink to a vault note (`"[[2026-10-06-family-chat]]"`) or any reference, such as a message id | none |
| `entities` | names of up to 64 characters; at most 10 are kept | What the memory is about | none; a bad name drops that name only |
| `valid_from`, `invalid_at` | `YYYY-MM-DD`, or a date-time with an offset; a real calendar date, so `2026-02-30` is invalid | When the fact starts and stops being true in the world. A date is the start of that day in UTC, and `invalid_at` must come after `valid_from` | always valid |
| `evergreen` | `true` or `false` | Exempt from decay | `false` |
| `pinned` | `true` or `false` | Always loaded into the agent's core context, and exempt from decay | `false` |
| `abstract` | one line of up to 300 characters | A summary that retrieval can show before the whole note | none |
| `relations` | `contradicts:` and a list of wikilinks | Notes this one contradicts. The vocabulary is closed: any other key makes the whole field invalid | none |
| `updated` | a date-time with an offset | When this version was written | none |
| `title` | a string | Overrides the heading; Kelpie keeps it in step with the title when it is present | the first `# ` heading, else the file name |

How a file is read:
- **YAML 1.2.** Dates stay strings, and `yes`/`no` are strings, not booleans. Duplicate keys and aliases (`&a`/`*a`) make the frontmatter invalid. A frontmatter block longer than 16 KB is ignored, and so are the keys `__proto__`, `constructor` and `prototype`.
- **What one note may cost the index:** the first 262,144 characters of its body and its first 500 links are indexed, with a warning past either.
- **A BOM before the fence is dropped, and CRLF fences are accepted.**
- **Leniency.** An invalid value is ignored and noted as a warning, which the index keeps for lint. Invalid YAML leaves the note indexed with no frontmatter. A note is never dropped.
- **The path wins.** If `kind` disagrees with the kind folder, or `scope` with the path, the folder and the path win, with a warning: moving a file in Obsidian is how the owner reclassifies it.
- **Unknown keys are kept,** such as Obsidian's `aliases` and `tags`. Kelpie never removes them, and when it writes a new version it keeps them, with their comments, in their places.

How Kelpie writes a new version:
- **The input is the whole version.** A field Kelpie manages and the input leaves out is removed, and the body is replaced. A writer that keeps a field, such as a `pinned` the owner set in Obsidian, reads the note first and carries it over.
- **A file whose frontmatter can't be read is refused,** rather than rewritten without the owner's keys. Examples: a half-saved edit, a duplicate key, aliases, or more than 16 KB. The owner fixes it first.
- **Text fields are one line,** with no control characters and no bidirectional overrides, which can make a title read differently from what it holds.

### Identity and versions

- **A memory's identity is its path.** Each version written at a path supersedes the one before it, and removing the file ends the chain. Writing the path again continues the chain.
- **`id` is a content hash, taken once.** Kelpie mints it from the first version's scope, kind, title and body: the first 16 hex digits of a SHA-256.
  - Later versions keep it, so sources and relations can point at a memory whatever it says now.
  - Writing the same new memory twice produces the same file and the same id.
- **The index never trusts a hash stored in a file,** because an edit in Obsidian doesn't recompute one. It keys each version by its git blob SHA: the value GitHub's trees report, which is what lets the sync skip Kelpie's own commits (#41). The sync passes the SHA from the tree. Without it, the index computes it from the text, which matches git as long as the text was decoded without dropping a BOM.
- **A rename is a new chain in the index.** Git still has the history.

### Two kinds of time

- **World time** is `valid_from` and `invalid_at`: when a fact is true. Retrieval can ask for the memories valid at an instant.
- **Ingestion time** is when the vault started and stopped holding a version: the commit that wrote it and the commit that replaced it. "As of" questions use ingestion time. They answer what memory said then, not what was true then.
  - Committer times can go backwards, after a rebase or with a skewed clock, and two commits can share a millisecond. The index records each commit at least a millisecond after the one before, so every version's window has a start and an end in order.

## Session pages

Every conversation's history becomes session pages (#109), with no model call:
- **When:** a session ends when the conversation stays quiet for 30 minutes, or when a summary checkpoint is written ([ADR-0017](adr/0017-history-compaction.md)). The next message starts a new session.
- **Where:** `conversations/<channel>-<chat>/sessions/<year>/<date>-<time>-<first words>.md`. A group's chat id, which starts with `-`, becomes `g`.
- **What:**
  - a title, from the time and the first message;
  - a line with the channel, the date, the times (in the owner's time zone when known) and the number of messages;
  - each message as one line, with its time and speaker;
  - a session of more than 60 messages keeps the first 30 and the last 30.
- **Secrets:** every message's secrets are replaced with `[REDACTED:<kind>]` before anything is cut. That covers API keys and tokens, Telegram bot tokens, JWTs, private keys, credentials in URLs, auth headers and secret environment assignments. Then each message is cut to 280 characters. Nothing else is filtered: other people's data stays (ADR-0020 §4).
- **Trust:** `level: explicit`, since it is what was said, and `confidence: 0.9` for a private chat, `0.6` when more than one person spoke.
- **History:** once in a page, behind the latest checkpoint and older than 90 days, a conversation's history rows are deleted from its Durable Object.

## Links

- **Wikilinks:** `[[Ana Souza]]`, `[[Ana Souza|Ana]]`, `[[Ana Souza#Contact]]`, `[[Ana Souza#^block]]`, with `\|` inside tables.
  - A link without a `/` names a file, which Obsidian finds anywhere in the vault. Names may hold dots (`[[Node.js]]`, `[[Meeting 2026.10.06]]`).
  - A link with a `/` is a path from the vault's root, or from the note's folder when it starts with `./` or `../`.
- **Embeds:** `![[Recipe]]` is a link of its own kind. Links and embeds of attachments are skipped. An attachment is a file with an image, audio, video, PDF, canvas, base, office or archive extension, such as `![[photo.png]]` or `[[doc.pdf]]`.
- **Markdown links:** `[text](../places/lisboa.md)` must name a `.md` file and resolves from the note's folder. URLs, `mailto:` and images are skipped.
- **What else is skipped:** links in fenced code blocks and inline code, and same-note links (`[[#Heading]]`).
  - A fence may open on a list item or in a quote (``- ```sh``, ``> ```  ``).
  - Inline code that spans lines isn't seen as code.
- **Frontmatter links:** wikilinks in `sources` and in `relations.contradicts` become links of those kinds.
- **Resolution** follows Obsidian, against the vault's current notes, with names and paths compared in Unicode NFC:
  - a path names one note;
  - a file name matches case-insensitively;
  - when two notes share a name, the one in the linking note's folder wins, then the shorter path;
  - a link that matches nothing stays unresolved until a note with that name appears.

## Entities

Names are trimmed and their whitespace collapsed. A name that is empty, longer than 64 characters or holds control characters is dropped. Lookups use a key that is lowercase with diacritics folded, so "João" and "joao" are one entity. A note keeps at most 10, and duplicates by key are dropped.

## The index

The index is one SQLite database inside the Context Store's Durable Object ([ADR-0005](adr/0005-context-store.md)). It is built from commits, in order.

| Table | Holds |
|---|---|
| `commits` | Every commit applied, with its order and time |
| `versions` | One row per version of every indexed note: the commit that wrote it, its blob SHA, the commit it superseded, whether it is current, its ingestion window, and the parsed frontmatter and body. At most one current version per path |
| `versions_fts` | FTS5 over title, abstract, body and the path's words. It uses `unicode61 remove_diacritics 2`, so "acucar" finds "açúcar" |
| `entities` | Each version's entities |
| `links` | Each version's links, unresolved: they are resolved when read |
| `embeddings` | Vectors keyed by blob SHA and model; filled by retrieval (#110) |
| `meta` | The schema version |

- **Applying a commit:**
  - each changed file outside the index is skipped;
  - a file whose content is unchanged adds nothing;
  - a changed file adds a version and closes the previous one;
  - a removed file closes its current version.

  A commit applied twice is skipped, so a repeated webhook is harmless. Commits apply one at a time, in the order they arrive, and a rebuild runs alone: a commit that arrives during a rebuild waits for it. That holds within one index instance, so a Durable Object keeps one.
- **Rebuild:** dropping every derived table and replaying the vault's history gives the same index, row for row. That is tested.
  - Rebuilding from the head alone gives the same current notes, without their history.
  - Embeddings of content still in the history survive a rebuild: they are keyed by content, so they stay valid, and recomputing them costs model calls. Embeddings of content no longer in the history are deleted.
- **Erasure** is the operator's job (ADR-0020 §4): rewrite the vault's git history, then rebuild the index. The rebuild drops every version, link and embedding of the erased text.
- **Search:** current versions only by default. With `asOf`, it searches the versions the vault held at that instant. With `validAt`, it keeps only memories valid in the world at that instant. It returns 1 to 100 results, 10 by default.
- **A new schema version** drops the derived tables and starts empty, keeping the embeddings. The index then reports no last commit, which tells the sync to replay the vault from the start.

## Credits

The design follows [ai-memory](https://github.com/akitaonrails/ai-memory) at [`fc4da03`](https://github.com/akitaonrails/ai-memory/tree/fc4da03) (MIT, © 2026 Fabio Akita): versioned pages, FTS5 with diacritics folded, entity normalization, typed edges with a closed vocabulary, and link extraction that skips code. Files translated from it carry its notice. The reference check is on [#107](https://github.com/guedesdiogo/kelpie/issues/107#issuecomment-6010168197).
