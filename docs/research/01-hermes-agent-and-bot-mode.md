> Research note written on 2026-10-03 for the Kelpie viability study, translated from Portuguese. Corrections across notes are tracked in [00-cross-check.md](00-cross-check.md).

# Research 01 — Hermes Agent, Hermes Bot Mode (and comparison with OpenClaw / moltworker)

Date: 2026-10-03 · Scope: read-only · Author: research agent

Commits read (all URLs below are pinned to them):

| Repo | Commit | Commit date |
|---|---|---|
| `NousResearch/hermes-agent` | `5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662` | 2026-10-03 |
| `NousResearch/Hermes-Bot-Mode` | `80fee22582b871b9765a65e2992b8b5a8211c9f8` | 2026-08-16 (archived) |
| `cloudflare/moltworker` | `7b00c1d7292190f2327e93bdcc7a0eabb0a26123` | 2026-03-29 |
| `openclaw/openclaw` | `6b230c82fc52161e644b9e94c17dd30ccc680b72` | 2026-10-03 |

All citations are URLs pinned to the commits above (`blob/<sha>/<path>#L<a>-L<b>`). Short citations inside the text (e.g. `agent-loop.md`) refer to files listed with their full URL in the Sources section.

Evidence markers: **[code]** = confirmed in the source code; **[doc]** = confirmed in the repository's own documentation (primary source, but may diverge from the code; see Risks); **(unverified)** = not confirmed in any source.

---

## TL;DR

1. **Hermes Agent is a monolithic, long-running Python harness, a "personal agent".** A single `AIAgent` serves the CLI, the messaging gateway (~25 platforms), TUI, desktop, ACP and an OpenAI-compatible API server [doc] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/developer-guide/architecture.md`). State lives in files under `~/.hermes` (per *profile*) plus SQLite/FTS5 (`state.db`). MIT license [code] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/LICENSE`). None of it runs on Workers as is; the value is in the **patterns**.
2. **Memory = two Markdown files with a character budget** (`MEMORY.md` 2,200 chars, `USER.md` 1,375 chars), entries separated by `\n§\n`, written by the `memory` tool (add/replace/remove by substring), with an anti-injection scan and a file lock [code] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/tools/memory_tool_store.py#L23`, `#L99`, `#L168-L207`, `#L287`). They enter the system prompt as a **snapshot frozen at the start of the session** (so as not to break the prompt cache) [code+doc]. Consequence: memory only "pays off" at session boundaries, and in the gateway sessions **never reset on their own** [doc] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/user-guide/sessions.md`, "Session continuity"). For WhatsApp we have to define the boundaries (idleness) ourselves.
3. **`USER.md` belongs to a single owner.** The built-in has no per-end-user profile; per-user modeling exists only via Honcho (external plugin) with *peer aliases* by runtime ID [doc] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/user-guide/features/memory-providers.md`). For multi-tenant/multi-user this is a gap we will have to design.
4. **Learning loop = background fork after the turn.** Every 10 user turns (memory) or 10 tool iterations (skills), a cloned `AIAgent` rereads the conversation and decides whether to save memory / create-or-patch a skill [code] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/agent/turn_context.py#L745-L754`, `https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/agent/turn_finalizer.py#L737-L766`, `https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/hermes_cli/config_defaults.py#L1324`). The code itself estimates ~30K tokens per event. There is a `write_approval` gate that **stages** writes for human approval [doc]. A *curator* archives idle skills (stale 14 d, archive 30 d) deterministically; LLM consolidation is opt-in [doc] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/user-guide/features/curator.md`).
5. **Skills = the Agent Skills standard (SKILL.md with frontmatter) with *progressive disclosure*** (`skills_list` → `skill_view(name)` → `skill_view(name, path)`), index injected into the prompt with a "load it if relevant" instruction [code+doc] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/agent/prompt_builder.py#L1359`, `#L1480-L1499`; `https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/user-guide/features/skills.md`). Selection is done by the model itself, not by retrieval.
6. **Batching of fragmented messages exists, but it is opt-in per adapter and too short for our case.** The base class has a 0.0 s delay; only Telegram, WhatsApp (Baileys), Discord, Matrix, WeCom, Weixin and SimpleX enable batching (Slack, Signal, WhatsApp Cloud API and others do not). When active: per-session debounce of 0.3 s (cap 2 s); 1 s (cap 4 s) only when the last fragment is near the client's split limit (≥4,000 chars on Telegram, ≥6,000 on WhatsApp) [code] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/gateway/platforms/base.py#L2518-L2635`). It is meant for "pasting long text", not for a human typing in bursts. OpenClaw documents a per-channel `debounceMs` (example: WhatsApp 5,000 ms) [doc] (`https://github.com/openclaw/openclaw/blob/6b230c82fc52161e644b9e94c17dd30ccc680b72/docs/concepts/messages.md`).
7. **Hermes does not do "humanized replies in several bubbles".** It only splits by channel size limit with `(1/3)` markers [code] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/gateway/platforms/base.py#L4874-L4880`); `human_delay` (800–2500 ms) is applied **only to attachments** (single call site: `#L4450`) [code]; WhatsApp waits a fixed 0.3 s between chunks "to avoid rate limit" [code] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/plugins/platforms/whatsapp/adapter.py#L636-L651`). The right reference for our requirement is OpenClaw's **block streaming**: paragraph→line→sentence chunker, idle-based coalescing and `humanDelay` between blocks [doc] (`https://github.com/openclaw/openclaw/blob/6b230c82fc52161e644b9e94c17dd30ccc680b72/docs/concepts/streaming.md`).
8. **Policy for a message that arrives while the agent is busy is a product decision.** Hermes: `interrupt` (default) / `queue` / `steer` [code+doc] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/gateway/run.py#L3393`; `https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/user-guide/messaging/index.md`). OpenClaw: `steer` default, debounce 500 ms, `cap` 20, `drop: summarize` [doc] (`https://github.com/openclaw/openclaw/blob/6b230c82fc52161e644b9e94c17dd30ccc680b72/docs/concepts/queue.md`).
9. **No Composio.** A search across the whole repo found only a design template, tests and eval comments; there is no integration [code]. MCP is strong: stdio + HTTP with OAuth 2.1/PKCE/device-code, per-server filtering and *Tool Search* (3 bridge tools with on-demand schema loading) [doc] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/user-guide/features/mcp.md`, `tool-search.md`).
10. **Subscription login exists, with serious caveats.** Anthropic OAuth "routes as Claude Code" and only works on Max with extra credits (not Pro); Codex/ChatGPT quota semantics are "undocumented" [doc] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/integrations/providers.md#L136-L150`). In a public multi-tenant product this is a legal/operational risk (check each provider's terms).
11. **Multi-agent in Hermes = isolated *profiles*** (one directory per agent: config, `.env`, `SOUL.md`, memory, skills, cron, `state.db`), served by a multiplexed gateway [doc] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/user-guide/profiles.md`, `developer-guide/multiplexing-gateway.md`). Delegation: subagents with a blank context, only the summary comes back; depth 1 by default; tools blocked for children (`memory`, `send_message`, `cronjob`, `clarify`, `delegate_task`) [code+doc].
12. **Hermes-Bot-Mode** (archived on 2026-08-16, now in `apps/desktop/src/plugins/hermes-bots/`) is a UI on top of profiles: bot roster with avatar and "forever chat", sections, "Active now", creation with advanced options (model, SOUL.md, skills/toolsets/MCP per bot), routines (cron), group rooms (2–6 bots, up to 3 rounds, 10 msgs) and bot-to-bot with `message_agent` [doc] (`https://github.com/NousResearch/Hermes-Bot-Mode/blob/80fee22582b871b9765a65e2992b8b5a8211c9f8/README.md`; `https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/user-guide/bot-mode.md`). Excellent UX reference; the multi-tenant layer is missing (tenant, RBAC, per-tenant credentials).
13. **moltworker proves the limit of "pure Workers".** It runs OpenClaw inside a **Cloudflare Sandbox container** (`standard-1`, `max_instances: 1`, a single sandbox id `openclaw`), with a squashfs backup in R2, a cron every minute to wake the container and a CDP shim over Browser Rendering [code] (`https://github.com/cloudflare/moltworker/blob/7b00c1d7292190f2327e93bdcc7a0eabb0a26123/wrangler.jsonc`, `https://github.com/cloudflare/moltworker/blob/7b00c1d7292190f2327e93bdcc7a0eabb0a26123/src/index.ts#L157`, `https://github.com/cloudflare/moltworker/blob/7b00c1d7292190f2327e93bdcc7a0eabb0a26123/src/cron/handler.ts`, `https://github.com/cloudflare/moltworker/blob/7b00c1d7292190f2327e93bdcc7a0eabb0a26123/src/routes/cdp.ts`). README: "Experimental … proof of concept". Lesson: a long-running WS gateway, Baileys (WhatsApp Web), a workspace filesystem and a terminal do **not** fit in Workers/DO; we need webhooks (WhatsApp Cloud API), state in DO/R2 and remote tools.

---

## Findings (by topic)

### 1. Overall architecture and agent loop (Hermes)

- **Entry points → `AIAgent` → backends.** CLI (`cli.py`), Gateway (`gateway/run.py`), ACP, batch runner, API server and Python library converge on `AIAgent` (`run_agent.py` is a facade; the loop lives in `agent/conversation_loop.py` + `agent/turn_*.py`) [doc] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/developer-guide/architecture.md`, `https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/developer-guide/agent-loop.md`).
- **Three API modes**: `chat_completions` (OpenAI-compatible), `codex_responses` (Responses API) and `anthropic_messages`; all converge on an internal OpenAI-style format (`role/content/tool_calls`) [doc] (`agent-loop.md`, "API Modes").
- **Turn cycle**: append the user message → build/reuse the cached system prompt → preflight compression if >50% of context → assemble messages in the provider format → inject ephemeral layers → mark cache (Anthropic) → interruptible call → if there are tool_calls, execute and repeat, otherwise persist and return [doc] (`agent-loop.md`, "Turn Lifecycle"). Default compression threshold `0.50` (0.75 floor for windows <512K) and `protect_last_n: 20` [code] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/hermes_cli/config_defaults.py#L591`, `#L605`).
- **Design invariants** (useful for our design):
  - *Per-conversation prompt cache is sacred*: nothing mutates the system prompt mid-conversation, except compression; changes to skills/memory/tools take effect in the next session [doc] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/AGENTS.md`, "What Hermes Is").
  - *Strict role alternation* and never injecting a synthetic user message in the middle of the loop [doc] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/AGENTS.md`; `agent-loop.md`, "Message Alternation Rules").
  - *Narrow core*: new capability enters as a skill, a tool with `check_fn`, a plugin or MCP, never as a core tool if it can be avoided ("Footprint Ladder") [doc] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/AGENTS.md`).
- **Tools executed in parallel** via `ThreadPoolExecutor` when there are several calls; `memory`, `todo`, `session_search` and `delegate_task` are intercepted before the registry because they touch agent state [doc] (`agent-loop.md`, "Tool Execution", "Agent-Level Tools").
- **Three-layer prompt** `stable → context → volatile`: identity (`SOUL.md`) and tool guides; project context files (`.hermes.md`/`AGENTS.md`/`CLAUDE.md`/`.cursorrules`, the first one that exists); skills index, memory snapshot, user profile, external memory provider block, timestamp and environment [doc] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/developer-guide/prompt-assembly.md`). Plugin context (`pre_llm_call`) and external memory recall go in the **user message of the turn**, not in the system prompt, to preserve the cache [doc] (same file, "API-call-time-only layers").
- **Provider fallback** on 429/5xx/401/403 with a `fallback_providers` list; auxiliary tasks (vision, compression, extraction, review) have their own chain [doc] (`agent-loop.md`, "Fallback Model").

