# ADR-0020: Kelpie's memory is its own engine on Workers, modelled on ai-memory, over the owner's vault

- Status: Accepted
- Date: 2026-10-06
- Issue: [#105](https://github.com/guedesdiogo/kelpie/issues/105)
- Accepted by the owner in the conversation of 2026-10-05 and 2026-10-06; his answers are quoted on [#105](https://github.com/guedesdiogo/kelpie/issues/105#issuecomment-6009731665)

## Context

[Research note 09](../research/09-shared-memory-systems.md) compared these options against the owner's criteria:
- Supermemory, Honcho and Mem0;
- the alternatives: ai-memory, Letta MemFS, Basic Memory, Hindsight and others;
- Kelpie's own plan.

The owner's criteria:
- one memory shared by several agents at once;
- full export with no lock-in;
- open source;
- memory that grows while context stays efficient.

None of the three products keeps readable canonical data with a full, re-importable export, and none runs on Workers. ai-memory (MIT) keeps Markdown in git as its truth, with a rebuildable index, and its design maps onto Workers (§7.1 of the note).

The owner then decided how Kelpie builds its memory, and how far it goes with other people's data.

## Decision

**1. Kelpie builds its own memory engine on Workers, modelled on ai-memory.**
- **What follows ai-memory's design:**
  - one writer;
  - retrieval that fuses several streams (RRF), with authority weights and a bounded rerank;
  - a version chain of superseded entries;
  - decay and expiry;
  - lint, dedup and a contradiction band;
  - dream (consolidation);
  - auto-improve proposals, staged and gated by confidence.

  Code may be translated from ai-memory, keeping its MIT notice.
- **What changes for a general personal assistant** (note 09, and the discussion on #105):
  - **scopes:** global, per agent, per area of life or work, per conversation. The "project" kind stays, for coding later;
  - **capture:** from chat turns rather than coding-tool events, with speakers attributed in group chats;
  - **kinds:** preferences, commitments, events, people, places, decisions, procedures, notes;
  - **time:** validity windows on facts, and dates resolved by arithmetic rather than by the model;
  - **evergreen facts** that don't decay;
  - **reasoning about the owner and about the agent itself:** conclusions with a level (explicit, deduced, inferred), their sources and a confidence, in the manner of Honcho.
- **Kelpie isn't format- or API-compatible with ai-memory.** It doesn't use ai-memory's UUID scopes or serve its HTTP endpoints. The owner chose «formato nosso».
- **A periodic routine reviews ai-memory's changes** and opens an issue with what is worth adapting. It is created when implementation starts.

**2. The vault is the single source of truth, in Kelpie's own human-readable format.**
- The vault is Markdown in the owner's private git repo, with ADR-0016's layout extended with memory kinds.
- Every index (Durable Object SQLite with FTS5, Vectorize) is derived from it and can be rebuilt.
- **Versioning:**
  - a file holds only the current version of a memory;
  - git holds every version, so an old one can be restored, even if only by hand;
  - the index keeps superseded entries, marked not current and pointing at their commit, so "what was true as of" can be answered without walking git history.

**3. One writer.** The Context Store's Durable Object serializes every write to the vault, whoever makes it ([ADR-0005](0005-context-store.md)).

**4. Other people's personal data lives in the vault, like everything else.**
- **The owner's terms:** this is for personal use, possibly including work matters, still for personal use.
- **No erasure machinery.** Erasing someone means rewriting git history, which is possible but painful, and is the responsibility of whoever runs Kelpie. In the owner's words: «deixamos isso com responsabilidade de quem estiver usando o kelpie».
- **The sanitizer remains for secrets and credentials only.** No personal-data gate blocks third-party data from the vault.
- **[ADR-0018](0018-jev-direct-api.md)'s masking stays.** It concerns data sent to TypeSafe, not where memory is stored.

**5. Approval is configurable, per item and per agent.**
- **What it covers:** the persona (`SOUL.md`), the rules (`AGENTS.md`) and the skills. Only the owner configures it.
- **The rule for a proposed change:**
  - below the confidence floor, it isn't applied;
  - above it, it is applied directly when that item's approval is off, or opened as a pull request for the owner when it is on.
- **Default:** approval on for all three. An evaluation gate joins the rule once the memory evaluation exists.
- **Everything else** (facts, preferences, episodes, the conclusions about the owner and the agent, consolidation) is written autonomously, through the sanitizer and supersession. Git keeps every version.

**6. Scope of the first version.**
- **Included:** Kelpie, GitHub and Obsidian (through obsidian-git and the push webhook, ADR-0005).
- **Later:** Hermes, OpenClaw and any external MCP access; external engines, a derived index behind the Context Store's interface, of high interest to the owner.
- Kelpie stays single-player ([ADR-0015](0015-single-player-first.md)).

**Starting values, tunable by the stories and not binding here:**
- the context layers (an always-loaded core, the conversation, a retrieved slice, on-demand tools) and their token budgets;
- RRF's k;
- the authority weights;
- the confidence floor (ai-memory uses 0.75);
- the decay rates;
- the dream's triggers.

This amends:
- **[ADR-0005](0005-context-store.md):** "Personal data never enters the repository" no longer holds. "Persona, rules and skills change only through pull requests a human approves" becomes the configurable approval of point 5.
- **[ADR-0006](0006-personal-data-storage.md):** profiles, facts and episodes about people move from the per-user Durable Objects into the vault. The erasure workflow and the personal-data gate before git are dropped.
- **[ADR-0016](0016-vault-second-brain.md):**
  - Kelpie's writes may put third parties' data in the vault;
  - an agent may change its own persona, rules or skills when that item's approval is off, still subject to the confidence floor;
  - sharing with other agents goes through the single writer. The symlink-and-git-sync mechanism for Hermes is dropped, and Hermes is deferred.
- **[ADR-0017](0017-history-compaction.md):** its reference to an erasure workflow (ADR-0006) no longer applies.

## Consequences

- **Export is the vault.** `git clone` takes the whole memory, people included, with its history.
  - Conversation transcripts and summary checkpoints (ADR-0017) remain operational state in the conversation Durable Objects. What they hold of lasting value reaches the vault through session summaries and dream.
  - A command to export transcripts is left for a later story.
- **One store, not two.** No per-user Durable Objects for memory, and no export bundling.
- **The law.** [LGPD art. 4, I](https://modeloinicial.com.br/lei/LGPD/lei-geral-protecao-dados-pessoais/art-4) exempts processing only "para fins exclusivamente particulares e não econômicos". Notes about work may fall outside that, which is why the risk sits with whoever runs Kelpie.
  - The public repo's README says so, and says that erasure means rewriting git history.
  - The viability study's second blocker (user profiles can't live as versioned Markdown) no longer applies to Kelpie run for personal use.
- **Model providers still receive conversation content under their own terms,** whatever the memory does. The privacy notes keep saying so.
- **Following ai-memory costs a routine and some judgment.** Upstream moves fast: it was created in May 2026 and already has 71 migrations.
- **Memory poisoning.** With approval off, the confidence floor and git's history are the only guards on persona, rules and skills. The default keeps approval on.
- **Hermes and OpenClaw get no shared memory in the first version.** When they come, note 09 §8 describes the integration paths: a Hermes memory provider with per-turn prefetch, and OpenClaw through MCP and `extraPaths`.

## Alternatives considered

- **A product as the store** (Supermemory, Honcho, Mem0): none has readable canonical data with a full export (note 09 §2).
- **Running ai-memory itself** (option C): it needs a 24/7 host outside Cloudflare.
- **A compatible port of ai-memory** (option E): its UUID scopes and HTTP endpoints would have kept its binary as an escape hatch and its Hermes and OpenClaw plugins working, at the cost of readability. The owner chose our own format.
- **Keeping people's data out of git** (ADR-0006, option a), **or encrypting it per person** (option c): erasable, but with two stores or key management. Not needed for personal use, in the owner's judgment.

## References

- [Research note 09](../research/09-shared-memory-systems.md), §7.1 (ai-memory on Workers) and §8–§10
- [ai-memory at `fc4da03`](https://github.com/akitaonrails/ai-memory/tree/fc4da03), MIT
- [#103](https://github.com/guedesdiogo/kelpie/issues/103), [#105](https://github.com/guedesdiogo/kelpie/issues/105)
