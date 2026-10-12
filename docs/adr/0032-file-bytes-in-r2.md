# ADR-0032: Files that arrive on a channel keep their bytes in R2, behind a pointer note in the vault

- Status: Accepted
- Date: 2026-10-12
- Issue: [#156](https://github.com/guedesdiogo/kelpie/issues/156)
- Accepted by the owner in the conversation of 2026-10-12: «#156 (a) como recomendou»

## Context

[Story 4.17](https://github.com/guedesdiogo/kelpie/issues/157) turns a file the owner sends into memory: a pointer note whose body is the text derived from the file, such as an image's description, an audio transcript or a document as Markdown. The bytes need a home, and today Kelpie has none for them:
- ingress drops a message without text, a captioned photo included;
- the vault keeps `.md` files only, up to 1 MiB each and 2 MB per commit ([context-store.md](../context-store.md));
- no Worker binds R2.

Every option touches an earlier decision:
- [ADR-0016](0016-vault-second-brain.md): removing Kelpie loses no knowledge, and every index is derived from the vault.
- [ADR-0005](0005-context-store.md) rejected R2 as the context store, because R2 has no versioning.
- [ADR-0020](0020-shared-memory-engine.md): the vault is the single store. Erasure rewrites git history and calls `forgetVaultPaths`, and neither reaches R2.
- Bytes in git would break the vault's `.md`-only rule and its size limits. Git would also keep them forever, which defeats erasure.

The reference check on #157 found that gbrain keeps a file's metadata and SHA-256 in a table and its bytes in cloud storage behind a pointer, and that Hermes hashes a source once to skip re-ingesting it.

## Decision

- **The bytes of a file that arrives on a channel go to R2.**
  - The bucket belongs to the Context Store, which is the only component that reads or writes context storage (ADR-0005). How ingress hands the bytes over is Story 4.17's.
  - The object key is the content's SHA-256, so a file sent twice is stored once.
  - The bucket is private and has no public URL.
- **The vault holds a pointer note per file**, under `files/`.
  - Its frontmatter holds the SHA-256, the MIME type, the size, the message the file came in, and the storage key.
  - Its body always holds the derived text. The knowledge lives in the note, so the vault keeps working without R2 and without Kelpie. Only the original bytes stay behind.
- **Files the owner puts in the vault stay in git**, as today. Kelpie never commits bytes.
- **Erasure covers both stores.** `forgetVaultPaths` also deletes the objects that the erased pointer notes named and that no other note names. The erasure runbook in `docs/context-store.md` gains that step with Story 4.17.
- **Export covers both stores.** `git clone` takes the knowledge. A later export command copies the bucket's objects next to the clone, under their keys, so that every pointer resolves.
- **An object lives as long as a note names it.**

This amends:
- **ADR-0016:** "removing Kelpie loses no knowledge" still holds for the derived text. The original bytes of channel files live in R2, and leave with the vault only through the export.
- **ADR-0020:** memory spans the vault and the R2 bucket of channel files. Erasure and export cover both.

## Consequences

- **Cost.** R2's free tier covers personal use: 10 GB-month of storage, 1 million Class A and 10 million Class B operations a month, and no egress fees. Above that, storage costs US$ 0.015 per GB-month.
- **GitHub and Obsidian show the pointer note and its text,** not the original image or recording, until the bytes are exported next to the clone.
- **Erasure spans two stores** through one command. The privacy notes say so.
- **Only the Context Store binds R2.**

## Alternatives considered

- **(b) Routing by size,** with small files in git and large ones in R2. The vault grows with binaries, and erasure still spans two stores.
- **(c) Bytes in git only.** The simplest to reason about. But binaries stay in the history forever, and the vault's write limits block most media.

## References

- [#156](https://github.com/guedesdiogo/kelpie/issues/156): the options and the owner's choice.
- [#157](https://github.com/guedesdiogo/kelpie/issues/157): Story 4.17 and its reference check (ai-memory, hermes-agent, invokta and gbrain).
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/), read on 2026-10-12.