### 2. Memory system

- **Files**: `~/.hermes/memories/MEMORY.md` (agent notes about environment/conventions) and `USER.md` (user profile) [code+doc] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/tools/memory_tool_store.py#L212`; `https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/user-guide/features/memory.md`).
- **Writing**: `memory` tool with actions `add`, `replace`, `remove`; `replace/remove` locate the entry by a unique substring of `old_text`; there is no `read` because the content is already in the prompt [doc] (`memory.md`, "Memory Tool Actions").
- **Limits**: 2,200 / 1,375 characters, configurable; on overflow the tool **returns an error with the current entries** and instructs the model to consolidate *in the same turn* (no auto-compaction) [code+doc] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/tools/memory_tool.py#L56`; `https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/tools/memory_tool_store.py#L287`; `memory.md`, "What Happens When Memory is Full").
- **Format in the prompt**: header with usage (`[67% — 1,474/2,200 chars]`), entries separated by `§` [code] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/tools/memory_tool_store.py#L483-L487`).
- **Frozen snapshot**: captured on `load` and never changed during the session; writes go to disk immediately and only appear in the next session [code] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/tools/memory_tool_store.py#L90`, `#L134`).
- **Security**: injection/exfiltration and invisible-unicode scan on write and on load; exclusive lock on a separate `.lock` file; atomic write [code] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/tools/memory_tool_store.py#L26`, `#L145`, `#L168-L207`, `#L526`).
- **Approval**: `memory.write_approval: true` stages writes outside the interactive CLI; `/memory pending|approve|reject` [doc] (`memory.md`, "Controlling memory writes").
- **History retrieval**: `session_search` over SQLite FTS5 (`state.db`), discovery/scroll/read/browse modes, **no LLM calls** [code] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/tools/session_search_tool.py#L1-L8`). Cron sessions are demoted in ranking and subagent/kanban/tool sessions are hidden [code] (same file, `#L20-L30`).
- **External memory providers** (plugin, one active at a time, run *alongside* the built-in): `MemoryProvider` ABC with `system_prompt_block`, `prefetch`/`queue_prefetch`, `sync_turn`, `on_session_end`, `on_pre_compress`, `on_delegation`, `on_memory_write`, own tools [code] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/agent/memory_provider.py#L84-L203`). Bundled: OpenViking, Mem0, Holographic, RetainDB, ByteRover; Honcho, Hindsight and Supermemory via the catalog [doc] (`memory.md`, "External Memory Providers").
- **Honcho**: dialectic user model (*peers*: one user + one AI peer per profile), base context (session summary, representation, peer card) + dialectic supplement on a cadence; in the gateway, `userPeerAliases`/`runtimePeerPrefix` map platform IDs to peers [doc] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/user-guide/features/honcho.md`; `memory-providers.md`).
- **Compression**: before summarizing the middle of the conversation, memory is flushed; tool_call/result pairs are never separated; compression generates a "child" session (lineage) [doc] (`agent-loop.md`, "Compression and Persistence").
- **Human curation**: `/journey` shows the timeline of learned skills and memories, with `list/delete/edit` per node [doc] (`memory.md`, "Learning Journey").

### 3. Skills and the "learning loop"

- **Format**: `SKILL.md` with frontmatter (`name`, `description`, `version`, `platforms`, `metadata.hermes.{tags,category,related_skills,config,requires_toolsets,fallback_for_toolsets}`) + `references/`, `templates/`, `scripts/` folders; compatible with agentskills.io [doc] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/skills/AGENTS.md`; `skills.md`, "SKILL.md Format"). Internal standard: description ≤ 60 characters [doc] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/skills/AGENTS.md`).
- **Selection**: `<available_skills>` index (name + description per category) in the prompt, with the explicit instruction "if it is even partially relevant, you MUST load it with `skill_view`" [code] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/agent/prompt_builder.py#L1480-L1499`). Progressive disclosure in 3 levels [doc] (`skills.md`, "Progressive Disclosure").
- **Creation/update**: `skill_manage` tool (`create`, `patch` by `old_string/new_string`, `patch` with full content, `delete`, `write_file`, `remove_file`), with an advisory linter (`incident-log-shape`, `references-sprawl` >60 files, `oversized-body` >~24K chars) [doc] (`skills.md`, "Actions").
- **Background review** (`agent/background_review.py`): after the turn, a fork of `AIAgent` that inherits provider/model/system prompt to reuse the cached prefix, runs with a tool whitelist (memory, skills, file read) and writes directly to the stores [code] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/agent/background_review.py#L1-L6`). Triggers:
  - memory: user-turn counter, default 10 [code] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/agent/turn_context.py#L745-L754`; `https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/agent/agent_init.py#L1328`, `#L1352`);
  - skills: tool iterations in the turn, default 10 [code] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/agent/turn_finalizer.py#L737-L743`; `https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/agent/agent_init.py#L1407-L1409`);
  - does not run in cron (`skip_background_review`; comment: "~30K tokens / event") [code] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/agent/turn_finalizer.py#L751-L766`).
