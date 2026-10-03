> Research note written on 2026-10-03 for the Kelpie viability study, translated from Portuguese. Corrections across notes are tracked in [00-cross-check.md](00-cross-check.md).

# 02 — Memory, learning and context

> Read-only research, done on 2026-10-03. Primary sources: the ai-memory code (commit `d48a20d`, 2026-10-03), the hermes-agent code (commit `5d3c059`), official documentation, papers and the Cloudflare docs (via the documentation MCP).
> **Conventions.** Everything I did not confirm in a source during this session is marked **(unverified)**. What is my own proposal, without a source, is marked **(proposal)**. Benchmark numbers are the ones the authors themselves publish, unless stated otherwise.

---

## TL;DR

- **ai-memory already solves the shape of the problem.** The truth lives in a markdown wiki versioned in git. A derived SQLite index (FTS5 + entities + link graph + optional vectors) answers searches. Capture comes from hooks, without an LLM. Consolidation is optional and runs off the hot path. There is an audited self-improvement loop: proposals with evidence, a confidence floor, staging in `_pending/` and optional human approval. Forgetting uses decay by tier, and a page is only replaced by supersession, never deleted directly. **It also already has a JEV adapter, measured** as a memory reranker. With `choice`, hit@1 reaches 0.78–0.81, against 0.64 and 0.60 in the rubric format on the same models, with 0.75–1.2 s average latency ([jev-reranker-adapter.md](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/jev-reranker-adapter.md)).
- **What cannot be copied from ai-memory:**
  - It is **single-tenant**, with multi-user attribution. Inside a project, `author_id` does not filter reads, by design ([security-boundaries.md](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/security-boundaries.md)). In our harness, this would be leakage between users.
  - It is a Rust binary with a filesystem, git2, a watcher and a single-process SQLite, and none of that runs on Workers.
  - Its domain is coding agents, not conversations with end customers.
