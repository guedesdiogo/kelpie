> Research note written on 2026-10-05 for the shared second brain ([#103](https://github.com/guedesdiogo/kelpie/issues/103)). It extends [02-memory-and-learning.md](02-memory-and-learning.md) and [08-database-and-context-storage.md](08-database-and-context-storage.md).

# 09 — One memory shared by every agent: Supermemory, Honcho, Mem0 and the alternatives

> **Read-only research, done on 2026-10-05.** Nothing was created in any service. Five research passes ran in parallel, and the claims the recommendation rests on were then re-read from the primary sources.
> **Conventions.**
> - Every claim carries its link.
> - "(unverified)" marks what no primary source confirmed.
> - Benchmark numbers are **vendor claims**: Mem0, Zep, Letta, Supermemory and Honcho publish contradicting figures, so no option is ranked on them.
> - Star counts and versions are as of this date. These projects change monthly.

---

## TL;DR

- **The owner's criteria** (2026-10-05):
  - one memory used by Kelpie, Hermes, OpenClaw and manual editing **at the same time**;
  - **full export** with no dependence on one platform;
  - open source preferred, or used only as a lesson for a format of our own;
  - memory that grows and makes agents better, while context stays efficient.
- **Two separate questions.** These options split along them:
  1. **Where the canonical memory lives, and in what format.** This decides portability and lock-in.
  2. **Which engine extracts, consolidates and retrieves.** This can be swapped.

  Supermemory, Honcho and Mem0 are mostly **engines that also want to be the store**. Kelpie's plan ([ADR-0016](../adr/0016-vault-second-brain.md)) is mostly **a format**.
- **None of the three meets the core criterion.** None keeps readable canonical data with a full, re-importable export, and none runs on Workers:
  - **Supermemory.** The engine is closed: the self-hosted server is a binary "built from a separate, non-public codebase", without MCP or connectors ([self-hosting](https://supermemory.ai/docs/self-hosting/overview)). The console export is capped JSON with no documented re-import.
  - **Honcho.** It is AGPL and fully self-hostable, but it has no export endpoint ([#721](https://github.com/plastic-labs/honcho/issues/721), open). Derived conclusions can't be re-imported with their provenance, and outdated beliefs are deleted rather than superseded.
  - **Mem0.** It is Apache-2.0, but export is Platform-only ([platform vs OSS](https://docs.mem0.ai/platform/platform-vs-oss)). The truth is LLM-paraphrased rows in a vector store. OpenMemory, the open-source graph and the self-hosted MCP were all retired in 2026.
- **What decides "at the same time" is each platform's integration surface, not benchmarks.**
  - **Hermes:** one external memory provider runs next to its always-on `MEMORY.md`/`USER.md` ([providers](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers)), through a documented plugin interface. It is also an MCP client.
  - **OpenClaw:** an MCP client that indexes extra folders (`memory.search.extraPaths`), with one exclusive memory slot ([plugins](https://docs.openclaw.ai/tools/plugin)).
  - **Both** read Agent Skills (`SKILL.md`).
- **ADR-0016's sharing mechanism can't deliver simultaneous use.** It relies on symlinked Hermes files and git sync. But Hermes says to "never point two agent processes at the same profile", and to use an external provider for shared memory ([profiles](https://hermes-agent.nousresearch.com/docs/user-guide/profiles)). Hermes also loads memory as a frozen snapshot per session ([memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)). OpenClaw's memory files are a different format.
- **Recommendation: keep the Markdown vault in git as the truth, and build the shared access layer on Kelpie.**
  - **The Context Store is the single writer.** Every platform reaches it through an authenticated **MCP endpoint**.
  - **Small adapters per platform:** a Hermes memory-provider plugin, and OpenClaw via MCP plus `extraPaths`.
  - **Hermes's and OpenClaw's own files become rendered digests,** not the truth.
  - **Borrowed techniques:**
    - supersession with provenance (Supermemory, Mem0 Dream, Graphiti, ai-memory);
    - conclusions linked to their sources (Honcho);
    - context tiers (Letta);
    - hybrid retrieval with a bounded rerank (ai-memory, Hindsight, Cloudflare Agent Memory);
    - a token-budgeted `context()` (Honcho).
- **The fastest alternative is to adopt [ai-memory](https://github.com/akitaonrails/ai-memory).** It is MIT, its canonical store is Markdown in git, and it already integrates with Hermes and OpenClaw. The price is a 24/7 server outside Cloudflare.
- **Decisions left to the owner:** see §10.

---

## 1. The criteria, and how each option is read

| # | Criterion | What counts as meeting it |
|---|---|---|
| C1 | Simultaneous multi-platform use | Kelpie, Hermes, OpenClaw and manual edits read and write one memory, and see each other's writes without waiting for a sync or a new session |
| C2 | No lock-in | The canonical data is readable, a full export exists and another system can re-import it, and losing the vendor loses no knowledge |
| C3 | Open source | Permissive license best; AGPL acceptable when run as a separate service; open-core is weighed by what stays closed |
| C4 | Grows and improves | Incremental capture, consolidation, supersession of outdated facts, and provenance |
| C5 | Efficient orchestration | It chooses what to load under a token budget: tiers, hybrid retrieval, reranking |
| C6 | Fits Kelpie | Runs on Workers or behind one network hop; keeps third parties' personal data out of git ([ADR-0006](../adr/0006-personal-data-storage.md)); costs per write |

---

## 2. The three products

### 2.1 Supermemory

- **License and openness.** The repo is MIT ([LICENSE](https://github.com/supermemoryai/supermemory/blob/main/LICENSE)), but it holds the SDKs, the MCP server, the plugins and the console. The engine is closed: "the downloadable self-hosted server binary is built from a separate, non-public codebase" ([self-hosting](https://supermemory.ai/docs/self-hosting/overview)). That makes it **open-core**.
- **Self-hosting** is weaker than the cloud ([local vs enterprise](https://supermemory.ai/docs/self-hosting/local-vs-enterprise)):
  - no connectors and no MCP;
  - your own LLM instead of "proprietary long-horizon models";
  - free "within its lite license limit". The v0.0.7 release notes put it at 10,000 documents; no license text was found (unverified);
  - its on-disk store is an encrypted container ([#1653](https://github.com/supermemoryai/supermemory/issues/1653)), so nothing is readable at rest;
  - pre-1.0: v0.0.8 on 2026-08-17. One upgrade silently wiped search vectors ([v0.0.8 notes](https://github.com/supermemoryai/supermemory/releases/tag/server-v0.0.8)).
- **Data model.** Documents and chunks, then extracted memories in a versioned graph (updates, extends and derives relations), then static and dynamic user profiles ([how it works](https://supermemory.ai/docs/concepts/how-it-works), [user profiles](https://supermemory.ai/docs/concepts/user-profiles)).
- **Export.**
  - **Console:** a JSON export of up to 25k items, with links valid for 6 hours ([changelog 2026-06-04](https://supermemory.ai/changelog/request-a-data-export-from-settings/)). The schema is undocumented and there is no documented re-import.
  - **API:** `/v4/memories/list` returns versions, `isLatest`, relations and history ([API](https://supermemory.ai/docs/api-reference/content-management/list-memory-entries-with-history)), so a scripted export is possible.
- **Integrations.**
  - **Hermes:** a provider plugin, MIT ([hermes-supermemory](https://github.com/supermemoryai/hermes-supermemory)), that implements `on_memory_write`.
  - **OpenClaw:** a plugin that takes the exclusive memory slot ([docs](https://supermemory.ai/docs/integrations/openclaw)).
  - **Others:** a hosted MCP server, plus Claude Code, Cursor, Codex and OpenCode plugins.
  - **Sharing:** every client must use one `containerTag`. Defaults differ per client: `hermes`, `openclaw_{hostname}`, `sm_project_default` ([container tags](https://supermemory.ai/docs/concepts/container-tags)).
- **Writes and retrieval.**
  - Ingest is asynchronous and "dreams" after the status reads `done`; one integration measured 10 to 20 minutes (unverified).
  - Re-sending under a stable `customId` upserts, and only the delta is billed ([billing](https://supermemory.ai/docs/overview/billing)).
  - Search is hybrid, with an optional rerank. There is no token budget, only `limit`.
- **Contradictions and erasure.**
  - An update creates a new version and marks the old one `isLatest=false`.
  - `forget` is a soft delete ([forget](https://supermemory.ai/docs/api-reference/content-management/forget-a-memory)).
  - SOC 2 Type II, GDPR and HIPAA on Scale are vendor claims ([security](https://supermemory.ai/docs/overview/security)).
- **Price** ([pricing](https://supermemory.ai/pricing)): Free with $5 in credits, Pro $19, Max $100, Scale $399. The GitHub connector needs Scale.
- **Benchmarks (vendor claim):** LongMemEval-S 97% "Recall@20 with aggregation". The baselines in the same table may use a different metric ([research](https://supermemory.ai/research/longmembench/)).
- **Lock-in:**
  - the closed engine;
  - Hermes and OpenClaw auto-capture write their truth into Supermemory, not into any vault;
  - self-hosting has no MCP, so in practice multi-agent use depends on the cloud.

### 2.2 Honcho (Plastic Labs)

- **License.** The server is AGPL-3.0 ([LICENSE](https://github.com/plastic-labs/honcho/blob/main/LICENSE)); the SDKs are Apache-2.0. The managed deriver runs a fine-tuned model, Neuromancer XR on Qwen3-8B ([blog](https://plasticlabs.ai/blog/research/Introducing-Neuromancer-XR)), with no public weights found.
- **Self-hosting.**
  - It is the same code as the managed service, but runs a commodity model: `gpt-5.4-mini` by default, or any OpenAI-compatible endpoint with tool calling ([configuration](https://honcho.dev/docs/v3/contributing/configuration)).
  - It needs Postgres with pgvector, an API process, and a deriver worker that must stay running ([self-hosting](https://honcho.dev/docs/v3/contributing/self-hosting)). The worker can't run on Workers.
- **Data model.** Workspace → peers and sessions → messages. "Conclusions" are one sentence each, with `level` (explicit, deductive, inductive or contradiction), `source_ids` and `times_derived` ([OpenAPI](https://honcho.dev/docs/v3/openapi.json)). They are readable, but they live in Postgres rows.
- **Export.**
  - There is **no export endpoint**: [#721](https://github.com/plastic-labs/honcho/issues/721), opened 2026-05-23, is still open, and [#528](https://github.com/plastic-labs/honcho/issues/528) asks for import.
  - `ConclusionCreate` can't set `level` or `source_ids`, so the derived graph is lost on re-import.
  - Self-hosters can `pg_dump`, but only into Honcho's schema.
- **Integrations.** It has the strongest multi-agent story of the three:
  - **MCP:** an official server, hosted or local. The repo's MCP server is itself a Cloudflare Worker ([wrangler.toml](https://github.com/plastic-labs/honcho/blob/main/mcp/wrangler.toml)).
  - **Hermes:** a plugin maintained by Plastic Labs ([guide](https://honcho.dev/docs/v3/guides/integrations/hermes)). Hermes moved it from bundled to its catalog on 2026-10-02 ([commit](https://github.com/NousResearch/hermes-agent/commit/7e53b3ef82c9074649230b572dfcc76d4b629058)).
  - **OpenClaw:** a plugin that runs alongside memory-core rather than taking its place ([guide](https://honcho.dev/docs/v3/guides/integrations/openclaw)).
  - **Claude Code:** [claude-honcho](https://github.com/plastic-labs/claude-honcho).
  - **Sharing:** every host must use one workspace and one peer name ([unified memory](https://honcho.dev/docs/v3/guides/recipes/unified-memory-setup)). Scopes are "not an authorization boundary" ([scopes](https://honcho.dev/docs/v3/documentation/features/advanced/scopes)).
- **Writes and retrieval.**
  - Writes return at once, and the deriver batches its work ([dreaming](https://honcho.dev/docs/v3/documentation/features/advanced/dreaming)):
    - about 1,024 tokens per batch, or 30 minutes;
    - summaries every 20 and every 60 messages;
    - "dreaming" after 50 new conclusions, 8 hours since the last one, and 60 minutes idle.
  - `context(tokens)` returns a summary plus recent messages within a budget, split 60/40 ([summarizer](https://honcho.dev/docs/v3/documentation/features/advanced/summarizer)).
  - `chat()` is an agent that searches memory with evidence ([chat](https://honcho.dev/docs/v3/documentation/features/chat)).
- **Contradictions and erasure.**
  - The dreamer is told to "DELETE the outdated observation", and no history of superseded beliefs is kept ([specialists.py](https://github.com/plastic-labs/honcho/blob/main/src/dreamer/specialists.py)).
  - Peers and individual messages can't be deleted; derived conclusions outlive their session ([deleting data](https://honcho.dev/docs/v3/documentation/features/advanced/deleting-data)).
  - The privacy policy contradicts itself on SOC 2.
- **Price** ([honcho.dev](https://honcho.dev/)): $2 per million tokens ingested, `context()` free, `chat()` $0.001–$0.50 per query.
- **Benchmarks (vendor claim):** LongMemEval-S 90.4%, LoCoMo 89.9%, run on models that are neither the self-hosted default nor the managed stack ([evals](https://honcho.dev/evals)).

### 2.3 Mem0

- **License.** Apache-2.0 ([LICENSE](https://github.com/mem0ai/mem0/blob/main/LICENSE)). These are Platform-only ([platform vs OSS](https://docs.mem0.ai/platform/platform-vs-oss)):
  - export;
  - graph memory: it was removed from the open-source version when the v3 pipeline landed;
  - Dream, decay, temporal reasoning, webhooks and summaries.
- **What was retired in 2026:**
  - OpenMemory, removed from the monorepo on 2026-07-29 ([#6530](https://github.com/mem0ai/mem0/pull/6530));
  - mem0-mcp, archived 2026-03-24;
  - the external graph stores. MCP is now hosted only, at `mcp.mem0.ai` ([MCP](https://docs.mem0.ai/platform/mem0-mcp)).
- **Self-hosting.** The library is Python, or TypeScript through `mem0ai/oss`. It needs a vector store and a SQLite history table. The self-hosted server is FastAPI with pgvector, and has no export endpoint and no MCP ([server/main.py](https://github.com/mem0ai/mem0/blob/main/server/main.py)). The open-source library doesn't run inside Workers as shipped: it calls Vectorize through the REST SDK and needs native SQLite.
- **Data model.**
  - An LLM-written fact per vector payload, scoped by `user_id`/`agent_id`/`run_id`, with `actor_id` and `attributed_to`.
  - A history table keeps `previous_value` ([main.py](https://github.com/mem0ai/mem0/blob/main/mem0/memory/main.py)).
  - No readable files.
- **Writes.** Since 2026-04 an add is one LLM call that returns facts, plus embeddings, md5 dedup and entity extraction. It only adds, never updating or deleting ([v2→v3](https://docs.mem0.ai/migration/oss-v2-to-v3)).
- **Contradictions.**
  - **Open source:** "the new fact is stored alongside the old one. Retrieval handles ranking."
  - **Platform:** Dream supersedes, with `latest_only` ([Dream](https://github.com/mem0ai/mem0/blob/main/docs/platform/features/dream.mdx)).
- **Retrieval.** Semantic, BM25 and entity-overlap scores fused into one; an optional rerank adds 150–200 ms ([advanced retrieval](https://docs.mem0.ai/platform/features/advanced-retrieval)).
- **Integrations.**
  - **Hermes:** a provider.
  - **OpenClaw:** a plugin that takes the exclusive memory slot ([docs](https://docs.mem0.ai/integrations/openclaw)).
  - **Others:** Claude Code and Cursor, both Platform-tagged.
- **Weak points:**
  - Concurrency bugs are open, such as duplicate memories from a dedup race ([#6515](https://github.com/mem0ai/mem0/issues/6515)) and "database is locked" ([#7196](https://github.com/mem0ai/mem0/issues/7196)).
  - In the open-source version, deleted text survives in the history table until `reset()`.
  - Telemetry is on by default.
- **Price** ([pricing](https://mem0.ai/pricing)): Hobby free (10k adds), Starter $19, Pro $249 (Dream, graph view), Enterprise custom.
- **Benchmarks (vendor claim)** are disputed:
  - Zep's rebuttal ([Zep](https://www.getzep.com/blog/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/));
  - Letta's filesystem baseline at 74.0% ([Letta](https://www.letta.com/blog/benchmarking-ai-agent-memory/));
  - Mem0's own pages disagree with each other on its 2026 figures.

---

## 3. What Hermes and OpenClaw support today

This decides C1 more than any engine does. Versions checked: Hermes v0.21.5 (2026-09-24), OpenClaw 2026.10.1-beta.1 (2026-10-05).

**Hermes Agent** ([memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory), [providers](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers), [plugin guide](https://hermes-agent.nousresearch.com/docs/developer-guide/memory-provider-plugin), [MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp), [profiles](https://hermes-agent.nousresearch.com/docs/user-guide/profiles))
- **Its own memory files.** `MEMORY.md` and `USER.md` are entries separated by `\n§\n`, with hard caps of 2,200 and 1,375 characters. Over the cap, the tool returns an error.
- **Frozen snapshot.** "The system prompt injection is captured once at session start and never changes mid-session." A hand edit only shows up in the next session.
- **One external provider at a time,** and "the built-in memory is always active alongside it". The providers listed are:
  - Honcho, OpenViking, Mem0, Hindsight, Holographic, RetainDB, ByteRover, Supermemory, Memori.

  Packaging varies: some are bundled, some come from the catalog, and the split changes weekly.
- **Writing a provider is a supported path.** The `MemoryProvider` hooks are `prefetch`, `sync_turn`, `on_session_end`, `on_pre_compress` and `on_memory_write`; the last mirrors built-in writes, with `previous_content`.
- **MCP client** over stdio or HTTP, with OAuth 2.1. An MCP memory server gives tools, but no automatic prefetch or capture (inference).
- **Profiles.** "Never point two agent processes at the same profile… agents that need shared memory should use an external memory provider."
- **Skills.** Agent Skills, with `skills.external_dirs` (for example `~/.agents/skills`).

**OpenClaw** ([memory](https://docs.openclaw.ai/concepts/memory), [memory search](https://docs.openclaw.ai/concepts/memory-search), [memory config](https://docs.openclaw.ai/reference/memory-config), [plugins](https://docs.openclaw.ai/tools/plugin), [MCP](https://docs.openclaw.ai/cli/mcp)). MIT.
- **Its own memory.** Free-form Markdown in a workspace: `USER.md`, `MEMORY.md`, daily `memory/YYYY-MM-DD.md` notes, `DREAMS.md`, `AGENTS.md`, `SOUL.md`, `skills/`.
  - Its limits are injection budgets, not write caps: `USER.md` gets 4,000 characters, the bootstrap files 20,000 each and 60,000 in total.
  - "Dreaming" consolidates the daily notes into `MEMORY.md`.
- **Search** is hybrid BM25 plus vectors in SQLite. **`memory.search.extraPaths` indexes outside folders**, such as a clone of the vault.
- **The memory slot is exclusive:** "`plugins.slots.<slot>` … picks one plugin for an exclusive category".
  - **Take the slot:** Mem0, Supermemory, LanceDB.
  - **Run alongside the built-in memory:** Honcho, and the bundled `memory-wiki`, which can render an Obsidian vault ([memory-wiki](https://docs.openclaw.ai/plugins/memory-wiki)).
- **MCP client** under `mcp.servers`, plus `openclaw mcp serve`. Skills follow the Agent Skills spec.

**Between the two**
- Their memory files aren't compatible.
- Each has a one-time import from the other: `hermes claw migrate` and OpenClaw's "Import Memory". Neither reads the other live.
- The common ground is Markdown, Agent Skills and MCP.
- There is no ratified memory standard. A W3C community group started in June 2026 ([CG](https://www.w3.org/community/ai-agent-memory-interop/)), and neither platform has adopted anything from it.

---

## 4. Other systems (triage)

| System | License | Canonical data and export | Access | Retrieval and consolidation | Notes |
|---|---|---|---|---|---|
| [ai-memory](https://github.com/akitaonrails/ai-memory) | MIT | **A Markdown wiki in git.** SQLite is a derived, rebuildable index. A watcher picks up hand edits. | Rust binary or Docker; MCP plus hooks; **first-party integrations with Hermes and OpenClaw**; HTTP server for several machines | RRF over FTS5, entities and the link graph (vectors optional); a bounded LLM rerank that keeps the local order on failure; a `supersedes` chain, decay, contradiction flags | 8.8k★, v2.5.2 (2026-10-01). Already reviewed in [note 02](02-memory-and-learning.md), including its [measured Jev reranker](https://github.com/akitaonrails/ai-memory/blob/main/docs/jev-reranker-adapter.md) |
| [Letta MemFS](https://docs.letta.com/concepts/memfs) | Apache-2.0 | One git repo of Markdown per agent. Root files are always in context; `MEMORY.md` points to the rest. | TypeScript harness; [shared memory](https://docs.letta.com/concepts/shared-memory) is Letta Cloud only | "Dreaming" after N steps or at compaction, by subagents in git worktrees | letta-code v0.34.4 (2026-10-04). The `.af` export was removed from Letta Code |
| [Basic Memory](https://github.com/basicmachines-co/basic-memory) | AGPL-3.0 | Markdown with frontmatter: facts as `- [category] fact`, relations as `- rel [[Target]]` ([format](https://github.com/basicmachines-co/basic-memory/blob/main/docs/NOTE-FORMAT.md)). Obsidian works on the same files. | Python; MCP; Hermes and OpenClaw integrations | Hybrid FTS plus vectors, an optional rerank, and `locked: true` notes. No consolidation or supersession found | 4.1k★, v0.23.2 |
| [Hindsight](https://github.com/vectorize-io/hindsight) | MIT | Postgres is the truth. A full ZIP export per bank; Markdown is only a mirror. | REST, TypeScript client, MCP, a Hermes provider | Semantic, BM25, graph and temporal search fused by RRF, then a cross-encoder; consolidation into observations that keep their evidence | 46k★, v0.10.2 |
| [Graphiti](https://github.com/getzep/graphiti) / Zep | Apache-2.0 / managed | A graph database (Neo4j, FalkorDB); not readable | Python; MCP | Bi-temporal facts with validity windows: old facts are invalidated, not deleted | Zep's open-source edition is deprecated |
| [Cognee](https://github.com/topoteretes/cognee), [MemOS](https://github.com/MemTensor/MemOS) | Apache-2.0 (Cognee is open-core) | A graph plus vectors | Python; MCP; plugins | Knowledge-graph extraction | Database-canonical |
| [LangMem](https://github.com/langchain-ai/langmem), [Memobase](https://github.com/memodb-io/memobase) | MIT / Apache-2.0 | Database-canonical | Python | Background extraction | Stale (2025-10 and 2026-01) |
| [Anthropic memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) | API | Files under `/memories`, in storage the application chooses | `view`, `create`, `str_replace`, `insert`, `delete`, `rename` | None: the model curates | A file-operation interface Kelpie can implement over the vault |
| [Cloudflare Agent Memory](https://blog.cloudflare.com/introducing-agent-memory/) | Closed, private beta | Durable Objects plus Vectorize. "Every memory is exportable", with no format given | `env.MEMORY` binding plus REST | Five retrieval channels (FTS, fact key, raw messages, vector, HyDE) fused by RRF; supersession with version chains | The most native to Workers, but closed |
| [OKF v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md) | Apache-2.0 | A format: Markdown plus YAML, `index.md`, `log.md`, `status`, `stale_after`, `verified`, `sources` | — | — | ADR-0016 already uses its `index.md` and `log.md` |

**Shortlist for the comparison:**
- **ai-memory:** closest to the criteria, and adoptable as-is.
- **Letta MemFS:** the design to copy for tiers and dreaming.
- **Basic Memory:** a fact syntax that stays readable in Obsidian.

Hindsight is the pick if a database as the truth were acceptable, which C2 rules out.

---

## 5. Kelpie's own plan, scored

**The plan as accepted**
- **[ADR-0005](../adr/0005-context-store.md):** a Context Store Worker over a private GitHub repo. A Durable Object holds the working copy, writes are batched commits, and human edits merge three-way.
- **[ADR-0006](../adr/0006-personal-data-storage.md):** profiles, facts and episodes about people live in one Durable Object per user, never in git. They are exposed as virtual Markdown that can be exported.
- **[ADR-0016](../adr/0016-vault-second-brain.md):** the vault is plain Markdown, Agent Skills, `AGENTS.md` and Hermes's file names. Every index is derived, and removing Kelpie loses no knowledge.
- **[ADR-0017](../adr/0017-history-compaction.md):** summary checkpoints keep a conversation bounded.
- **[Note 02](02-memory-and-learning.md):** five memory types, supersession rather than deletion, and Jev as gatekeeper.

**Strengths**
- **C2, no lock-in,** holds by construction: the canonical data is readable Markdown in a repo the owner owns, and `git clone` is the export.
- **C3, open source:** it is the owner's own MIT code.
- **C6, fit:** it runs on Workers, and Jev's reranking already runs in production ([ADR-0018](../adr/0018-jev-direct-api.md)).

**Gaps the new criteria expose**
1. **It isn't built yet.** [Story 3.8 (#41)](https://github.com/guedesdiogo/kelpie/issues/41), the Context Store v1, is Ready and sized L. Today "ours" is a design.
2. **C1 isn't met.** Sharing relies on symlinked Hermes files and git sync. That conflicts with Hermes's profile rule and its frozen per-session snapshot. OpenClaw isn't covered at all, and edits arrive one push later at best.
3. **"Export everything" against ADR-0006.** The vault holds knowledge, skills, persona and the owner's own profile. Facts and episodes about other people, plus conversation summaries, sit in Durable Objects. A complete export has to bundle both, and the right to erasure stays possible only because that part never enters git history.
4. **C4 and C5 are designed, not specified.** There is no fact format with supersession yet, no consolidation job, and no token-budgeted context call.

---

## 6. Comparison

Legend: ✅ meets the criterion, ⚠️ partly or with a condition, ❌ doesn't meet it.

| | C1 every platform at once | C2 no lock-in | C3 open source | C4 grows (supersedes, provenance) | C5 orchestration | C6 fits Kelpie |
|---|---|---|---|---|---|---|
| **Supermemory** | ✅ plugins for Hermes and OpenClaw, with one shared tag (cloud) | ❌ closed engine, capped export, no re-import | ⚠️ open-core | ✅ versions with `isLatest` | ⚠️ hybrid plus rerank, no budget | ❌ SaaS; personal data leaves the stack |
| **Honcho** | ✅ Hermes, OpenClaw (alongside), MCP | ❌ no export, provenance lost on re-import | ⚠️ AGPL server | ⚠️ conclusions keep sources, but outdated ones are deleted | ✅ `context(tokens)`, dialectic | ❌ Postgres plus a worker outside Workers, or SaaS |
| **Mem0** | ✅ Hermes, OpenClaw (takes the slot), hosted MCP | ❌ export Platform-only, truth in a vector store | ✅ Apache-2.0, ⚠️ best features Platform-only | ⚠️ supersession on Platform only | ⚠️ fused scores, no budget | ❌ Python or REST, open concurrency bugs |
| **ai-memory** | ✅ first-party Hermes and OpenClaw, MCP, HTTP | ✅ Markdown in git, rebuildable index | ✅ MIT | ✅ supersedes, decay, contradiction flags | ✅ RRF plus a bounded rerank (Jev measured) | ⚠️ a 24/7 Rust server outside Cloudflare |
| **Basic Memory** | ✅ Hermes, OpenClaw, MCP | ✅ Markdown, Obsidian | ⚠️ AGPL (separate service only) | ❌ no supersession found | ⚠️ hybrid plus rerank | ⚠️ a Python service outside Cloudflare |
| **Letta MemFS** | ⚠️ shared repos on Letta Cloud only | ✅ git Markdown | ✅ Apache-2.0 | ✅ dreaming | ✅ tiers | ❌ its own harness; a design to borrow |
| **Kelpie, as accepted** | ❌ symlinks and git sync; no OpenClaw | ✅ | ✅ | ⚠️ designed | ⚠️ designed | ✅ |
| **Kelpie, improved (§8)** | ✅ MCP plus adapters, single writer | ✅ | ✅ | ✅ borrowed techniques | ✅ tiers, RRF, Jev rerank, budget | ✅ on Workers; personal data per ADR-0006 |

---

## 7. Options

- **A. A product as the canonical store** (Supermemory, Honcho or Mem0). It fails C2 for all three, as in §2. **Rejected.**
- **B. A product as a derived engine fed from the vault.** For example, self-hosted Honcho rebuilt from the vault and the per-user data.
  - **For:** it adds better user modeling.
  - **Against:**
    - another service to run;
    - personal data sent to it (LGPD, the same reasoning as Jev's masking);
    - captures from Hermes and OpenClaw would land in the engine, not in the vault.
  - **Verdict:** possible later, behind the Context Store's interface. Not now.
- **C. Adopt ai-memory as the shared hub.** It meets C1–C5 today. The cost:
  - a 24/7 host outside Cloudflare, and Kelpie becomes one more MCP/HTTP client;
  - its wiki layout differs from ADR-0016's vault;
  - its multi-user model doesn't filter reads by author ([note 02](02-memory-and-learning.md)). That is fine while Kelpie is single-player ([ADR-0015](../adr/0015-single-player-first.md)), but colleagues' personal data still can't go into it (ADR-0006).
- **D. Improve Kelpie's own plan.** Keep the vault, and build the shared access layer on Workers with borrowed techniques. It fits every criterion and the architecture, but it is the most work, starting with Story 3.8.

**The deciding question between C and D:** is the owner willing to run, and keep running, a server outside Cloudflare for memory? If yes, C gets him there sooner. If no, D.

---

## 8. Recommendation: option D, in three phases

**Architecture**

```
           Hermes ──(provider plugin)──┐
         OpenClaw ──(MCP + extraPaths)─┤
  Claude Code, … ──(MCP)───────────────┼──▶ Context Store (Worker + DO, single writer)
           Kelpie ──(RPC)──────────────┘      │  gates: injection scan, personal-data gate,
                                              │         supersession, staging for rules/skills
   Obsidian ──(git push, webhook)─────────────┤
                                              ├──▶ vault: private git repo, Markdown (truth)
                                              ├──▶ per-user DOs (ADR-0006): people's data
                                              └──▶ derived indexes: D1 FTS5 + Vectorize (rebuildable)
```

- **One writer.** The Context Store's Durable Object serializes every write, from any platform, then commits to the vault (ADR-0005).
- **One authenticated MCP endpoint**, with a Cloudflare Access service token or OAuth. It offers:
  - `memory_search`, `memory_get` and `memory_context(tokens)`;
  - `memory_write`, with supersession;
  - `memory_profile`;
  - the [memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) commands.

  Honcho's MCP server shows that this runs as a Worker.
- **Other platforms' own files become rendered digests.**
  - **Hermes:** `MEMORY.md` and `USER.md` are re-rendered within 2,200 and 1,375 characters.
  - **OpenClaw:** its bootstrap files.
  - **For both:** a write to these files, mirrored back (Hermes's `on_memory_write`), becomes a vault write that goes through the gates.
- **Adapters per platform**
  - **Hermes:** a small Python `MemoryProvider` plugin. `prefetch` calls `memory_context`, `sync_turn` and `on_session_end` capture, and `on_memory_write` mirrors. Without the plugin, Hermes gets MCP tools only, with no automatic recall or capture.
  - **OpenClaw:**
    - **Reading:** `memory.search.extraPaths` over a clone of the vault.
    - **Writing:** MCP tools. Automatic capture would need a plugin that runs alongside memory-core, the way Honcho's does. One that takes the slot would keep OpenClaw's writes in its own store.
  - **Manual editing:** Obsidian on a clone, with obsidian-git. Edits arrive through the push webhook and the three-way merge (ADR-0005).
- **Trust.** Writes from Hermes and OpenClaw count as untrusted agent writes, exposed to the memory poisoning described in [note 02](02-memory-and-learning.md) (MINJA). They pass the same gates as Kelpie's own. Rules and skills still go through a pull request.

**What makes memory grow and context stay efficient**
- **Facts with supersession and provenance**, in readable Markdown.
  - Fact lines in Basic Memory's style.
  - Frontmatter with:
    - `id` (a content hash, so re-ingesting is idempotent);
    - `supersedes` and `superseded_by`, so a read can ask for the latest only;
    - `sources`, as Honcho's `source_ids`;
    - `level`, from explicit to inferred;
    - `valid_from` and `invalid_at` (Graphiti);
    - `status`, `stale_after` and `verified` (OKF).
  - Nothing is deleted except through erasure.
- **Tiers** (Letta):
  - a small always-loaded digest that fits Hermes's caps;
  - everything else is retrieved.
- **Retrieval:**
  - RRF fusion of FTS, entity lookup, the link graph and vectors;
  - an authority weight that ranks rules and decisions above episodes;
  - one bounded rerank by Jev, which already runs in production, keeping the local order on failure (ai-memory);
  - `memory_context(tokens)` with a fixed split between profile, facts and recent material (Honcho).
- **Consolidation** ("dreaming"): off the hot path, on Durable Object alarms or Workflows, triggered by thresholds and idle time.
  - It merges duplicates and supersedes stale facts.
  - It flags contradictions.
  - It keeps evidence, so every conclusion links to its sources.
- **Profile digest.** A static plus dynamic profile (Supermemory), rendered as `USER.md` for every platform.

**Phases**
1. **Context Store v1 and shared access.**
   - Story 3.8, with the fact format and supersession.
   - The MCP endpoint with authentication.
   - OpenClaw reads through MCP and `extraPaths`; Obsidian through obsidian-git.
2. **The Hermes provider plugin,** plus the rendered `MEMORY.md` and `USER.md` digests.
3. **Consolidation,** the profile digest, decay, contradiction flags, and the token-budgeted context.
4. **Optional, later:** an external engine (option B) behind the same interface, only if retrieval quality calls for it.

**What "export everything" means here**
- The vault clone: knowledge, facts, skills, persona, the owner's profile and the log.
- An export command that renders the per-user Durable Object data as Markdown into the same layout.
- Third parties' data is included only in an export the owner requests for himself, and stays erasable because it never enters git history.

---

## 9. What to borrow, by source

| From | Technique |
|---|---|
| Supermemory | The memory-entry schema (`version`, `parentMemoryId`, `isLatest`, `isForgotten`, `forgetAfter`, the updates, extends and derives relations); a static plus dynamic profile digest; idempotent upsert by `customId`; soft-forget with a reason, and a dry-run mass forget |
| Honcho | Conclusions with `level`, `source_ids` and `times_derived`; fast writes with background derivation and idle-triggered dreaming; `context(tokens)` with a fixed split; an MCP server as a Worker |
| Mem0 | Scoping and attribution (`actor_id`, `attributed_to`); a text hash for idempotent writes; scores fused across semantic, BM25 and entity overlap. One idea, untested: a small Mem0-compatible REST subset would let Hermes's and OpenClaw's Mem0 integrations write into Kelpie |
| ai-memory | Markdown in git as truth, with a rebuildable index; RRF across streams with an authority weight; a bounded rerank that keeps the local order on failure; access-weighted decay; an advisory contradiction band; memory text treated as untrusted data in prompts |
| Letta MemFS | Root files always in context, with `MEMORY.md` signposts to the rest; dreaming after N turns or at compaction, with an optional review |
| Basic Memory | `- [category] fact` and `- relation [[Target]]` lines; `permalink` as an ID that survives moves; `locked: true` for notes a human owns |
| Graphiti | `valid_at` and `invalid_at` windows on facts |
| Cloudflare Agent Memory | Fact-key lookups ranked highest; HyDE; SHA-256 IDs; dates in queries resolved with arithmetic, not the LLM; forward pointers from superseded facts |
| OKF | `status`, `stale_after`, `verified`, `sources`, and `log.md` |
| Anthropic memory tool | The `memory_20250818` commands as the file interface Kelpie offers to models |

---

## 10. Decisions for the owner

1. **Canonical store.** Keep the Markdown vault in git as the single truth (ADR-0016)? Recommended: yes.
2. **Build or adopt.** Option D, built on Workers, or option C, ai-memory on a host he runs? Recommended: D, unless he wants shared memory sooner and accepts a 24/7 server.
3. **ADR-0016's sharing mechanism.** Replace symlinks and git sync with the Context Store as single writer, MCP access, and Hermes's and OpenClaw's files as rendered digests? This amends ADR-0016. Recommended: yes.
4. **Integration depth.**
   - **Hermes:** a provider plugin, for automatic recall and capture, or MCP tools only?
   - **OpenClaw:** MCP plus `extraPaths`, or also a capture plugin that runs alongside memory-core?

   Recommended: the Hermes plugin in phase 2; for OpenClaw, MCP plus `extraPaths` first.
5. **Export scope.** The vault plus the per-user data rendered as Markdown, with third parties' data only in the owner's own export? Recommended: yes.
6. **External engines.** Kept as an optional derived index behind the interface, and not adopted now? Recommended: yes.

## 11. Risks

- **Memory poisoning from another agent's writes.** Each platform is one more writer. The gates in §8 apply to all of them, and rules and skills stay behind a pull request.
- **Hermes's caps.** The digests must stay within 2,200 and 1,375 characters, so the always-loaded tier must be curated.
- **Moving targets.** Hermes's providers, OpenClaw's plugins and these products changed packaging within weeks of this note. The adapters should stay thin.
- **Effort.** Phase 1 contains Story 3.8, sized L, plus the MCP endpoint. Option D is months of work, not weeks.
- **LGPD.** Any engine outside the stack (options A and B) receives personal data, and needs the same masking reasoning as Jev ([ADR-0018](../adr/0018-jev-direct-api.md)).

---

## Sources

**Supermemory:** [site](https://supermemory.ai/) · [repo](https://github.com/supermemoryai/supermemory) · [self-hosting](https://supermemory.ai/docs/self-hosting/overview) · [local vs enterprise](https://supermemory.ai/docs/self-hosting/local-vs-enterprise) · [how it works](https://supermemory.ai/docs/concepts/how-it-works) · [container tags](https://supermemory.ai/docs/concepts/container-tags) · [memories list API](https://supermemory.ai/docs/api-reference/content-management/list-memory-entries-with-history) · [export changelog](https://supermemory.ai/changelog/request-a-data-export-from-settings/) · [pricing](https://supermemory.ai/pricing) · [security](https://supermemory.ai/docs/overview/security) · [hermes-supermemory](https://github.com/supermemoryai/hermes-supermemory) · [OpenClaw](https://supermemory.ai/docs/integrations/openclaw) · [LongMemEval claim](https://supermemory.ai/research/longmembench/)

**Honcho:** [site](https://honcho.dev/) · [repo](https://github.com/plastic-labs/honcho) · [self-hosting](https://honcho.dev/docs/v3/contributing/self-hosting) · [configuration](https://honcho.dev/docs/v3/contributing/configuration) · [OpenAPI](https://honcho.dev/docs/v3/openapi.json) · [#721 export](https://github.com/plastic-labs/honcho/issues/721) · [#528 import](https://github.com/plastic-labs/honcho/issues/528) · [dreaming](https://honcho.dev/docs/v3/documentation/features/advanced/dreaming) · [deleting data](https://honcho.dev/docs/v3/documentation/features/advanced/deleting-data) · [Hermes](https://honcho.dev/docs/v3/guides/integrations/hermes) · [OpenClaw](https://honcho.dev/docs/v3/guides/integrations/openclaw) · [MCP](https://honcho.dev/docs/v3/guides/integrations/mcp) · [evals](https://honcho.dev/evals)

**Mem0:** [site](https://mem0.ai/) · [repo](https://github.com/mem0ai/mem0) · [platform vs OSS](https://docs.mem0.ai/platform/platform-vs-oss) · [v2→v3](https://docs.mem0.ai/migration/oss-v2-to-v3) · [export](https://docs.mem0.ai/platform/features/memory-export) · [MCP](https://docs.mem0.ai/platform/mem0-mcp) · [#6530 OpenMemory removed](https://github.com/mem0ai/mem0/pull/6530) · [OpenClaw](https://docs.mem0.ai/integrations/openclaw) · [Hermes](https://docs.mem0.ai/integrations/hermes) · [pricing](https://mem0.ai/pricing) · [paper](https://arxiv.org/abs/2504.19413)

**Platforms:** Hermes [memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory) · [providers](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers) · [provider plugin](https://hermes-agent.nousresearch.com/docs/developer-guide/memory-provider-plugin) · [profiles](https://hermes-agent.nousresearch.com/docs/user-guide/profiles) · [MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp) · OpenClaw [memory](https://docs.openclaw.ai/concepts/memory) · [memory search](https://docs.openclaw.ai/concepts/memory-search) · [memory config](https://docs.openclaw.ai/reference/memory-config) · [plugins](https://docs.openclaw.ai/tools/plugin) · [memory-wiki](https://docs.openclaw.ai/plugins/memory-wiki) · [MCP](https://docs.openclaw.ai/cli/mcp)

**Others:** [ai-memory](https://github.com/akitaonrails/ai-memory) · [Letta MemFS](https://docs.letta.com/concepts/memfs) · [Basic Memory](https://github.com/basicmachines-co/basic-memory) · [Hindsight](https://github.com/vectorize-io/hindsight) · [Graphiti](https://github.com/getzep/graphiti) · [Cognee](https://github.com/topoteretes/cognee) · [MemOS](https://github.com/MemTensor/MemOS) · [Anthropic memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) · [Cloudflare Agent Memory](https://blog.cloudflare.com/introducing-agent-memory/) · [OKF](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md) · [Agent Skills](https://agentskills.io/specification) · [W3C memory interop CG](https://www.w3.org/community/ai-agent-memory-interop/)