- **Review prompts** are worth copying almost verbatim: routing USER.md vs MEMORY.md ("a fact goes to ONE store"), "a skill is the procedure for a class of tasks for THIS user", "pitfall = generalizable rule + a one-clause why", do not save environment failures or negative claims about tools, preference order 1) patch the loaded skill 2) existing umbrella 3) support file 4) new umbrella; *read-before-write* enforced by the tool [code] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/agent/background_review.py#L360-L560`).
- **Review on a cheaper model**: `auxiliary.background_review.{provider,model}`; with a different model, the fork uses a *digest* (recent turns + summary) instead of the full transcript; `max_input_tokens` cap (default 75% of the window, max 600K) [doc] (`memory.md`, "Running the review on a cheaper model").
- **Curator**: runs on inactivity (7 d interval, 2 h minimum idleness), only on `created_by: agent` skills; phases: deterministic transitions (stale 14 d → archived 30 d, never deletes) and opt-in LLM consolidation (`curator.consolidate`) [doc] (`curator.md`). Skills referenced by cron and *pinned* skills are exempt [doc].
- **`/learn`**: creates a skill from arbitrary sources (folder, URL, PDF, description) with no extra tool in the schema [doc] (`skills.md`, "Learning a skill from sources").
- **Hub**: install skills from `skills.sh`, ClawHub, LobeHub, direct URL and "official", with a security scanner [doc] (`skills.md`, "Skills Hub").

### 4. Review/learning over past conversations

- **Nudges** = the background-review triggers above (they are not messages visible to the user; in the gateway "💾 Memory updated" appears according to `display.memory_notifications`) [doc] (`memory.md`, "Background review notifications").
- **`session_search`** is the "on-demand" retrieval; the prompt instructs to use it before asking the user to repeat themselves [doc] (`prompt-assembly.md`, Layer 2 example).
- **Heartbeat** (`/heartbeat every 10m …`): a recurring prompt that re-enters the *same* session when idle, as a user message between turns [doc] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/user-guide/features/heartbeat.md`).
- **`/goal`** ("Ralph" loop: keep a goal alive across turns) and **Kanban** (durable board in `kanban.db` shared across profiles, workers as processes) [doc] (`goals.md`, `kanban.md`).
- **OpenClaw, by contrast**, has *dreaming* (background consolidation in light/deep/REM phases, promotes daily notes `memory/YYYY-MM-DD.md` to `MEMORY.md`, writes an auditable `DREAMS.md`) [doc] (`https://github.com/openclaw/openclaw/blob/6b230c82fc52161e644b9e94c17dd30ccc680b72/docs/concepts/dreaming.md`, `https://github.com/openclaw/openclaw/blob/6b230c82fc52161e644b9e94c17dd30ccc680b72/docs/concepts/memory.md`).

### 5. Agent and user profile/identity