- **The state of the art has converged on "versioned markdown files + derived index + background consolidation".** Examples:
  - Letta moved the center of the product to **MemFS**, one git repository per agent, with `.md` + frontmatter and `skills/<name>/SKILL.md`. A "dreaming" process in subagents with worktrees consolidates memory in the background ([Letta MemFS](https://docs.letta.com/concepts/memfs/index.md)).
  - Hermes uses `MEMORY.md`/`USER.md` with a character limit and skills in the agentskills.io standard ([Hermes memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)).
  - Anthropic's memory tool is a `/memories` directory whose storage the application implements ([memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)).
- **Contradictions:** the consensus is to **invalidate or supersede instead of deleting**. Zep marks `t_invalid` in a bi-temporal graph ([arXiv:2501.13956](https://arxiv.org/abs/2501.13956)). Mem0g marks the relation as invalid ([arXiv:2504.19413](https://arxiv.org/html/2504.19413)). ai-memory keeps a `supersedes` chain. Base Mem0 still does `DELETE`.
- **Proposed taxonomy (5 types):**

  | Type | What it is | Where it lives |
  |---|---|---|
  | Working | conversation buffer | DO per conversation |
  | Episodic | conversation summaries | hot store, deletable |
  | Semantic | facts | `.md` with supersession |
  | Procedural | skills | `SKILL.md` in git, with staging |
  | Identity | persona (git) and user profile | the profile lives in the hot store, deletable, **never in git** |

  The structural rule: **anything personal does not go into git**, because the immutable history conflicts with the right to erasure. ai-memory itself admits that its purge "is not erasure", since the content remains in the git objects ([lifecycle-ops.md](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/lifecycle-ops.md)).
- **JEV as gatekeeper.** Instead of a generative LLM, JEV makes the typed decisions on the memory path:
  - `noul` decides whether the turn needs memory;
  - `score` on a rubric gives the absolute score to include or cut a memory;
  - `choice` ranks and picks the skill;
  - `choice` also picks between ADD/UPDATE/SUPERSEDE/NOOP on write.

  The caveat measured in ai-memory: the `choice` probabilities are only good for **ordering** and change scale with the number of candidates. Thresholds are done with `score` or `noul`.
- **Biggest risks:**
  1. memory poisoning by injection, even without direct access to memory, as MINJA shows ([arXiv:2503.03704](https://arxiv.org/abs/2503.03704)), made worse in WhatsApp, Discord and Slack groups;
  2. leakage across tenants, users and groups;
  3. PII in git;
  4. growth of the "always loaded" context, which lowers adherence;
  5. the cost of one LLM call per closed conversation.

---

## 1. ai-memory in detail

**Source:** [github.com/akitaonrails/ai-memory](https://github.com/akitaonrails/ai-memory), commit `d48a20d` (2026-10-03). It is Rust, version 2.5.2, MIT license, author Fabio Akita ([Cargo.toml](https://github.com/akitaonrails/ai-memory/blob/d48a20d/Cargo.toml)). It has about 322 thousand `.rs` lines in 11 crates, counted with `wc` in the clone. The project itself defines itself as "long-term memory for coding agents": you leave Claude Code in the middle of a task, open Codex in the same directory and carry on ([README](https://github.com/akitaonrails/ai-memory/blob/d48a20d/README.md)).

### 1.1 Capture

- **Lifecycle hooks, not "remember this" calls.** The harnesses emit `SessionStart`, `UserPromptSubmit`, `PostToolUse` and other events. The server normalizes everything into a **closed vocabulary**: `session-start`, `user-prompt`, `pre/post-tool-use`, `pre-compact`, `post-compaction`, `notification`, `stop`, `session-end` and `other`. An unknown event does not create a new type ([ARCHITECTURE.md §Hook event vocabulary](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/ARCHITECTURE.md)).
- **Fire-and-forget.** The hook script has a timeout of ≤200 ms. The server answers 202 immediately, or 429 when saturated. The native command spools locally with an idempotency key (invariant #5 in [ARCHITECTURE.md §Cross-cutting invariants](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/ARCHITECTURE.md)).
- **Typed sanitization boundary.** `Sanitized<NewObservation>` can only be constructed by `sanitize()`, so no path persists raw text ([sanitize.rs](https://github.com/akitaonrails/ai-memory/blob/d48a20d/crates/ai-memory-core/src/sanitize.rs)). The sanitizer redacts:
  - bearer tokens and keys from several vendors;
  - PEM keys and credentials embedded in URLs;
  - `*_KEY=` patterns;
  - escape sequences and bidi overrides, which are removed.

  The code itself documents what it does **not** catch: high-entropy strings without structure.
- **Limits.** The prompt and the post-compaction summary are cut at 16 KiB; tool excerpts, at 2 KB. There is also a 16 KiB cap per observation after redaction ([ARCHITECTURE.md](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/ARCHITECTURE.md)).
- **Capture exclusions on the client.** Files that a marker file says to ignore do not enter the spool, the transport or the storage ([security-boundaries.md #11b](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/security-boundaries.md)).

### 1.2 Storage

- **Two layers and a single source of truth.**
  - `<data_dir>/wiki/` contains markdown in a `git2` repository. Each end of session and each consolidation produces a commit. The wiki can be edited in Obsidian or vim, and a watcher reconciles the external edits.
  - `<data_dir>/db/memory.sqlite` is a **derived index**, rebuildable from the files ([ARCHITECTURE.md §Storage architecture](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/ARCHITECTURE.md)).
- **Relevant tables.**

  | Table | What it stores |
  |---|---|
  | `pages` | page versions, with `is_latest` and the `supersedes` chain, `access_count`, `last_accessed_at`, `salience` and `expires_at` |
  | `pages_fts` | FTS5 index of the pages |
  | `observations` | captured observations, plus `observations_fts` as a fallback |
  | `links` | links between pages, including across projects |
  | `entities` | entity index derived from the frontmatter |
  | `page_feedback` | `helpful`/`not_helpful`/`stale`/`wrong` signals |
  | `page_evidence` | sessions that support each version, used to compute *belief strength* |
  | `auto_improve_proposals` | self-improvement proposals |
  | `audit_log` | every mutation |

- **UUID-isolated layout.** The path is `<wiki_root>/<workspace_id>/<project_id>/{concepts,decisions,gotchas,procedures,sessions,_rules,_slots,...}`. The human-readable name never appears in the path ([lifecycle-ops.md §What "project isolation" means](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/lifecycle-ops.md)).
- **OKF v0.2 format.** Since 2.0, every page is a file conforming to the *Open Knowledge Format*. The frontmatter fields are:
  - `type`, `generated: {by, at}`, `sources` and `stale_after`;
  - plus extensions: `tier`, `kind`, `slot_kind`, `entities`, `pinned`, `session_id` and `expires_at`.

  Normalization is deterministic and runs at a single choke point ([okf.md](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/okf.md)). I did not read the OKF specification directly, only ai-memory's description of it **(unverified)**.
- **Pinned slots.** Pages in `_slots/` are pinned, appear in the briefing and declare `slot_kind: state`, which is mutable, or `slot_kind: invariant`, high-resistance: identity, rules and preferences. Consolidation only rewrites an `invariant` in the face of a direct contradiction.
- **Special scopes.**
  - `[slots] per_user = true` creates a namespace per authenticated user. The text itself warns that this "limits prompt injection, not page access".
  - There is a reserved `_global` scope for user preferences, open for reading and restricted for writing ([ARCHITECTURE.md](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/ARCHITECTURE.md); [security-boundaries.md #1c](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/security-boundaries.md)).

### 1.3 Consolidation

1. **End of session without an LLM.** `SessionEnd` generates `sessions/<id>.md` by rules and opens a typed *handoff* for the next agent, all in a single SQLite transaction. Then it commits the wiki.
2. **With an LLM provider configured**, a durable queue (`session_consolidation_jobs`, with lease, retry and backoff) rewrites the summary as a rich page, or spreads it over several pages in `concepts/`, `decisions/` and `gotchas/`. The output uses only structured JSON-schema (invariant #7).
3. **"Dream pass"**: optional LLM, off by default. It groups cold pages with DBSCAN over embeddings and rewrites each cluster into a coherent page. **It never deletes the source**: the merged members are replaced by stubs and `page_evidence` records who fed the merge. It only runs after an idle window and cancels when activity returns. It starts with the most "surprising" clusters ([ARCHITECTURE.md](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/ARCHITECTURE.md)).

### 1.4 Retrieval

- `memory_query` fuses FTS5, entity matching and link neighbors with **RRF**, and adds vector cosine when there is an embedder.
- It then applies an **authority multiplier** bounded to `[0.55, 1.50]`. It weighs type, tier, `pinned` and tags, favors rules, decisions, procedures and gotchas in close contests, and "no query-intent regex takes part".
- There is an optional LLM reranker:
  - it receives at most 30 candidates and makes one call per query, with up to four in parallel;
  - any failure preserves the local order.
- **Raw fallback:** if no compiled page matches, the search goes to the observations FTS.
- **Access reinforcement:** the page that is read gets `access_count++`, limited to once per minute, on all read paths.
- `memory_briefing` assembles the session-start context: counts, rules, slots, up to 10 pinned pages and, optionally, `settled_first` with the rules and decisions with the most evidence ([ARCHITECTURE.md §MCP tool surface](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/ARCHITECTURE.md)).

### 1.5 Review and learning ("auto-improve")

- **Trigger.** With an LLM configured, a scheduler reviews recently finished sessions outside the hook latency. The defaults in the code are `interval_secs = 3600`, `max_sessions_per_tick = 1` per project and `min_session_age_secs = 600` ([config.rs `AutoImproveSchedulerSettings::default`](https://github.com/akitaonrails/ai-memory/blob/d48a20d/crates/ai-memory-cli/src/config.rs)).
- **Output.** JSON with `proposals[]`, each with `operation`, `path`, `kind`, `confidence`, `rationale`, `evidence[{page, quote}]` and `body_markdown`, plus `rejected_candidates[]` ([§Proposal Format](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/auto-improvement-loop.md)).
- **Validation before staging.** The code rejects a proposal with confidence below `min_confidence` (0.75 by default), without evidence, with the wrong path prefix, a body that is too large or a protected target ([auto_improve.rs `validate_proposal`](https://github.com/akitaonrails/ai-memory/blob/d48a20d/crates/ai-memory-consolidate/src/auto_improve.rs)). The default limits, checked against the `DEFAULT_AUTO_IMPROVE_*` constants in the same file:
  - at most 5 proposals per run;
  - `max_input_tokens = 24000`;
  - a minimum of 8 observations and 120 s of session.
- **Staging and approval.** The proposal becomes a readable sidecar in `_pending/auto-improve/` and a row in the `pending-writes` trail. It is **auto-approved by default**. On a shared server, the doc recommends `require_approval = true`.
- **Evaluation gate.** The `[auto_improve.eval]` is executable, optional and by default covers `_rules/` and `procedures/`. It receives the before and the after and must return `{score_before, score_after, passed}`, with a minimum delta.
- **Rejection buffer.** The rejections from the last 180 days, up to 50, go into the following prompts so the idea does not come back.
- **Separate actor.** Proposals are attributed to the `auto_improve` actor in the audit log.
- **Explicit negative filters.** The reviewer discards:
  - sessions without activity and smoke tests;
  - release markers;
  - transient setup failures;
  - **broad statements of the type "tool X is broken"**, which turn into future refusals after X is fixed;
  - single-task narratives ([§Negative Filters](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/auto-improvement-loop.md)).
- **Experience pass.** It is optional and reads the last N session summaries side by side to propose patterns across trajectories. **It requires evidence in at least two named sessions** ([experience.md](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/experience.md)).
- **Curator.** It is rule-based maintenance and **only produces a report**: duplicates, old slots, cold pages and broken links. It never deletes semantic pages.
- **`memory_feedback`.** `helpful` and `not_helpful` adjust salience; `stale` and `wrong` zero it and generate a lint finding.
- **`memory_lint`.** It includes a contradiction detector **without an LLM**: cold pages with cosine in the 0.4–0.75 band, that is, same topic but not a duplicate, get an advisory "the newest wins" finding. The doc warns that, in a single-domain corpus, the band measures domain proximity and generates noise.
- **Promotion to rules in AGENTS.md.** It is an **unimplemented design** ([design-rules-promotion.md](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/design-rules-promotion.md)):
  - AGENTS.md is a scarce budget: the doc proposes at most about 15 rules, or 40 lines;
  - promotion is **subtractive**, that is, to admit a rule another must be removed;
  - only human commands edit the file, never an automatic side effect;
  - the doc says models follow about 150 to 200 instructions well and that adherence drops by more than 30% after about 200 lines. This comes from a "2026 consensus" that it cites **(unverified)**.

### 1.6 Forgetting and retention

- **Retention formula** ([decay.rs](https://github.com/akitaonrails/ai-memory/blob/d48a20d/crates/ai-memory-store/src/decay.rs); [ARCHITECTURE.md §Memory tiers](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/ARCHITECTURE.md)):

  `salience·e^(−λΔt) + σ·log(1+access_count)·e^(−μ·days_since_access)·(1 + breadth_weight·ln(1+max(actors−1,0)))`

  λ can vary by tier, with half-life in days.
- **Tiers.**

  | Tier | Policy |
  |---|---|
  | *Working* | discarded at the end of the session |
  | *Episodic* | 30 days hot, 180 days cold, then eviction, or optional extractive compaction |
  | *Semantic* | indefinite; only replaced by rewriting |
  | *Procedural* | decays by frequency |

  Pinned pages are exempt.
- **Daily forget sweep.**
  - A page with an expired TTL (`expires_at`) is really deleted, file and rows, even if pinned.
  - An episodic page with retention below `cold_threshold` (0.20) becomes a tombstone.
  - Tombstones are removed after `hard_delete_after_days = 180`.
  - Pruning of raw observations is optional and only applies to sessions already consolidated ([DATA_HANDLING.md](https://github.com/akitaonrails/ai-memory/blob/d48a20d/DATA_HANDLING.md)).
- **Extractive compaction (A2)**, off by default. A cold episodic page is rewritten keeping the summary, the first paragraph and "keep-tokens" (paths, URLs, error codes, identifiers). Without an LLM and reversible.
- **Purge is not erasure.** `purge-session` is **logical**. The text remains "in the wiki's git history" and in backups, and `--compact` "is not forensic erasure" ([lifecycle-ops.md, purge-session](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/lifecycle-ops.md); [deploy.md](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/deploy.md)). The README says "nothing is deleted for good: the original stays in git".

### 1.7 Integration

- **MCP with 23 tools**: `memory_query`, `memory_read_page`, `memory_briefing`, `memory_write_page`, `memory_feedback`, `memory_auto_improve`, claim-once handoffs, messages between projects and others ([ARCHITECTURE.md §MCP tool surface](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/ARCHITECTURE.md)).
- **Hooks for more than 20 harnesses**, among them Claude Code, Codex, Cursor, Gemini CLI, OpenCode, Kiro and Hermes ([support-matrix.md](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/support-matrix.md)). In Hermes, the session cycle comes from a community-maintained memory plugin.
- **"Managed Agent Skills".** These are static `SKILL.md` files that teach the agent *when* to call the MCP tools, installed together with a snippet in CLAUDE.md/AGENTS.md. The doc itself calls this a "prompt-packaging exception": skills are **not** output of self-improvement. Its durable unit is the wiki page ([auto-improvement-loop.md](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/auto-improvement-loop.md)).

### 1.8 JEV inside ai-memory

This is the most concrete primary source I found on the JEV API ([jev-reranker-adapter.md](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/jev-reranker-adapter.md); [jev_rerank_shim_choice.py](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/examples/jev-reranker-adapter/jev_rerank_shim_choice.py)):

- **Call format.** It is a `POST /v1/systemone` with `{"model", "state": "<text>", "questions": {"best": {"type": "choice", "instructions": "...", "criteria": {"c1": "...", ...}}}}`. The response comes as `answers.best.probabilities.{c1: p, ...}`. The rubric format uses `type: "score"` with 4 levels, mapped to 0 / 0.3 / 0.7 / 1.0. The rubric adapter file (`jev_rerank_shim.py`), cited in the doc, is **not** in the directory of this commit; only `_choice` exists.
- **Offline benchmark.** 102 queries, golden set from a real wiki.

  | Reranker | hit@1 | NDCG@10 | Latency |
  |---|---|---|---|
  | No rerank | 0.495 | 0.739 | — |
  | Hosted reasoning model | 0.778 | 0.875 | 20.2 s, equal to the 20 s timeout; in production it always timed out |
  | JEV via adapter | 0.778 | 0.873 | 0.205 s |

- **End to end, with `choice`:**
  - 35B (Qwen3.6-35B-A3B): hit@1 0.778, against 0.636 with rubric;
  - 4B *replay-trained*: hit@1 0.808, against 0.596 with rubric;
  - average latency of 0.75 to 1.16 s.
- **Caveat that applies to us:** the `choice` probabilities "carry only ordering information", with a winner at ≈0.99 and the rest at ≈0.001, and the scale changes with the number of candidates. They serve a consumer that **only ranks**. For a threshold, fusion or absolute score logging, use the rubric.

Additional public material on JEV, from vendor sources:

- JEV is a "System One model": unstructured state goes in, probabilistic typed decisions come out, with **three primitives**: `choice`, `score` and `noul` (yes/no) ([OpenRouter — Jev](https://openrouter.ai/docs/guides/community/jev)).
- The context window is **32,000 tokens** for state + questions, and the output is free ([OpenRouter — Jev](https://openrouter.ai/docs/guides/community/jev)).
- The vendor claims 70–500 ms latency, US$ 0.042 per million input tokens and "calibrated" probabilities ([TypeSafe blog, 2026-09-28](https://typesafe.ai/blog/introducing-system-one-models-and-jev)). Calibration is a vendor claim **(not independently verified)**.
- **Two diverging API surfaces.**

  | Origin | Endpoint | `questions` | Choice declares |
  |---|---|---|---|
  | ai-memory shim | `POST /v1/systemone` | named object | `criteria` |
  | OpenRouter | `POST /api/alpha/decisions` | array | `options` |

  It may be an old version against a new one, or a self-hosted server against a gateway. Which surface is the current and canonical one **(unverified)**: check the API reference before implementing.

### 1.9 What is original there and worth bringing over

1. **Markdown as the source of truth and the index as a rebuildable derivative.** The invariant "indexes commit in the same transaction as the data" (#3) avoids an out-of-sync index.
2. **Supersession instead of deletion** (`is_latest` + `supersedes`), with `restore-page`. The loser of a concurrent write remains reachable.
3. **Default path without an LLM.** Capture, search and handoff work without a key. The LLM is opt-in at each step, which is good for cost and testability.
4. **Audited self-improvement.** Proposal with cited evidence, confidence floor, size limits, rejection buffer, distinct actor in the audit log and `require_approval` separate from scheduling.
5. **Negative filters** against "false constraints".
6. **`state` vs `invariant` slots** to separate mutable context from identity and rules.
7. **Bounded authority multiplier and decay by tier with access reinforcement.** What is used decays more slowly.
8. **Confidence by breadth.** *Belief strength* based on distinct sessions that support the page, and not on the raw number of occurrences.
9. **A security-boundary map with an adversarial test per boundary**: try the violation, assert the refusal and have a legitimate control case ([security-boundaries.md](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/security-boundaries.md)).
10. **JEV adapter with a benchmark and correct failure semantics.** If the judge goes down, search becomes "without rerank", never "without search".
11. **Honesty about purge** and prompts that treat all stored content as "untrusted data" ([SECURITY.md](https://github.com/akitaonrails/ai-memory/blob/d48a20d/SECURITY.md)).

**What does not serve directly:**

- **Single-tenant.** Pages are shared within the project and `author_id` "is never a read filter".
- **The durable unit is the wiki page, not the skill.** The opposite of what we want for procedural memory.
- **Capture by IDE hooks.** In our case, capture is the channel's own message pipeline.
- **Unviable runtime.** A single process with a filesystem and local git is not viable on Workers.

---

## 2. Comparison

### 2.1 Table

| System | Source of truth | Human edits? | When it writes | How it retrieves | Contradiction / forgetting | Skills / procedural | Integration |
|---|---|---|---|---|---|---|---|
| **ai-memory** | Markdown wiki in git + derived SQLite ([ARCH](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/ARCHITECTURE.md)) | Yes (Obsidian; watcher reconciles) | Hooks on the hot path (observation only); consolidation and auto-improve in background | FTS5 + entities + graph (RRF) + optional vector + authority + optional LLM/JEV rerank | Supersession; contradiction lint by cosine band; decay by tier; TTL; tombstones | `procedures/` and `_rules/` pages; SKILL.md only for routing | MCP (23) + hooks (20+) |
| **Letta (MemFS + blocks + dreaming)** | Git repo per agent with `.md` and `name`/`description` frontmatter ([MemFS](https://docs.letta.com/concepts/memfs/index.md)) | Yes (real checkout) | Agent edits on the hot path; *dreaming* in subagents (worktrees) after N steps or at compaction ([memory](https://docs.letta.com/configuration/memory)) | Files at the root go into the system prompt every turn; subdirectories with `MEMORY.md` stay out until read; no vector index by default (optional mod) | Git commits; `/doctor` audits duplication and tokens | Versioned `$MEMORY_DIR/skills/<name>/SKILL.md` | SDK, CLI and channels (Telegram, WhatsApp, Slack, Discord, Signal) ([llms.txt](https://docs.letta.com/llms.txt)) |
| **Letta memory blocks** | Labeled blocks in context (`label`, `value`, `description`, `limit`, `read_only`) ([blocks](https://docs.letta.com/guides/agents/memory-blocks)) | Via API | Agent edits with tools | Always in context, no retrieval | Character limit per block | — | Blocks shareable across agents |
| **Mem0** | Atomic facts in a vector DB; Mem0g adds a graph ([paper](https://arxiv.org/html/2504.19413)) | No (rows) | Per-turn extraction (conversation summary + last 10 messages) | Vector search of the top-s similar | LLM chooses **ADD / UPDATE / DELETE / NOOP**; Mem0g marks relations as invalid | — | SDK and API |
| **Zep / Graphiti** | Temporal graph with episode, semantic and community subgraphs ([paper](https://arxiv.org/abs/2501.13956)) | No | LLM ingestion with structured output ([repo](https://github.com/getzep/graphiti)) | Semantic + BM25 + graph traversal | **Bi-temporal** (`t_valid`/`t_invalid`): invalidates, does not delete | — | SDK and MCP server; Neo4j, FalkorDB, Neptune |
| **LangMem** | LangGraph store with hierarchical namespaces ([guide](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)) | No | **Hot path** ("conscious") or **background** ("subconscious") | Semantic + metadata filter | Collections vs profile (single document with schema) | **Procedural = system prompt optimization** from feedback | Library |
| **Anthropic memory tool** | `/memories` directory in **client-implemented** storage ([docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)) | Yes (they are your files) | The model decides (`view`, `create`, `str_replace`, `insert`, `delete`, `rename`) | The model reads on demand; injected prompt: "ALWAYS VIEW YOUR MEMORY DIRECTORY..." | The doc recommends expiring files that are not accessed and limiting size | — | `{"type":"memory_20250818","name":"memory"}`; combines with compaction |
| **Agent Skills (agentskills.io)** | Folder with `SKILL.md` (frontmatter `name` ≤64, `description` ≤1024) + `scripts/`, `references/`, `assets/` ([spec](https://agentskills.io/specification)) | Yes | Human or agent authoring | **Progressive disclosure**: ~100 tokens of metadata at the start; body <5000 tokens on activation; resources on demand | — | It is the standard | Claude Code, Codex, Gemini CLI, Cursor, Letta, Hermes, OpenClaw, nanobot and others ([home](https://agentskills.io/home)) |
| **Basic Memory** | Local markdown + SQLite or Postgres index ([repo](https://github.com/basicmachines-co/basic-memory)) | Yes (Obsidian with no configuration) | The agent writes via MCP | FTS + vector (FastEmbed) + optional rerank; `memory://` URLs and `build_context` | — | — | 14 MCP tools; AGPL-3.0; cloud at US$ 15/month |
| **AGENTS.md** | One markdown at the root and nested ones ([agents.md](https://agents.md/)) | Yes | Human | "The closest file in the tree takes precedence" | — | Instructions, not skills | More than 60 thousand projects; maintained by the Agentic AI Foundation (Linux Foundation) |
| **Hermes Agent** | `MEMORY.md` (2,200 characters) + `USER.md` (1,375 characters) + SQLite FTS5 of sessions ([config_defaults.py](https://github.com/NousResearch/hermes-agent/blob/5d3c059/hermes_cli/config_defaults.py)) | Yes | `memory` tool on the hot path (add/replace/remove); periodic review (`nudge_interval: 10`); **frozen snapshot** at the start of the session ([docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)) | Memory always in the prompt; `session_search` on demand; external providers (Honcho, Mem0…) | An error when the limit is exceeded forces consolidation; anti-injection scan on entries | `skill_manage` (create/patch/delete…) in the agentskills.io standard; curator; optional staging ([skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)) | Gateway for Telegram, Discord, Slack, WhatsApp and Signal |
| **Cloudflare Agents SDK — Sessions** (stack reference) | The Durable Object's SQLite ([docs](https://developers.cloudflare.com/agents/runtime/lifecycle/sessions/)) | Via code | Hot path; non-destructive compaction | FTS5 (porter + unicode); `session_search` tool | Compaction protects the recent messages (20K tokens by default) | "Context blocks" with `maxTokens`; `SkillProvider` with `load(key)` | Native to our stack |

### 2.2 What to take from each

- **Letta MemFS** is the model closest to our requirement "everything in versioned and reusable `.md`".
  - One git repository **per agent**.
  - Files at the root go into the prompt **on every turn**. Directories with a `MEMORY.md` index stay out of the context and work as signposts.
  - Skills live inside the memory.
  - Maintenance subagents use *worktrees* so they do not block the main agent ([MemFS](https://docs.letta.com/concepts/memfs/index.md)).
  - Dreaming may require the main agent to review the proposals before applying them, which costs extra tokens ([sleeptime](https://docs.letta.com/guides/agents/architectures/sleeptime)).
  - The sleep-time compute paper shows about 5× less test-time compute at the same accuracy, and +13% to +18% accuracy when scaling offline compute ([arXiv:2504.13171](https://arxiv.org/abs/2504.13171)). The gain depends on how predictable the questions are.
  - Letta also showed 74.0% on LoCoMo just by storing the history in files ([Letta blog, 2025-08-12](https://www.letta.com/blog/benchmarking-ai-agent-memory)). Lesson: the agent's ability to *find* the information weighs more than the sophistication of the store.
- **Mem0.** The update loop with four operations is **a natural typed `choice` for JEV**. We would swap `DELETE` for `SUPERSEDE`, as Mem0g itself does by marking the relation as invalid. The paper's numbers are the author's own: −91% p95 latency and more than 90% token savings against full context ([arXiv:2504.19413](https://arxiv.org/abs/2504.19413)).
- **Zep/Graphiti.** Bi-temporal validity: "when it was true in the world" versus "when we observed it". For us, `valid_from`/`valid_to` in the frontmatter of the facts and on the edges is enough, with no graph database. Author's results: DMR 94.8% against MemGPT's 93.4%; up to +18.5% on LongMemEval with −90% latency ([arXiv:2501.13956](https://arxiv.org/abs/2501.13956)).
- **LangMem.** The semantic/episodic/procedural vocabulary. The distinction between hot path and background. **Profile** as a single document with a schema, next to a **collection** of facts. Procedural memory as *prompt optimization*: we would apply this to the skills and to the rules block ([guide](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)).
- **Anthropic memory tool.** A standardized file interface, with six commands and the backend under our control, which can map `/memories` to R2 or to the per-user DO. The security cautions come documented: path traversal, size, expiration and sensitive data ([docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)). The same `.md` tree can be exposed to Claude through this tool.
- **Agent Skills.** The output format of procedural memory, so the skills the harness learns run in Claude Code, Codex, Letta and Hermes without conversion ([spec](https://agentskills.io/specification)).
- **Basic Memory.** Lightweight observation and relation syntax inside the markdown (`- [category] fact #tag`, `relation [[Link]]`). It gives a graph without a graph database and stays readable in Obsidian ([repo](https://github.com/basicmachines-co/basic-memory)).
- **Hermes**, for comparison only, because another agent covers it in depth.
  - **Hard limits in characters** with an error when exceeded, which forces consolidation instead of silent truncation.
  - **Frozen snapshot** at the start of the session to preserve the prefix cache.
  - **Curator** with current values in the code: `interval_hours = 168`, `min_idle_hours = 2`, `stale_after_days = 14`, `archive_after_days = 30`, `consolidate = false`. It archives and never deletes ([config_defaults.py](https://github.com/NousResearch/hermes-agent/blob/5d3c059/hermes_cli/config_defaults.py)). The ai-memory doc still cites 30 and 90 days, values that Hermes migrated from 30→14 and from 90→30 ([config_migrations.py](https://github.com/NousResearch/hermes-agent/blob/5d3c059/hermes_cli/config_migrations.py)).
  - Optional **staging** (`write_approval`), with a mutation ledger with before and after hashes.
  - Note: `guard_agent_created` comes **off** by default. The skills the agent writes itself do not go through the security scanner, only those installed from the hub do.
  - The nudge cadence is 10 for memory and 10 for skills (`creation_nudge_interval`, [agent_init.py](https://github.com/NousResearch/hermes-agent/blob/5d3c059/agent/agent_init.py)). The unit, user turns versus tool iterations, comes from the ai-memory doc **(not verified in the code)**.
- **Cloudflare Agents SDK.** It already delivers the working memory we need: message tree in the DO's SQLite, compaction that preserves the originals, FTS5 and *context blocks* with `maxTokens`, including `SkillProvider` with on-demand loading ([Sessions](https://developers.cloudflare.com/agents/runtime/lifecycle/sessions/)). It is the natural starting point so we do not reinvent the buffer.

---

## 3. Proposed taxonomy

### 3.0 Principles (proposal)

1. **The `.md` file is the truth for what is durable. The index is always derived and rebuildable**, as in ai-memory.
2. **What is personal stays out of git.** Profiles, facts about users and episodes live as `.md` in a deletable hot store (R2 + DO). Git holds persona, skills, rules and non-personal knowledge. This resolves the LGPD (Brazil's data protection law) × immutable history conflict by construction (see §5.3).
3. **Durable writes off the hot path.** On the turn, only the buffer is written and a *provisional* memory is recorded when the user asks ("remember that…"). The rest comes from event-driven consolidation: idle conversation → Queue → Workflow.
4. **Supersession, not deletion.** The exception is PII, which gets real deletion.
5. **Explicit scope on every row and every file:** `tenant / agent / (user | group | agent | tenant)`. No read without a scope filter (lesson from ai-memory's `author_id`).
6. **JEV decides and the LLM writes.** Typed decisions (include, rank, operation, classification) go to JEV. The text (summary, skill body) goes to the LLM.

### 3.1 Coordinates and file layout (proposal)

```
tenants/<tenant_id>/                      # private git repo PER TENANT (non-personal classes only)
  shared/                                 # knowledge and skills shared among the tenant's agents
    knowledge/…  skills/<name>/SKILL.md
  agents/<agent_id>/
    AGENTS.md          # instructions + managed block of promoted rules (≤ ~15 rules)
    persona.md         # identity (invariant; only changes with human approval)
    MEMORY.md          # Letta-style index: what exists and where
    knowledge/         # domain semantics: concepts/ decisions/ faq/ gotchas/
    skills/<name>/SKILL.md   # agentskills.io
    _pending/          # proposals with evidence (readable sidecars)
    _lint/             # contradiction and curation reports

r2://memory/<tenant_id>/                  # hot store, does NOT go to git, deletable
  users/<user_ref>/USER.md                # bounded profile
  users/<user_ref>/facts/*.md             # semantic facts about the user
  users/<user_ref>/episodes/<conv_id>.md  # episodic summaries
  spaces/<space_ref>/…                    # groups/channels (WhatsApp/Discord/Slack): group facts
```

Minimal frontmatter of a memory, aligned with OKF and ai-memory (proposal):

```yaml
---
type: Fact                      # OKF: Fact | Episode | Skill | Persona | Profile | Rule | Concept
scope: user                     # tenant | agent | space | user
tenant: t_01J…
agent: a_sales
subject: u_7f3c…                # opaque id; never a name, phone or email in the path or frontmatter
tier: semantic                  # working | episodic | semantic | procedural | identity
status: active                  # provisional | active | stale | superseded | archived
confidence: 0.86                # from the JEV decision or from consolidation
evidence_count: 3               # distinct conversations that support it
sources:
  - resource: harness://conv/c_9a1…/msg/123
generated: { by: "consolidate@v1 (jev + <llm>)", at: 2026-10-03T12:00:00Z }
valid_from: 2026-09-20          # bi-temporal-lite (Zep)
stale_after: 2027-04-01         # OKF / TTL
supersedes: facts/preferred-channel@v2
---
Prefers support by audio on WhatsApp; text only for receipts.
```

### 3.2 Table by type

| Type | Where it lives | When it writes | How it retrieves | Contradiction / staleness / forgetting | Context limit (proposal) |
|---|---|---|---|---|---|
| **Working** (buffer) | DO per conversation (Agents SDK Session: SQLite + FTS5) ([Sessions](https://developers.cloudflare.com/agents/runtime/lifecycle/sessions/)). Not `.md` | Hot path, every message | Always in context: recent window + compacted summary; `session_search` on demand | Non-destructive compaction; retention by TTL (e.g., 30–90 days) and then **real deletion** | Recent messages protected (the SDK uses 20K tokens by default; adjust to the model) |
| **Episodic** (summaries) | `users/<u>/episodes/<conv>.md` in R2 + a row in the index; outside git | Background: DO idle alarm → Queue → `consolidate-conversation` Workflow | Last 1–2 episodes of the user at boot; the rest by hybrid search + JEV | Decay (long half-life); extractive compaction when cold (ai-memory's A2); real deletion on request | ≤300 tokens per episode; ≤2 injected |
| **Semantic — user/group** | `users/<u>/facts/*.md` and `spaces/<s>/…`; outside git | Provisional on the hot path (explicit request); active via consolidation | Hybrid search (FTS5 + Vectorize) → RRF → authority → JEV | Supersession with `valid_to`; "the newest wins" when the evidence is comparable; `stale_after`; `wrong`/`stale` feedback | ≤5–8 facts, ≤1.5k tokens |
| **Semantic — domain/agent** | `agents/<a>/knowledge/**.md` **in git** | Background (review and experience pass); human via PR | Same + higher authority for `decisions`/`faq` | Supersession; contradiction lint; curator | Shares the budget above |
| **Procedural** (skills) | `agents/<a>/skills/<name>/SKILL.md` and `shared/skills/` **in git** | Background, **always with staging**; eval gate before activating | Index of `name` + `description` at boot; JEV `choice` picks the skill; body loaded on activation | Curator: stale 14 days, archive 30 days, never delete (Hermes standard); revise by patch, not rewrite | ~100 tokens per skill in the index; at most 20–30 descriptions in the prompt; body <5k tokens ([spec](https://agentskills.io/specification)) |
| **Identity — agent** | `persona.md` + `AGENTS.md` **in git** | Human only, or a proposal with mandatory approval | Always in context (snapshot frozen per conversation) | `invariant`: only changes with direct contradiction + approval | persona ≤1.5k tokens; rules ≤~15 items / 40 lines ([rules-promotion](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/design-rules-promotion.md)) |
| **Identity — user** | `users/<u>/USER.md` in R2 + DO; **outside git** | Background (consolidation); the user can view and correct | Always in that user's context (frozen snapshot) | Bounded rewrite: when the limit is exceeded, consolidate (Hermes); real deletion on request | ≤~500 tokens (Hermes uses 1,375 characters) |

### 3.3 Details by type

**Working.**
- Use the Agents SDK Session API instead of reinventing it.
- The DO per conversation is the only writer of that conversation, the equivalent of ai-memory's "single-writer actor" (invariant #2).
- An idle alarm, for example 30 minutes without a message, publishes `conversation.idle` to the Queue **(proposal)**.
- Channels have no "SessionEnd". The episode boundary is **idleness**, or an explicit channel event when one exists.

**Episodic.**
- Per-conversation summary generated in the Workflow. It has a fixed header: intent, outcome, pending items and entities mentioned, plus `sources` with the message ids.
- It serves as **input** for the semantic and procedural types, like ai-memory's `sessions/` pages, and is the noisiest tier: 57 of 204 pages in the sampled wiki ([auto-improvement-loop.md](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/auto-improvement-loop.md)).
- **Pre-filter before spending LLM:** minimum messages and duration, in the ai-memory manner (8 observations / 120 s). A JEV `noul`, "was there anything durable in this conversation?", cuts the rest **(proposal)**.

**Semantic.**
- Mem0-style update, with supersession. For each candidate fact:
  1. fetch the top-s similar ones in the same scope;
  2. JEV `choice` over {ADD, UPDATE, SUPERSEDE, NOOP};
  3. with confidence below the threshold, escalate to the LLM with JSON-schema and, if still in doubt, to `_pending/`.
- **Contradiction.** A pair in the cosine band of "same topic, not a duplicate" goes to a JEV `choice` over {consistent, contradicts, refines, unrelated}. This replaces ai-memory's purely geometric detector, which the doc itself says is noisy in a single-domain corpus **(proposal; JEV's quality on this task unverified)**.
- **Staleness.** `stale_after` per fact type: price and stock with a short TTL, preference with a long TTL. `memory_feedback` counts from both the user and the operator.
- **Forgetting:**
  - ai-memory's retention formula with half-life per tier; ai-memory's commented example suggests working 7, episodic 365, semantic 180 and procedural 90 days ([ARCHITECTURE.md §Configuration](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/ARCHITECTURE.md));
  - access reinforcement;
  - pinned facts exempt.

**Procedural.**
- Skill in the agentskills.io standard.
- Created only by background review with **evidence in ≥2 conversations**, as in ai-memory's experience pass, and passing the eval gate.
- `patch` is preferable to rewriting, like Hermes's `skill_manage patch`.
- Scripts in the skills of a multi-tenant harness on Workers are a separate risk. The default is to **not execute `scripts/`** of agent-generated skills; markdown instructions only **(proposal)**.

**Identity.**
- The agent's persona and AGENTS.md are edited by humans via PR or Obsidian.
- Rule promotion is subtractive, with a fixed budget (ai-memory's design).
- `USER.md` is LangMem's "profile": a document with a schema and a limit.
- Both enter as a **frozen snapshot** at the start of the conversation, for prefix cache stability (Hermes standard). Changes take effect in the next conversation.

### 3.4 Context assembly per turn (proposal)

```
[always]  persona.md + AGENTS.md (rules)        ≤ ~2.0k tok   (conversation snapshot; KV cache per agent)
[always]  USER.md (+ the user's pinned facts)   ≤ ~0.5k tok   (conversation snapshot)
[always]  skills index (name+description)       ≤ ~2.0k tok   (pre-filtered if there are >20–30 skills)
[always]  conversation buffer (recent + summary) ≤ model budget − the rest
[conditional]  JEV noul: "needs long-term memory?"  → if yes:
   FTS5(agent/user DO) ∪ Vectorize(namespace=tenant, filter agent/user/scope)
   → RRF → authority multiplier (type/tier/pinned) × retention
   → JEV score (rubric 0/0.3/0.7/1.0) per candidate → cut below the threshold
   → JEV choice to order what remains → pack up to ≤ ~1.5–2k tok
[conditional]  skill activated → SKILL.md body (< 5k tok)
```

- **Failures.** If JEV fails or times out, use the RRF + authority order with a fixed top-k. Search becomes "without rerank", never "without search", as in ai-memory.
- **JEV budget.** State + questions fit in 32k tokens ([OpenRouter](https://openrouter.ai/docs/guides/community/jev)). Limit to 15–30 candidates with short snippets: ai-memory cuts the title at 120 characters and the text at 160 in the `choice` shim.

### 3.5 Where JEV comes in (proposal)

| Decision | Primitive | What is used from the response | Fallback |
|---|---|---|---|
| Does the turn need long-term memory? | `noul` | p(yes) ≥ threshold | Always retrieve (small top-k) |
| Include or cut candidate memory X? | `score` (rubric) or `noul` per candidate | **Absolute score** for the threshold | Fixed top-k |
| Order the survivors to fit the budget | `choice` | **Only the order** (relative probability) | RRF + authority order |
| Which skill to activate | `choice` over the descriptions | Top-1 if confidence is high; otherwise let the LLM see the list | The LLM decides from the list |
| Write operation for a fact | `choice` {ADD, UPDATE, SUPERSEDE, NOOP} | Operation + confidence; low → LLM or human | LLM with JSON-schema |
| Did the conversation have anything durable? (cost pre-filter) | `noul` | Skips the LLM consolidation | Heuristic (minimum messages) |
| Does the text contain personal data (and of what category)? | `choice` / `noul` | Blocks writing to classes that go to git | Regex sanitizer + review |
| Does the content look like an instruction or injection? | `noul` | Quarantine + `status: provisional` | Treat all content as untrusted |
| Memory pair: consistent / contradicts / refines / unrelated | `choice` | Opens a finding or proposes supersession | Lint by cosine band |
| Promote provisional → active | `score` + deterministic rules | Together with evidence_count and absence of contradiction | Stays provisional |

**Caveats:**
- Only the reranking case has a published benchmark, and on a code wiki, not on conversations with customers ([jev-reranker-adapter.md](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/jev-reranker-adapter.md)). The other uses need their own golden set before becoming the default **(unverified)**.
- `choice` does not serve for thresholds.
- Recording the confidence and the model used in the frontmatter (`generated.by`) allows auditing and recalibrating later.

### 3.6 Mapping to Cloudflare

| Piece | Role | What is confirmed |
|---|---|---|
| DO per conversation | Buffer, compaction, FTS5 of the history, idle alarm | The DO's SQLite supports **FTS5** (+ JSON + math) ([SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)) |
| DO per agent (tenant×agent) | Derived index of the agent's `.md` corpus: `pages` (is_latest/supersedes), `pages_fts`, `links`, `entities`, `feedback`, access counters, proposals; single writer | 10 GB per DO ([GA changelog](https://developers.cloudflare.com/changelog/product-group/storage/5/)); storage is private to the instance ([SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)) |
| DO per user (tenant×user) | The user's profile, facts and episodes; **delete = delete that DO's storage** + R2 objects + vectors | **30-day PITR**: deleted data remains recoverable for up to 30 days, which must be stated in the privacy policy ([SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)) |
| R2 | Canonical `.md` files of all classes; exports (portability) | — |
| GitHub (private repo per tenant) | Mirror of the non-personal classes; PRs for human approval; webhook → Queue → reindex (the "watcher") | Commit via the GitHub REST API (Git Data API) from a Workflow **(not verified in this session)** |
| Vectorize | One index; **namespace per tenant**; metadata indexes for `agent`, `scope`, `subject`, `type`, `tier` | The namespace is filtered **before** the vector search ([insert-vectors](https://developers.cloudflare.com/vectorize/best-practices/insert-vectors/)). Limits: 50,000 namespaces per index on the paid plan (another page still says 1,000), 10 metadata indexes, 64 bytes indexed per string, topK 50 with metadata, 1,536 dimensions ([limits](https://developers.cloudflare.com/vectorize/platform/limits/)) |
| Queues | `message.received`, `conversation.idle`, `memory.proposed`, `memory.approved`, `user.erasure_requested` | — |
| Workflows | `consolidate-conversation`, `review-agent` (cron), `experience-pass`, `curator`, `erasure` (multi-step with retry) | — |
| KV | Cache of the compiled "boot context" per agent (persona + rules + skill index), invalidated on every commit | — |

---

## 4. Review and learning

### 4.1 How others do it

| System | Trigger | What it extracts | Where it writes | Approval | Safeguards |
|---|---|---|---|---|---|
| ai-memory auto-improve | Hourly scheduler over finished sessions | gotchas, decisions, concepts, procedures, rules (≤5 per run) | `_pending/auto-improve/` → wiki | Automatic by default; `require_approval` | Confidence floor 0.75, cited evidence, size limits, eval gate on `_rules`/`procedures`, rejection buffer, negative filters, `auto_improve` actor ([doc](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/auto-improvement-loop.md)) |
| ai-memory experience pass | Every N sessions (opt-in) | Patterns across trajectories | Same pipeline | Same | Evidence in ≥2 named sessions ([doc](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/experience.md)) |
| ai-memory curator | Manual/scheduled | Duplicates, cold pages, old slots | Report | Report only | Never deletes semantic pages |
| Letta dreaming | After N steps or at compaction | "Useful lessons" | MemFS (commit, worktree) | Optional: the main agent reviews the proposals | Git versioning ([sleeptime](https://docs.letta.com/guides/agents/architectures/sleeptime)) |
| Hermes | Nudge every 10 (memory) / 10 (skills); weekly curator with 2 h of idleness | Memory entries; skills ("lessons, not logs") | `MEMORY.md`/`USER.md`; `~/.hermes/skills/` | Optional `write_approval` (staging in `pending/`) | Character limit, anti-injection scanner on memory, ledger with hash, archives and never deletes ([config](https://github.com/NousResearch/hermes-agent/blob/5d3c059/hermes_cli/config_defaults.py)) |
| LangMem | Hot path or background | Facts, episodes, prompt | Store | — | — ([guide](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)) |
| Mem0 | Each pair of messages | Atomic facts | Vector DB | — | LLM chooses the operation ([paper](https://arxiv.org/html/2504.19413)) |

### 4.2 Proposed pipeline (event-driven)

1. **L0 — capture (hot path).** The message goes to the DO buffer. An explicit "remember" request becomes a `provisional` fact in the speaker's scope, with `sources`.
2. **L1 — episode (idleness → Workflow):**
   - pre-filter (heuristic + JEV `noul`);
   - episodic summary by the LLM;
   - candidate extraction by the LLM with JSON-schema;
   - operation for each candidate via JEV `choice`;
   - writing facts in the **user/group** scope, which can be automatic because the blast radius is only that user.
3. **L2 — agent review (cron, per agent).** Proposals for `knowledge/` and `skills/`, always in `_pending/` with cited evidence, confidence floor, rejection buffer and negative filters (ai-memory's list adapted to customer service):
   - ignore short conversations;
   - ignore transient integration failures;
   - do not record "system X is down" as a rule;
   - do not record a single-case narrative.
4. **L3 — experience pass.** Every N conversations of the agent, patterns that repeat in ≥2 conversations, **and from ≥2 distinct users** when the target is agent-scoped (protection against poisoning), become candidates for a skill or an FAQ.
5. **L4 — eval gate.** Skills and rules are only activated if a set of the agent's test cases improves: `score_after − score_before ≥ min_delta`, same contract as ai-memory.
6. **L5 — curator (weekly, during idleness).** Duplicates (embedding clusters), stale and archiving (14/30 days, Hermes standard), contradictions (JEV) and a report in `_lint/`.
7. **L6 — promotion to rule or persona.** Always human, with a subtractive budget.

### 4.3 Provisional → permanent (proposal)

States: `provisional → active → stale → superseded | archived`.

**User/group scope:** `active` when any one of the conditions below holds.
- (a) The user asked explicitly and JEV does not flag an instruction or injection.
- (b) `evidence_count ≥ 2` in distinct conversations.
- (c) Confidence ≥ τ and the fact does not contradict any `active` one.

**Agent/tenant scope:** `active` only when **all** of the conditions below hold.
- `evidence_count ≥ 2` conversations and ≥ 2 users.
- No open contradiction.
- Passed the PII filter: nothing personal goes to git.
- Approval, automatic or human according to the matrix below.

| Target | Blast radius | Default approval |
|---|---|---|
| User/group fact | 1 user/group | Automatic + auditable; the user can view and correct |
| Agent `knowledge/` | All of the agent's users | Automatic with `confidence ≥ 0.85` and multi-user evidence; otherwise PR |
| `skills/` | Agent behavior | **Always PR** + eval gate |
| `persona.md`, `AGENTS.md` | Identity | **Always human** |

### 4.4 Quality metrics

- **Retrieval:** hit@1/hit@5, MRR and NDCG@10 over a golden set per agent, with the same methodology as ai-memory's JEV benchmark. Compare without rerank, with JEV `choice` and with JEV `score`.
- **Usage:** fraction of responses that cite at least one retrieved memory, `access_count` and `helpful`/`wrong` per page.
- **Proposals:** approval rate, rollback rate and rejection reasons. ai-memory has `auto-improve-report` with terminal rates ([doc](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/auto-improvement-loop.md)).
- **Health:** pages per tier and status, contradiction backlog, % stale and "always loaded" tokens per agent (bloat alarm).
- **Cost:** LLM and JEV tokens per consolidated conversation and per review; latency added to the turn by retrieval with JEV.
- **External benchmarks** (LongMemEval, LoCoMo) only as a reference. ai-memory records that market numbers have already been dismantled by public audit (the mempalace case in [research-2026-landscape.md](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/research-2026-landscape.md)), a secondary source.

---

## 5. Risks

### 5.1 Memory poisoning by injection

- **Threat.**
  - MINJA injects malicious records into memory **through normal queries only**, without direct access to the store ([arXiv:2503.03704](https://arxiv.org/abs/2503.03704)).
  - In chat channels, every user is untrusted.
  - In groups, a user can try to plant "facts" or "rules" that the agent will apply to others.
  - Learned skills are the most dangerous vector because they become behavior.
- **What ai-memory does**, and calls "defense in depth, not proof" ([SECURITY.md](https://github.com/akitaonrails/ai-memory/blob/d48a20d/SECURITY.md)):
  - the maintenance and rerank prompts mark all stored text as "untrusted data" ([auto_improve.rs](https://github.com/akitaonrails/ai-memory/blob/d48a20d/crates/ai-memory-consolidate/src/auto_improve.rs), [reranker.rs](https://github.com/akitaonrails/ai-memory/blob/d48a20d/crates/ai-memory-llm/src/reranker.rs));
  - `Sanitized<T>`;
  - validation with evidence and confidence;
  - protection of pinned pages and invariants;
  - `require_approval` on a shared server.
- **What Hermes does:** it scans memory entries for injection and exfiltration patterns and for invisible Unicode ([docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)). But the scanner for agent-created skills comes off by default.
- **Proposal:**
  - writes scoped by blast radius: the speaker only affects their own scope;
  - promotion to agent scope requires evidence from ≥2 users + eval gate + PR for skills;
  - mandatory `sources`;
  - JEV `noul` "does it look like an instruction?" to quarantine;
  - never execute `scripts/` of generated skills;
  - adversarial test per boundary, in the manner of ai-memory's security-boundaries.

### 5.2 Leakage across tenants, users and groups

- **The reference design does not serve.** ai-memory is single-tenant, and project pages are read by all operators ([security-boundaries.md #5a](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/security-boundaries.md)).
- **Proposal:**
  - physical isolation per DO (tenant×agent; tenant×user);
  - Vectorize namespace per tenant, filtered before the search, plus a metadata filter on `agent`/`subject`;
  - git repo per tenant;
  - opaque identifiers;
  - the `space` (group) scope separate from `user`, so what is said in the group does not leak into private chats and vice versa.
- **Vectorize limits.** 50,000 namespaces per index on the paid plan and 64 bytes per name ([limits](https://developers.cloudflare.com/vectorize/platform/limits/)). Beyond that, sharding by index is needed.
- **Third parties.** Embeddings and rerank send text to vendors, who become operators of the data. ai-memory documents exactly this ([DATA_HANDLING.md](https://github.com/akitaonrails/ai-memory/blob/d48a20d/DATA_HANDLING.md)).

### 5.3 PII, LGPD/GDPR and immutable git history

- **Conflict.** The right to erasure applies under the LGPD ([Lei 13.709/2018, art. 18](https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm); the site was unavailable in this session and the exact text of the article is **(unverified)**) and under the GDPR ([art. 17](https://gdpr-info.eu/art-17-gdpr/), including the duty to notify other controllers when the data was made public). Git, on the other hand, keeps everything.
- **What the sources say:**
  - ai-memory: purge is logical and the text remains in the objects and in the commit messages ([lifecycle-ops.md](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/lifecycle-ops.md));
  - GitHub: removal requires `git-filter-repo`, rewrites all subsequent hashes, the data remains in forks and clones and cached views require GitHub support ([GitHub docs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)).
- **Proposal:**
  1. No personal data in classes that go to git. This is principle 2 of §3.0, enforced by a **PII gate before every commit** (sanitizer + JEV category `choice`), which blocks and sends to review.
  2. Personal data stays in the per-user DO + R2 + Vectorize. Erasure becomes a Workflow that deletes:
     - the DO's storage;
     - the prefix in R2;
     - the vectors by id;
     - the entries in caches.

     Still to be flagged: the DO's 30-day PITR ([docs](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)), the backups and the logs of the LLM providers.
  3. **Crypto-shredding** per user: encrypt the user's `.md` files with a per-user key and destroy the key on erasure. This would make residual copies, backups and PITR unreadable **(my own proposal; unsourced)**.
  4. Pseudonymized data remains personal data under the GDPR (Recital 26) **(not verified in this session)**. An opaque id in git is not enough if the content identifies the person.
  5. Portability comes for free: the user's `.md` files are the export package.

### 5.4 Uncontrolled growth and loss of adherence

- **Risks:**
  - The always-loaded context grows: rules, skill index, profile. ai-memory cites a drop in adherence with a long AGENTS.md **(number not verified)**.
  - The skills spec itself costs about 100 tokens per skill at the start: 200 skills come to about 20k tokens.
  - The episodic tier is the main noise.
- **Mitigations:**
  - hard limits with an error when exceeded (Hermes);
  - subtractive rules budget (ai-memory);
  - skill pre-selection by JEV or embedding above 20–30 skills;
  - decay and extractive compaction;
  - a curator that archives;
  - an "always loaded tokens" metric per agent with an alarm.

### 5.5 Token cost

- **Source of the cost.** One LLM call per consolidated conversation, plus periodic reviews, is ai-memory's pattern ("one bounded call per session that passes the preflight") and grows linearly with conversation volume.
- **Mitigations:**
  - pre-filter without an LLM and JEV `noul` before the LLM;
  - batch consolidation per user;
  - JEV for all typed decisions: the vendor claims US$ 0.042/MTok input and free output ([TypeSafe](https://typesafe.ai/blog/introducing-system-one-models-and-jev)), price **not verified** on an invoice;
  - frozen snapshot to take advantage of the prefix cache;
  - input and output limits per run (`max_input_tokens`, `max_proposals_per_run`).

### 5.6 Others

- **False constraints.** "Integration X broken" hardens into a refusal. The negative filters and a short `stale_after` for operational states cover this.
- **Skill drift** from successive patches. Ledger with before and after hashes (Hermes), rollback and eval gate.
- **Dependence on the JEV vendor.** The fallback is the RRF order or the LLM with JSON-schema, like ai-memory, where a judge failure does not bring down search.
- **Public portfolio repo.** Synthetic fixtures only, never tenant data.

---

## 6. Recommendation

1. **Adopt the "Letta MemFS + ai-memory" model adapted to multi-tenant:**
   - `.md` with OKF-like frontmatter as the truth;
   - derived index in the DO's SQLite (FTS5) + Vectorize;
   - supersession;
   - event-driven consolidation (Queue → Workflow).

   **Do not** port the Rust code. Port the **invariants and mechanisms** listed in §1.9.
2. **Divide the classes by the nature of the data.**
   - **Git (private repo per tenant):** persona, AGENTS.md, skills (agentskills.io) and domain knowledge.
   - **Deletable hot store (per-user DO + R2):** profile, user and group facts, and episodes.

   Both are `.md` files that humans can edit and that can be exported to Obsidian. Only the first has immutable history.

   **This item deviates from the requirement and needs the owner's decision.** The request says user profiles must also be `.md` "versioned (GitHub and/or Obsidian)". In this proposal:
   - the user `.md` files **are versioned**, through the `supersedes` chain in the DO/R2, but the history is deletable and does not live in git;
   - humans access these files by export, not through the GitHub repository.

   The alternative that meets the requirement to the letter is to keep per-user encrypted files in git and destroy the key on erasure (crypto-shredding). The cost is that these files cannot be read or edited on GitHub or in Obsidian without the key.
3. **Use JEV on the memory path from the MVP:**
   - `noul` (does it need memory?);
   - `score` on a rubric (include or cut);
   - `choice` (rank and pick the skill);
   - operation `choice` on write.

   With a deterministic fallback and an own golden set before turning each use on by default.
4. **Review at three rhythms.**
   - Per idle conversation: episode + user facts, automatic.
   - Per agent, on cron: knowledge and skills, in `_pending/`, with evidence and eval gate; skills always by PR.
   - Weekly: curator, which archives and never deletes.

   Promotion to a rule or persona is always human and subtractive.
5. **Security from day 1:**
   - writes scoped by blast radius;
   - multi-user promotion;
   - stored content always treated as untrusted;
   - PII gate before commit;
   - erasure Workflow;
   - adversarial test per boundary (tenant, user, group).
6. **Suggested order:**
   - **MVP:** working (Agents SDK Session) + identity (persona/USER.md as a snapshot) + user semantic with ADD/UPDATE/SUPERSEDE via JEV + hybrid retrieval with JEV rerank.
   - **v2:** episodes + agent review + skills with staging + eval gate.
   - **v3:** experience pass + curator + rules promotion + crypto-shredding.

### Unverified items that matter for the decision

- JEV's quality outside reranking (write operation, PII, injection, contradiction) and the claimed calibration.
- Committing to GitHub from Workers/Workflows (Git Data API).
- Synchronization with Obsidian (git plugin or export).
- Exact text of LGPD art. 18 (Planalto site unavailable) and the treatment of pseudonymized data.
- The instruction-adherence numbers (~150–200 instructions, −30% after ~200 lines) cited by ai-memory.
- The OKF v0.2 specification (I read only ai-memory's description).
- The exact unit of Hermes's nudge cadence.
- Graphiti's `group_id` as a multi-tenancy mechanism (it does not appear in the README I read).

---

## 7. Sources

**ai-memory** (commit `d48a20d`, 2026-10-03):
- [README.md](https://github.com/akitaonrails/ai-memory/blob/d48a20d/README.md)
- [docs/ARCHITECTURE.md](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/ARCHITECTURE.md)
- [docs/auto-improvement-loop.md](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/auto-improvement-loop.md)
- [docs/experience.md](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/experience.md)
- [docs/design-rules-promotion.md](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/design-rules-promotion.md)
- [docs/okf.md](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/okf.md)
- [docs/jev-reranker-adapter.md](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/jev-reranker-adapter.md)
- [docs/examples/jev-reranker-adapter/jev_rerank_shim_choice.py](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/examples/jev-reranker-adapter/jev_rerank_shim_choice.py)
- [docs/security-boundaries.md](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/security-boundaries.md)
- [docs/lifecycle-ops.md](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/lifecycle-ops.md)
- [docs/deploy.md](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/deploy.md)
- [docs/support-matrix.md](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/support-matrix.md)
- [docs/research-2026-landscape.md](https://github.com/akitaonrails/ai-memory/blob/d48a20d/docs/research-2026-landscape.md) (secondary, the project's own positioning)
- [SECURITY.md](https://github.com/akitaonrails/ai-memory/blob/d48a20d/SECURITY.md)
- [DATA_HANDLING.md](https://github.com/akitaonrails/ai-memory/blob/d48a20d/DATA_HANDLING.md)
- Code: [sanitize.rs](https://github.com/akitaonrails/ai-memory/blob/d48a20d/crates/ai-memory-core/src/sanitize.rs), [decay.rs](https://github.com/akitaonrails/ai-memory/blob/d48a20d/crates/ai-memory-store/src/decay.rs), [reranker.rs](https://github.com/akitaonrails/ai-memory/blob/d48a20d/crates/ai-memory-llm/src/reranker.rs), [auto_improve.rs](https://github.com/akitaonrails/ai-memory/blob/d48a20d/crates/ai-memory-consolidate/src/auto_improve.rs)

**Hermes Agent** (commit `5d3c059`):
- [hermes_cli/config_defaults.py](https://github.com/NousResearch/hermes-agent/blob/5d3c059/hermes_cli/config_defaults.py)
- [hermes_cli/config_migrations.py](https://github.com/NousResearch/hermes-agent/blob/5d3c059/hermes_cli/config_migrations.py)
- [agent/agent_init.py](https://github.com/NousResearch/hermes-agent/blob/5d3c059/agent/agent_init.py)
- [README](https://github.com/NousResearch/hermes-agent)
- [docs memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)
- [docs skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)

**Letta:**
- [MemFS](https://docs.letta.com/concepts/memfs/index.md)
- [Memory & dreaming](https://docs.letta.com/configuration/memory)
- [Sleep-time agents](https://docs.letta.com/guides/agents/architectures/sleeptime)
- [Memory blocks](https://docs.letta.com/guides/agents/memory-blocks)
- [llms.txt](https://docs.letta.com/llms.txt)
- [Benchmarking AI Agent Memory (2025-08-12)](https://www.letta.com/blog/benchmarking-ai-agent-memory)
- Lin et al., *Sleep-time Compute* — [arXiv:2504.13171](https://arxiv.org/abs/2504.13171)

**Mem0:** Chhikara et al., *Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory* — [arXiv:2504.19413](https://arxiv.org/abs/2504.19413) ([HTML](https://arxiv.org/html/2504.19413))

**Zep/Graphiti:**
- Rasmussen et al., *Zep: A Temporal Knowledge Graph Architecture for Agent Memory* — [arXiv:2501.13956](https://arxiv.org/abs/2501.13956)
- [github.com/getzep/graphiti](https://github.com/getzep/graphiti)

**LangMem:** [Conceptual guide](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)

**Anthropic:** [Memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)

**Agent Skills:** [Specification](https://agentskills.io/specification), [Overview/clients](https://agentskills.io/home)

**Basic Memory:** [github.com/basicmachines-co/basic-memory](https://github.com/basicmachines-co/basic-memory)

**AGENTS.md:** [agents.md](https://agents.md/)

**JEV / TypeSafe:**
- [Introducing System One Models & Jev (2026-09-28)](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
- [OpenRouter — Jev](https://openrouter.ai/docs/guides/community/jev)

**Cloudflare:**
- [SQLite-backed DO storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [DO SQLite GA (10 GB)](https://developers.cloudflare.com/changelog/product-group/storage/5/)
- [Agents SDK — Sessions](https://developers.cloudflare.com/agents/runtime/lifecycle/sessions/)
- [Vectorize limits](https://developers.cloudflare.com/vectorize/platform/limits/)
- [Vectorize — insert vectors / namespaces](https://developers.cloudflare.com/vectorize/best-practices/insert-vectors/)

**Security and privacy:**
- Dong et al., *Memory Injection Attacks on LLM Agents* (MINJA) — [arXiv:2503.03704](https://arxiv.org/abs/2503.03704)
- [GDPR art. 17](https://gdpr-info.eu/art-17-gdpr/)
- [LGPD — Lei 13.709/2018](https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm) (unavailable in this session)
- [GitHub — Removing sensitive data from a repository](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)
