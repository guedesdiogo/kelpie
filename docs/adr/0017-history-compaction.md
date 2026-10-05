# ADR-0017: Long conversations are bounded by Kelpie's own summary checkpoints

- Status: Proposed
- Date: 2026-10-05
- Issue: [#64](https://github.com/guedesdiogo/kelpie/issues/64)

## Context

A conversation's `ConversationAgent` sends its whole history to the model on every turn (Story 3.3). A long conversation costs more with every turn, and eventually it outgrows the model's context window.

The history has to stay **append-only**:
- Dropping the oldest messages changes the prompt's prefix. That breaks prompt caching, and replayed reasoning stops being valid.
- Anthropic checks that a replayed thinking block's prefix is unchanged. For accounts created on or after 2026-08-31, a changed prefix is a `400` by default; older accounts are checked only when the request asks. Anthropic's advice is to build append-only either way ([preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking#when-the-api-enforces-the-check)).
- OpenAI replays output items with their ids under `store: false` (ADR-0008, #57).

A few facts shape the choice:
- **The routes.** `llm-gateway` routes each tier to an Anthropic model, then an OpenAI one:
  - cheap: `claude-haiku-4-5`, then `gpt-6-luna`;
  - medium: `claude-sonnet-5-5`, then `gpt-6.1-sol`;
  - frontier: `claude-opus-5-5`, then `gpt-6-astra`.

  A conversation can change provider between turns when a provider has no key or fails. The default agent runs on the cheap tier. The instance has only an OpenAI key today.
- **Measurement** starts with #92: each turn records its usage, and logs its whole prompt size (`input`).

### What the providers and the references offer

Checked on 2026-10-05; the research is on [#64](https://github.com/guedesdiogo/kelpie/issues/64).

**Anthropic, threshold compaction** ([docs](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold); beta header `compact-2026-01-12`)
- The request sets `context_management.edits: [{ type: "compact_20260112", trigger: { type: "input_tokens", value } }]`. The trigger defaults to 150,000 tokens, with a minimum of 50,000.
- The reply starts with a `compaction` block. The client appends it like any output.
- The API ignores what came before the block, so the client may stop sending it. The checked prefix then starts at the block ([preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking#keeping-the-prefix-unchanged)). This is append-only on the wire.
- **Models:** Fable, Mythos, Opus 4.6 and later, and Sonnet 4.6 and later. **Not `claude-haiku-4-5`**, the cheap tier's first route.

**Anthropic, on-demand compaction** ([docs](https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand); beta header `compact-2026-09-04`)
- The client replaces the summarized messages with one signed `compaction` block.
- Kept turns stay valid only under strict conditions: the kept turns are unchanged and follow the summarized messages directly, and the system prompt and tools are unchanged.
- It can't be combined with threshold compaction, and it isn't available on Bedrock.

**Anthropic, context editing** ([docs](https://platform.claude.com/docs/en/build-with-claude/context-editing))
- It clears old tool results or thinking.
- The client still sends the whole history, so the request size isn't bounded.

**OpenAI** ([compaction guide](https://developers.openai.com/api/docs/guides/compaction))
- `context_management: [{ type: "compaction", compact_threshold }]` adds an opaque, encrypted `compaction` output item.
- A stateless client may stop sending items from before the most recent one. That suits `store: false`.
- **Models:** no official list. The guide's examples use `gpt-5.3-codex` and `gpt-6-astra`. Support for `gpt-6-luna` and `gpt-6.1-sol` is unverified.
- `truncation: "auto"` drops the oldest items, so it changes the prefix.

**Cloudflare**
- AI Gateway and Workers AI offer nothing here.
- The Agents SDK's experimental `Session` compacts on the client with a summarizer you provide ([docs](https://developers.cloudflare.com/agents/runtime/lifecycle/sessions/)).

**Hermes Agent** (`7157422`, [`context_compressor.py`](https://github.com/NousResearch/hermes-agent/blob/7157422022ff06f3e632d1dd394ee1253b17ad37/agent/context_compressor.py)) `[code]`
- It compacts on the client once the prompt reaches a share of the context window: half by default, raised to at least 0.75 for windows under 512K.
- It keeps the system prompt, the first messages and a token-bounded tail verbatim. An auxiliary model summarizes the middle into fixed sections: goal, constraints and preferences, decisions, open questions and others.
- A later compaction updates the previous summary.
- Hermes uses OpenAI's native compaction only as an opt-in, for a few routes, and Anthropic's not at all.

## Decision (proposed)

Kelpie bounds long conversations with **summary checkpoints it writes itself**, the same way for every provider and model.

- **When.** After a delivered turn whose recorded `input` crosses the tier's **budget**, the agent schedules a checkpoint off the hot path, so the reply is never delayed.
  - The budget starts at **100,000 tokens** for every tier. That is half of `claude-haiku-4-5`'s 200K window, the smallest in the routes. The measurement from #92 revisits it.
- **What.** A cheap-tier model call summarizes what the next turns need into fixed sections, adapted from Hermes:
  - the owner's goal and open threads;
  - stated preferences and constraints;
  - decisions and facts settled in the conversation;
  - open questions.

  It takes the previous checkpoint, if any, plus the messages since. A later checkpoint updates the earlier one instead of starting over.
- **Where.** The summary is a history row of its own kind. Nothing is rewritten or deleted: older rows stay until the erasure workflow (ADR-0006) or memory (Epic 4) takes them.
- **What the model then sees:**
  1. the system prompt, unchanged, so its cache survives;
  2. the latest checkpoint, as the first message, marked as a summary of earlier conversation;
  3. the messages after it, verbatim, with their native output replayed as today.

  From one checkpoint to the next, the request is append-only again. No reasoning from before a checkpoint is replayed, so no turn after it can be rejected for an edited prefix.
- **Recent turns stay verbatim.** The latest few turns before the threshold are kept after the checkpoint, so the conversation doesn't lose its immediate thread. The count is set in the implementation, against a token bound, as Hermes does.
- **Native compaction is a later optimization, not the base.** It may be added for routes that support it, behind the same budget. It needs a new decision.

## Consequences

- **It works for every route**, the cheap tier included, and survives a provider change between turns: a checkpoint is plain text either provider can read.
- **Each checkpoint costs one extra cheap model call**, and the prompt cache misses once after it. The system prompt's cache stays.
- **The summary loses detail.** What the owner needs to keep belongs in memory (Epic 4), not in a conversation's history.
- **The `ConversationAgent` gains a step,** with its own failure handling: a failed summary call leaves the full history in place and retries at the next turn.
- **The budget can later become a setting,** per tier or per agent.

## Alternatives considered

- **Provider-native threshold compaction as the base** (Anthropic `compact_20260112`, OpenAI `compaction`).
  - It is append-only on the wire and needs no extra call.
  - Rejected as the base: the default tier's first route (`claude-haiku-4-5`) doesn't support it, OpenAI's model support is unverified, and an opaque compaction item can't follow the conversation to the other provider.
  - It stays open as an optimization.
- **Anthropic on-demand compaction.** It is not append-only, it holds only under strict conditions, and it is Anthropic-only.
- **Context editing.** It doesn't bound the request size.
- **A sliding window, or OpenAI `truncation: "auto"`.** Either changes the prefix and invalidates replayed reasoning.
- **Doing nothing until memory (Epic 4).** Long conversations would hit the context window first.

## Open questions for the owner

1. **The approach:** Kelpie's own checkpoints (proposed), or native compaction first, with checkpoints only where it is missing.
2. **The budget:** 100,000 input tokens, or a share of each model's window.
3. **The summary model:** the cheap tier (proposed), or the conversation's own tier.

## References

- [#64](https://github.com/guedesdiogo/kelpie/issues/64), [#92](https://github.com/guedesdiogo/kelpie/pull/92) (measurement), Story 3.3 ([#36](https://github.com/guedesdiogo/kelpie/issues/36)), ADR-0002, ADR-0006, ADR-0008, ADR-0015.
- Provider and reference sources: linked inline above.