- **Agent**: `SOUL.md` in `HERMES_HOME` is slot no. 1 of the prompt (replaces the default identity), scanned and truncated; created automatically, never overwritten [doc] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/user-guide/features/personality.md`; `prompt-assembly.md`). `/personality` presets are session overlays [doc].
- **User**: `USER.md` (one person: the profile's owner). In a gateway with several users, the built-in does not separate profiles; groups have per-user sessions by default (`group_sessions_per_user`) but the memory is the same [doc] (`sessions.md`; `memory.md`). Per-user separation only via Honcho [doc].
- **Bot Mode** adds title, description, avatar and section in `profile.yaml`/`ui_meta`, and injects the *roster* of peers (names + roles) into the prompt of each bot's canonical chat [doc] (`bot-mode.md`, "Bot-to-bot messaging").
- **OpenClaw** separates even more: `AGENTS.md` (instructions), `SOUL.md` (persona), `IDENTITY.md` (name/emoji), `USER.md` (user model as dated active/superseded directives, 4,000-char budget), `MEMORY.md`, daily notes, `BOOTSTRAP.md` [doc] (`https://github.com/openclaw/openclaw/blob/6b230c82fc52161e644b9e94c17dd30ccc680b72/docs/concepts/agent-workspace.md`).

### 6. Messaging gateway

- **Platforms**: Telegram, Discord, Slack, WhatsApp (Baileys/WhatsApp Web via a Node bridge), WhatsApp Cloud API, Signal, SMS, email, Matrix, Mattermost, Teams, Google Chat, LINE, Feishu, WeCom, Weixin, QQ, iMessage (BlueBubbles/Photon), Home Assistant, ntfy, IRC, webhooks and an OpenAI-compatible API server (serves any webchat such as Open WebUI) [doc] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/user-guide/messaging/index.md#L33-L60`; `https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/user-guide/features/api-server.md`). WhatsApp default = Baileys bridge [code] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/plugins/platforms/whatsapp/adapter.py#L1-L2`).
- **Flow**: event → `MessageEvent` → authorization (allowlist + DM pairing) → session key → `AIAgent` with history → delivery [doc] (`architecture.md`, "Gateway Message").
- **Fragmented messages (batching)** [code] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/gateway/platforms/base.py`). It is opt-in: the base uses `_text_batch_delay_seconds = 0.0` and only adapters that call `_configure_text_batch_delays` or override the delays enable it (Telegram, WhatsApp/Baileys, Discord, Matrix, WeCom, Weixin, SimpleX; Feishu also references batching, not verified in detail):
  - `_enqueue_text_event` merges text and media by session key and restarts the timer on every fragment (`#L2574-L2593`);
  - default delay 0.3 s (cap 2.0 s); if the last fragment is ≥ `_SPLIT_THRESHOLD`, it waits 1.0 s (cap 4.0 s) (`#L2518-L2533`, `#L2595-L2598`); configurable via `text_batch_delay_seconds` (`#L2550-L2556`);
  - the flush handles the cancellation race and protects dispatch with `asyncio.shield` (`#L2611-L2635`).
- **Message while the agent is busy**: two guards (the adapter enqueues in `_pending_messages`; the runner intercepts `/stop`, `/new`, `/approve`…) [doc] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/gateway/AGENTS.md`); `interrupt` (default), `queue` or `steer` mode, plus a 0.35 s debounce / 1.0 s cap for bursty text while busy [code+doc] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/gateway/run.py#L3393`; `https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/gateway/platforms/base.py#L112-L113`; `messaging/index.md#L437-L450`).
- **Long replies**: `truncate_message` splits by channel limit preserving code blocks and adds `(1/3)` [code] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/gateway/platforms/base.py#L4874-L4880`); Telegram 4,096 (UTF-16), WhatsApp with a configurable chunk [code] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/plugins/platforms/telegram/adapter.py#L519-L523`; `https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/plugins/platforms/whatsapp/adapter.py#L636-L651`). Streaming by message edit on platforms that support it; "interim assistant messages" (model commentary in the middle of the turn) on by default [doc] (`messaging/index.md#L880-L905`).
- **Human pacing**: `human_delay` `off|natural|custom`, natural 800–2500 ms [code+doc] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/gateway/run_config_loaders.py#L40`, `#L293-L320`; `https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/user-guide/configuration.md#L2676-L2687`). Applied only in `_deliver_attachments` (images, media, files) [code] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/gateway/platforms/base.py#L4446-L4458`).
- **"Typing" indicator**: a task that resends `send_typing` every 2 s (the state expires after ~5 s on the platform), with a timeout per tick, paused during approvals; controllable via `typing_indicator` per platform [code+doc] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/gateway/platforms/base.py#L3402-L3420`; `messaging/index.md#L851-L864`).
- **Robustness**: auto-resume of sessions interrupted by a restart, delivery of an already generated reply as "Recovered reply", delivery ledger [doc] (`messaging/index.md`, "Session resume across gateway restarts").

### 7. Subagents, cron, tools, MCP, providers, persistence, deploy

- **Delegation** (`delegate_task`): up to 10 concurrent children, blank context (only `goal` + `context`), result comes back as a summary; optional `output_schema` with 1 correction turn; children inherit toolsets and credentials; blocked: `delegate_task` (except `role=orchestrator` with `max_spawn_depth` >1), `clarify`, `memory`, `send_message`, `cronjob`; default `max_iterations` 250, `max_spawn_depth` 1 [code+doc] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/hermes_cli/config_defaults.py#L1364`, `#L1379`, `#L1384`; `https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/user-guide/features/delegation.md`). Top-level calls run in the background and return a handle; a process restart does **not** resume a running child [doc] (`delegation.md`, "Lifetime and Durability").
- **Cron**: a single `cronjob_manage` tool (create/list/update/pause/resume/run/remove), formats `30m`, `every 2h`, 5-field cron, ISO; attachable skills; *no-agent* mode (script); webhook trigger; jobs in `jobs.json`; tick every 60 s with a lock; cron sessions cannot create cron [doc] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/user-guide/features/cron.md`; `https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/developer-guide/cron-internals.md`).
- **Tools**: ~70 tools in ~28 toolsets; terminal with 7 backends (local, Docker, SSH, Daytona, Modal, Singularity, Vercel Sandbox), browser, web, vision, `execute_code` [doc] (`architecture.md`).
- **MCP**: `mcp_servers` in `config.yaml`; stdio (subprocess) and HTTP; `auth: oauth` with discovery, DCR, PKCE, refresh, step-up and device-code; curated catalog; per-server filtering; *Tool Search* swaps MCP/plugin tools for `tool_search`/`tool_describe`/`tool_call` [doc] (`mcp.md`; `tool-search.md`).
- **Composio**: absent (negative search across the whole repo; only occurrences in `skills/creative/popular-web-designs/templates/composio.md`, tests and eval comments in `agent/prompt_builder.py#L371`, `#L438`) [code].
- **Providers**: 40+ (`openrouter`, `nous`, `openai-codex`, `anthropic`, `gemini`, `bedrock`, `azure-foundry`, `xai`, `custom`…) [doc] (`providers.md#L1703`). Subscription login: Anthropic OAuth (Max + extra credits; "routes as Claude Code"), ChatGPT/Codex via device-code (imports `~/.codex/auth.json`), xAI, MiniMax, Qwen [doc] (`providers.md#L94-L150`). Subagents inherit the parent's *credential pool*, with key rotation on rate limit [doc] (`delegation.md`, "Key Properties").
- **Persistence**: `state.db` SQLite (sessions, messages, `messages_fts` FTS5, lineage) per profile; memory/skills/cron in files [doc] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/developer-guide/session-storage.md`).
- **Deploy**: native installer, Docker/Compose, Nix, Termux; gateway as a detached process; "serverless" in the README refers to Modal/Daytona **terminal** backends that hibernate, not to the agent itself [doc] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/README.md`; `https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/user-guide/docker.md`).
- **Multi-agent**: isolated profiles; a multiplexed gateway serves all profiles in one process, with per-profile scoping of secrets/sessions and "fail closed" [doc] (`multiplexing-gateway.md`). Explicit warning: never two processes on the same profile, because memories contaminate each other [doc] (`profiles.md`).

### 8. Hermes-Bot-Mode

- **What it is**: a plugin for the Hermes desktop app that turns profiles into a *roster* of bots. Archived; now embedded and on by default in the desktop app (`apps/desktop/src/plugins/hermes-bots/`) [doc] (`https://github.com/NousResearch/Hermes-Bot-Mode/blob/80fee22582b871b9765a65e2992b8b5a8211c9f8/README.md`).
- **Stack**: a single `plugin.js` (~6,460 lines) in React over `@hermes/plugin-sdk` (UI components, `host.request`, react-query) + `node:test` tests [code] (`https://github.com/NousResearch/Hermes-Bot-Mode/blob/80fee22582b871b9765a65e2992b8b5a8211c9f8/plugin.js#L1-L60`). Talks to the backend via RPCs `profiles.list|create|describe|configure|set_asset|get_asset` and `image.generate` [code] (`https://github.com/NousResearch/Hermes-Bot-Mode/blob/80fee22582b871b9765a65e2992b8b5a8211c9f8/plugin.js#L215`, `#L498`, `#L1534`, `#L2012`). The in-tree version is TSX with dozens of tests [code] (listing of `https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/apps/desktop/src/plugins/hermes-bots/`).
- **Screens and functions** [doc] (`https://github.com/NousResearch/Hermes-Bot-Mode/blob/80fee22582b871b9765a65e2992b8b5a8211c9f8/README.md`; `https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/user-guide/bot-mode.md`; screenshots in `https://github.com/NousResearch/Hermes-Bot-Mode/blob/80fee22582b871b9765a65e2992b8b5a8211c9f8/docs/*.png`):
  - **Bots pane**: list of bots with avatar, last-message preview, time, search, hide/show, sections (folders) with drag-and-drop; **Active now** (who is working);
  - **Canonical Bot Chat** ("forever chat"): `/new` becomes `/compact`; standalone sessions accessible from the context menu;
  - **New Agent**: name/title/description; *Advanced*: clone from profile, create empty, provider/model, custom `SOUL.md`, skills/toolsets/MCP per bot, copy keys (OAuth is not copied); "Create on" picks the machine;
  - **Edit Profile / Duplicate / Delete**; avatars (geometric shapes, image, AI-generated, "pet");
  - **Routines**: cron per bot (`[bot:<name>] <routine>`), with a structured schedule picker;
  - **Group chats**: 2–6 bots, up to 3 serial rounds, 10-message cap, `@mention`, `@user` escalates to a human ("needs you"), durable *driver* with a lease in the gateway;
  - **Bot-to-bot**: `message_agent(target, message)` tool with automatic attribution, fire-and-forget delivery with `delivery_id` and receipt; silence tokens (`[SILENT]`, `NO_REPLY`).
- **Web dashboard** (complementary): pages Status, Chat, Config, API Keys, Sessions, Logs, Analytics, Cron, Profiles, Skills, MCP, Webhooks, Pairing, Channels, System, with REST `/api/*` and an authenticated mode (OIDC/username-password, audit log) [doc] (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/user-guide/features/web-dashboard.md#L107-L406`, `#L634-L1059`).

### 9. Quick comparison: OpenClaw and moltworker

| Aspect | Hermes | OpenClaw | moltworker |
|---|---|---|---|
| Language / runtime | Python, long-running process [doc] | Node.js, long-running WS gateway, "one gateway per host" [doc] (`https://github.com/openclaw/openclaw/blob/6b230c82fc52161e644b9e94c17dd30ccc680b72/docs/concepts/architecture.md`) | Worker (Hono) + Sandbox container running OpenClaw [code] (`https://github.com/cloudflare/moltworker/blob/7b00c1d7292190f2327e93bdcc7a0eabb0a26123/wrangler.jsonc`, `https://github.com/cloudflare/moltworker/blob/7b00c1d7292190f2327e93bdcc7a0eabb0a26123/Dockerfile`) |
| Inbound debounce | 0.3 s (cap 2 s) per session [code] | `messages.inbound.debounceMs` per channel; media flushes immediately; dedupe for 20 min [doc] (`https://github.com/openclaw/openclaw/blob/6b230c82fc52161e644b9e94c17dd30ccc680b72/docs/concepts/messages.md`) | inherits from OpenClaw |
| Message while agent busy | interrupt / queue / steer [code] | steer (default) / followup / collect / interrupt; debounce 500 ms, cap 20, drop summarize [doc] (`https://github.com/openclaw/openclaw/blob/6b230c82fc52161e644b9e94c17dd30ccc680b72/docs/concepts/queue.md`) | inherits |
| Reply in several bubbles | no (only split by size) [code] | block streaming + chunker (paragraph→line→sentence, does not break code fence/table) + coalescing + `humanDelay` 800–2500 ms between blocks [doc] (`https://github.com/openclaw/openclaw/blob/6b230c82fc52161e644b9e94c17dd30ccc680b72/docs/concepts/streaming.md`) | inherits |
| Memory | `MEMORY.md`/`USER.md` with budget + review in a fork [code] | `MEMORY.md`, `USER.md` (directives), daily notes, `DREAMS.md`, dreaming [doc] | inherits; persistence via squashfs backup in R2 [code] (`https://github.com/cloudflare/moltworker/blob/7b00c1d7292190f2327e93bdcc7a0eabb0a26123/src/persistence.ts`) |
| Multi-user | profile = one owner | "multi-user mode" is usability, **not** a security boundary [doc] (`https://github.com/openclaw/openclaw/blob/6b230c82fc52161e644b9e94c17dd30ccc680b72/docs/concepts/multi-user.md`) | single-tenant by construction (`max_instances: 1`, fixed id `openclaw`) [code] (`https://github.com/cloudflare/moltworker/blob/7b00c1d7292190f2327e93bdcc7a0eabb0a26123/wrangler.jsonc`, `https://github.com/cloudflare/moltworker/blob/7b00c1d7292190f2327e93bdcc7a0eabb0a26123/src/index.ts#L157`) |

- **moltworker in detail** [code]: HTTP/WS proxy to port 18789 of the container (`https://github.com/cloudflare/moltworker/blob/7b00c1d7292190f2327e93bdcc7a0eabb0a26123/src/index.ts#L331`, `#L484`); `SANDBOX_SLEEP_AFTER` to sleep when idle (`#L111-L128`); Workers Cron `* * * * *` reads OpenClaw's `jobs.json` mirrored in R2 and wakes the container 10 min before the next job (`https://github.com/cloudflare/moltworker/blob/7b00c1d7292190f2327e93bdcc7a0eabb0a26123/src/cron/handler.ts`, `https://github.com/cloudflare/moltworker/blob/7b00c1d7292190f2327e93bdcc7a0eabb0a26123/src/cron/wake.ts`); CDP shim over Browser Rendering/Puppeteer (`https://github.com/cloudflare/moltworker/blob/7b00c1d7292190f2327e93bdcc7a0eabb0a26123/src/routes/cdp.ts#L1-L25`); Cloudflare Access protects the admin [doc] (`https://github.com/cloudflare/moltworker/blob/7b00c1d7292190f2327e93bdcc7a0eabb0a26123/README.md`). Estimated cost ~US$ 34.50/month 24×7 with `standard-1` [doc] (`https://github.com/cloudflare/moltworker/blob/7b00c1d7292190f2327e93bdcc7a0eabb0a26123/README.md`, "Container Cost Estimate"). Pins `openclaw@2026.3.23-2` [code] (`https://github.com/cloudflare/moltworker/blob/7b00c1d7292190f2327e93bdcc7a0eabb0a26123/Dockerfile`). HEAD commit of `main` dated 2026-03-29; last-push date of the repo reported by the GitHub API: 2026-05-09.
- **What this tells us**: Cloudflare needed a container to run a harness designed as a daemon (state in filesystem, WhatsApp Web, persistent WS, CLIs). Pure Workers/DO require a redesign, not packaging.

---

## What to bring / what does not map to serverless

Verified Cloudflare premises: Durable Object SQLite supports **FTS5** and JSON [CF doc] (https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/); DO has an **alarms** API [CF doc] (same page); Cloudflare's Agents SDK already offers sessions with FTS5 search and "context blocks" injected into the system prompt [CF doc] (https://developers.cloudflare.com/agents/runtime/lifecycle/sessions/). Details on limits (CPU per invocation, Queues delays, Workflows duration) remain **(unverified)** in this research.

| Mechanism | Source | Bring it? | Cloudflare adaptation | Does not map / caution |
|---|---|---|---|---|
| `MEMORY.md`/`USER.md`/`SOUL.md` with budget, `§`, scan, frozen snapshot | `https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/tools/memory_tool_store.py` | Yes | Versioned `.md` files (Git/R2) as the source of truth; one DO per agent (or per agent+user) holds the working copy and serializes writes (replaces the `fcntl` lock); per-session snapshot in the DO | File lock and `~/.hermes` do not exist; writing to Git is asynchronous (commit via API) |
| `USER.md` per user | Hermes gap; Honcho aliases | Yes, redesigned | `users/<channel>:<id>/USER.md` per tenant; DO key includes the user; agent profile separate from each end user's profile | Hermes built-in assumes one owner |
| Skills SKILL.md + progressive disclosure + index in prompt | `https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/agent/prompt_builder.py#L1359` | Yes | Skills in R2/Git per tenant/agent; index built in the Worker; `skill_view` reads R2 | Executable `scripts/` require a sandbox; without a terminal, scripts become tools/HTTP |
| Background review (post-turn fork) | `https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/agent/background_review.py` | Yes | Event in a Queue after delivery ("turn.completed") → consumer/Workflow runs the review with the same prompts; turn/iteration counters in the DO | No daemon thread; cost ~30K tokens/event → use a cheap model and a digest |
| `write_approval` (staging) | `memory.md`, `skills.md` | Yes (proposal) | **The review's write becomes a PR/commit on a branch** in the context repo; human approval in GitHub/UI; fits the requirement of "versioned, editable .md" | Without approval, the agent rewrites its own context in production |
| Curator (stale/archive) | `curator.md` | Yes | Daily Cron Trigger; skill-usage telemetry in DO/D1; archive = move in R2/Git | Batch LLM consolidation: Workflow with steps |
| `session_search` FTS5 | `https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/tools/session_search_tool.py` | Yes | DO SQLite per conversation/agent with FTS5 (verified) | Search across conversations in several DOs needs an aggregated index (D1/Vectorize) **(unverified)** |
| Input batching | `https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/gateway/platforms/base.py#L2518-L2635` | Yes, with different numbers | A DO per conversation receives each webhook, accumulates and reschedules an **alarm** on every fragment (window configurable per channel, e.g. 3–5 s; media/commands flush) | In-memory `asyncio` timer does not survive isolates; use alarm + persisted state |
| "Busy agent" policy | `https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/gateway/run.py#L3393`; `https://github.com/openclaw/openclaw/blob/6b230c82fc52161e644b9e94c17dd30ccc680b72/docs/concepts/queue.md` | Yes | `running` state in the DO; `collect`/`queue` mode is the simplest without streaming; `steer` requires a loop that queries the DO between tool calls | `interrupt` of an in-flight HTTP call is limited **(unverified)** |
| Split by size | `https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/gateway/platforms/base.py#L4874` | Yes | Pure function in the outbound Worker | — |
| "Human" split into several bubbles + delay + typing | OpenClaw `streaming.md` (Hermes does not have it) | Yes | Paragraph→line→sentence chunker; each bubble becomes a scheduled message (DO alarm or Queue with delay) with "typing" before | Waiting seconds inside a request is wasteful; schedule outside the request |
| Typing refresh (2 s vs ~5 s) | `https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/gateway/platforms/base.py#L3402` | Yes | DO alarm resending "typing" while the turn runs / between bubbles | WhatsApp Cloud API has its own typing semantics **(unverified)** |
| `human_delay` | `https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/gateway/run_config_loaders.py#L40` | Yes | Random range per agent applied between bubbles (not only attachments) | — |
| Compression (50%, `protect_last_n` 20, memory flush before) | `config_defaults.py#L591-L605` | Yes | Step in the DO before the LLM call; summary in the DO's SQLite | Long summarization calls: Workflow |
| Stable layered prompt + ephemeral context in the user message | `prompt-assembly.md` | Yes | Same design: maximizes Anthropic/OpenAI cache | — |
| Delegation (zero context, summary, depth 1, blocked tools) | `delegation.md` | Yes | Subagent = another DO/Workflow; result returns via Queue; block `memory`/`send_message`/`cron` in children | Process/thread children do not exist; durability via Workflow |
| Group rooms (2–6, 3 rounds, 10 msgs, driver lease) | `bot-mode.md` | Yes | A DO per room is the natural "driver" (single-threaded, no lease) | — |
| `message_agent` (fire-and-forget with `delivery_id`) | `bot-mode.md` | Yes | Queue between agents + receipt in a DO; attribution "Message from 🤖 X" | — |
| Cron / heartbeat | `cron.md`, `heartbeat.md` | Yes | Per-agent alarms (or a Cron Trigger that reads the schedule from D1/DO) + Workflow for execution | A global 60 s tick in a process does not exist |
| Composio | absent in Hermes | Yes | Check whether Composio exposes a remote MCP endpoint; if so, the same HTTP/OAuth MCP client covers it **(unverified)** | Without an MCP endpoint, integration via its own SDK/HTTP |
| MCP HTTP/OAuth + Tool Search | `mcp.md`, `tool-search.md` | Yes | Remote MCP client (Streamable HTTP) in the Worker; per-tenant OAuth tokens in encrypted storage; tool search reduces schema | **MCP stdio** (subprocess) does not run; remote servers only |
| WhatsApp | Baileys (`whatsapp/adapter.py#L1-L2`) vs Cloud API | Cloud API only | Meta webhook → Worker → DO | Baileys/WhatsApp Web requires a persistent process and socket |
| Terminal, filesystem, local browser | `architecture.md` | No | Browser: Browser Rendering (see moltworker's CDP shim); code: remote sandbox via HTTP | Local terminal/file tools have no equivalent without a container |
| Isolated profiles | `profiles.md` | Yes, as a model | Tenant → agents; storage namespace per `tenant/agent`; per-tenant secrets | Isolation by directory/env var does not apply |
| Subscription login (Claude/Codex OAuth) | `providers.md#L136-L150` | With caution | Per-tenant OAuth, tokens in encrypted storage, refresh in a Worker | Terms of use for resale/multi-user: verify; Pro does not work; Codex quotas undocumented |

---

## Ideas for the management UI

Basis: Bot Mode (roster UX) + Hermes web dashboard (operations) + `/journey` and approval queues (learning), plus the multi-tenant layer that neither has.

1. **Tenant selector + RBAC** (owner/admin/operator/reader) and audit trail (the Hermes dashboard already has an audit log in authenticated mode [doc]).
2. **Per-tenant agent roster** in the Bot Mode style: avatar, title, role, last message, "Active now", sections/folders, hide; clicking opens the agent's test "forever chat".
3. **New/Edit Agent** with Bot Mode's advanced options: clone from another agent, model/provider per agent, `SOUL.md` editor, on/off switch per skill, toolset, MCP server and Composio connection; per-tenant credentials (API key or OAuth) with validity status.
4. **Versioned context editor**: tree of the agent's `.md` files (`SOUL.md`, `MEMORY.md`, per-user `USER.md`, skills) with Git diff/history and an "open in GitHub/Obsidian" link.
5. **Approval queue** inspired by `/memory pending` and `/skills pending|diff`: each review write appears as a proposal (or PR) with a diff, approve/reject.
6. **Learning timeline** (equivalent to `/journey`): skills and memories by date, usage, state (active/stale/archived), with edit/archive.
7. **End users (contacts)**: list per channel with profile (`USER.md`), conversations, last activity, "new session" button (memory boundary).
8. **Routines** per agent (cron/heartbeat) with a structured schedule picker, execution history and delivery destination.
9. **Multi-agent rooms** (2–6 agents, round/message limits) and a graph of who delegates to whom; `message_agent` log.
10. **Channels**: WhatsApp/Discord/Telegram/Slack/webchat connection per agent, with configuration of debounce, "busy" mode (queue/collect/steer/interrupt), chunking, `human_delay` and typing.
11. **Observability**: sessions, logs, usage/cost per tenant/agent/model (including the cost of the background review), delivery failures.
12. **JEV panel**: qualifier decisions per conversation (out of scope for this research).

---

## Risks

- **Doc × code divergence within Hermes itself** (three cases found): the README claims "FTS5 session search with LLM summarization", but the code says "No LLM calls" (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/README.md` × `https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/tools/session_search_tool.py#L1-L8`); `agent-loop.md` says subagents have a default `max_iterations` of 50, the code uses 250 (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/hermes_cli/config_defaults.py#L1364`) and `delegation.md` also says 250; `configuration.md` § "Human Delay" promises "human-like response pacing" in messaging, but the only call site applies the delay to attachments (`https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/gateway/platforms/base.py#L4446-L4458`) — whoever reads only the docs will think the multiple-bubbles requirement is already solved. Claims marked [doc] may be outdated.
- **Pace of change**: hermes-agent received a commit today; Bot Mode was archived and rewritten in 2 months. Copy patterns, not code.
- **Cost of learning**: the forked review costs ~30K tokens per event (comment in the code); multiplied by tenants and conversations, it needs a cheap model, a digest and a cap.
- **Contaminated memory / injection**: the agent writes into its own future prompt. Hermes mitigates with a scan, a budget, `write_approval` and "do not save" rules. In multi-tenant with anonymous WhatsApp users the risk is higher → approval/PR and per-user scope.
- **Endless sessions in the gateway**: without boundaries, memory is never reread and compression runs repeatedly (Hermes itself recommends `/new`). We need an idleness/reset policy.
- **Subscription login in a multi-user product**: the Anthropic path "routes as Claude Code"; Codex quotas/terms are undocumented. Risk of account blocking and of terms-of-use violations (check each provider's terms before offering).
- **Composio absent** in Hermes (negative search across the whole repo; in OpenClaw and moltworker not verified). Check whether Composio exposes a remote MCP endpoint; if so, the HTTP/OAuth MCP client covers it without a dedicated integration **(unverified)**.
- **WhatsApp**: the default in Hermes and OpenClaw is Baileys (WhatsApp Web, unofficial); on Workers only the official Cloud API is viable, with its own rules (24 h window, templates) **(unverified)**.
- **moltworker** is experimental and single-tenant (HEAD of 2026-03-29, last push 2026-05-09); it is not a basis for multi-tenant production.
- **OpenClaw's multi-user is not a security boundary** (stated by its own doc); real isolation must come from separate storage/credentials per tenant.

---

## Sources

Format: base URL pinned to the commit + path; lines indicated in parentheses when there is more than one excerpt (use `#L<n>` in the URL).

Hermes Agent — code:
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/tools/memory_tool_store.py (L23, L26, L90, L99, L134-L164, L168-L207, L212, L287, L483-L526)
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/tools/memory_tool.py#L56
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/agent/background_review.py#L1-L6 and #L360-L560
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/agent/turn_context.py#L736-L754
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/agent/turn_finalizer.py#L737-L766
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/agent/agent_init.py (L1328, L1352, L1407-L1409)
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/agent/prompt_builder.py (L1359, L1470-L1499; L371 and L438 for the "composio" search)
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/agent/memory_provider.py#L84-L203
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/hermes_cli/config_defaults.py (L591, L605, L1324, L1364, L1379, L1384)
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/gateway/platforms/base.py (L112-L113, L1631, L2518-L2635, L3402-L3420, L4191-L4198, L4446-L4458, L4874-L4880)
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/gateway/run.py#L3393
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/gateway/run_config_loaders.py (L40, L293-L320)
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/plugins/platforms/whatsapp/adapter.py (L1-L2, L283, L636-L651, L793)
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/plugins/platforms/telegram/adapter.py#L519-L523
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/tools/session_search_tool.py#L1-L30
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/LICENSE
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/SOUL.md
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/README.md

Hermes Agent — docs in the repository:
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/AGENTS.md
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/gateway/AGENTS.md
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/skills/AGENTS.md
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/developer-guide/architecture.md
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/developer-guide/agent-loop.md
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/developer-guide/prompt-assembly.md
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/developer-guide/session-storage.md
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/developer-guide/cron-internals.md
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/developer-guide/multiplexing-gateway.md
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/user-guide/features/memory.md
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/user-guide/features/memory-providers.md
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/user-guide/features/honcho.md
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/user-guide/features/skills.md
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/user-guide/features/curator.md
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/user-guide/features/delegation.md
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/user-guide/features/cron.md
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/user-guide/features/heartbeat.md
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/user-guide/features/goals.md
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/user-guide/features/kanban.md
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/user-guide/features/mcp.md
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/user-guide/features/tool-search.md
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/user-guide/features/personality.md
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/user-guide/features/api-server.md
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/user-guide/features/web-dashboard.md
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/user-guide/sessions.md
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/user-guide/profiles.md
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/user-guide/bot-mode.md
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/user-guide/configuration.md#L2676-L2687
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/user-guide/docker.md
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/user-guide/messaging/index.md
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/website/docs/integrations/providers.md#L94-L150
- https://github.com/NousResearch/hermes-agent/blob/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/apps/desktop/src/plugins/hermes-bots/ (in-tree version of Bot Mode; directory URL: https://github.com/NousResearch/hermes-agent/tree/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662/apps/desktop/src/plugins/hermes-bots)

Hermes-Bot-Mode:
- https://github.com/NousResearch/Hermes-Bot-Mode/blob/80fee22582b871b9765a65e2992b8b5a8211c9f8/README.md
- https://github.com/NousResearch/Hermes-Bot-Mode/blob/80fee22582b871b9765a65e2992b8b5a8211c9f8/plugin.js (L1-L60, L215, L498, L1534, L2012)
- https://github.com/NousResearch/Hermes-Bot-Mode/blob/80fee22582b871b9765a65e2992b8b5a8211c9f8/tests/bot-delete.test.mjs (example of the node:test tests)
- https://github.com/NousResearch/Hermes-Bot-Mode/blob/80fee22582b871b9765a65e2992b8b5a8211c9f8/docs/bots-pane.png
- https://github.com/NousResearch/Hermes-Bot-Mode/blob/80fee22582b871b9765a65e2992b8b5a8211c9f8/docs/new-agent-advanced.png
- https://github.com/NousResearch/Hermes-Bot-Mode/blob/80fee22582b871b9765a65e2992b8b5a8211c9f8/docs/cronjobs-pane.png

moltworker:
- https://github.com/cloudflare/moltworker/blob/7b00c1d7292190f2327e93bdcc7a0eabb0a26123/README.md
- https://github.com/cloudflare/moltworker/blob/7b00c1d7292190f2327e93bdcc7a0eabb0a26123/AGENTS.md
- https://github.com/cloudflare/moltworker/blob/7b00c1d7292190f2327e93bdcc7a0eabb0a26123/wrangler.jsonc
- https://github.com/cloudflare/moltworker/blob/7b00c1d7292190f2327e93bdcc7a0eabb0a26123/Dockerfile
- https://github.com/cloudflare/moltworker/blob/7b00c1d7292190f2327e93bdcc7a0eabb0a26123/src/index.ts (L111-L128, L157, L331, L484, L552)
- https://github.com/cloudflare/moltworker/blob/7b00c1d7292190f2327e93bdcc7a0eabb0a26123/src/cron/handler.ts
- https://github.com/cloudflare/moltworker/blob/7b00c1d7292190f2327e93bdcc7a0eabb0a26123/src/cron/wake.ts
- https://github.com/cloudflare/moltworker/blob/7b00c1d7292190f2327e93bdcc7a0eabb0a26123/src/routes/cdp.ts#L1-L25
- https://github.com/cloudflare/moltworker/blob/7b00c1d7292190f2327e93bdcc7a0eabb0a26123/src/persistence.ts
- Repo metadata (pushed_at 2026-05-09): https://api.github.com/repos/cloudflare/moltworker

OpenClaw:
- https://github.com/openclaw/openclaw/blob/6b230c82fc52161e644b9e94c17dd30ccc680b72/docs/concepts/architecture.md
- https://github.com/openclaw/openclaw/blob/6b230c82fc52161e644b9e94c17dd30ccc680b72/docs/concepts/messages.md
- https://github.com/openclaw/openclaw/blob/6b230c82fc52161e644b9e94c17dd30ccc680b72/docs/concepts/queue.md
- https://github.com/openclaw/openclaw/blob/6b230c82fc52161e644b9e94c17dd30ccc680b72/docs/concepts/streaming.md
- https://github.com/openclaw/openclaw/blob/6b230c82fc52161e644b9e94c17dd30ccc680b72/docs/concepts/memory.md
- https://github.com/openclaw/openclaw/blob/6b230c82fc52161e644b9e94c17dd30ccc680b72/docs/concepts/dreaming.md
- https://github.com/openclaw/openclaw/blob/6b230c82fc52161e644b9e94c17dd30ccc680b72/docs/concepts/agent-workspace.md
- https://github.com/openclaw/openclaw/blob/6b230c82fc52161e644b9e94c17dd30ccc680b72/docs/concepts/multi-user.md

Cloudflare:
- https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ (FTS5, JSON, alarms)
- https://developers.cloudflare.com/agents/runtime/lifecycle/sessions/ (sessions with FTS5, context blocks)
