# ADR-0041: An agent's tier may be `auto`, and its qualifier then picks the tier for each turn

- Status: Accepted
- Date: 2026-10-14
- Issue: [#308](https://github.com/guedesdiogo/kelpie/issues/308)
- Decided by the owner on 2026-10-13, answering research note 10's Q3: «Podemos ter a opção de deixar marcado como "auto" e quando for esse cenário, usaria o qualificador (jev ou clef) para definir o modelo.»

## Context

**How Kelpie picks a model today.** ADR-0036 §2 sets a model through the trio: `provider`, `tier` (`cheap`, `medium` or `frontier`) and `effort`.
- `MODEL_ROUTES` maps a tier and a provider to a model, so nobody types a model id.
- A tier stays fixed until someone changes it, and a change needs the user's yes (§6 rule 5).

**The qualifier was meant for this.** ADR-0009 lists "model tier" among the qualifier's uses. It also sets the rules for hot-path questions: an 800 ms timeout and a circuit breaker.

**Each agent already has a qualifier.** Its `qualifier` setting is Clef, the default on Workers AI, or Jev, through TypeSafe (ADR-0022). Since ADR-0024 it no longer decides end of turn, and stays for other typed decisions, «um ou outro».
- `packages/qualifier` already runs such a decision: typed questions, among them a `choice` with criteria per option, a timeout and a deterministic fallback ([`decision.ts`](https://github.com/guedesdiogo/kelpie/blob/1b1d945/packages/qualifier/src/decision.ts#L1-L40)).

**Research note 10 found the same idea in eve.** eve's `auto({options})` asks a decision model, Jev by default, to pick a model for each turn from options described in words, and keeps the pick for the rest of the turn ([note 10 §3.5](../research/10-eve.md)). The note recommended waiting. The owner asked for an `auto` setting in which the qualifier, Jev or Clef, picks the model.

In Kelpie's terms, "the model" is the tier: the provider stays the one the trio resolves, and the tier picks its model from `MODEL_ROUTES`.

## Decision

1. **`auto` is a value of `tier`,** besides `cheap`, `medium` and `frontier`.
   - **Where it is accepted:** only in `conversation`-area entries, the agent's area and the instance's area (ADR-0036 §2's levels 1 and 3).
   - **Where it is refused:** in the agent-wide and instance-wide entries. Those feed the `memory` area too, and memory keeps a fixed tier: checkpoints, Dream and resolve are batch work with known needs, and no person's message to judge.
   - **Its qualifier must work.** Setting `auto` is refused for an agent set to `jev` while no TypeSafe key exists, since every turn would fall back.
2. **At the start of each turn,** once the buffer is flushed (ADR-0024 §5), Kelpie asks the agent's qualifier one `choice` question: which tier fits this turn.
   - **The options** are the tiers the agent may run on (point 5), each with a built-in description of the work it suits, from short routine replies to hard, multi-step reasoning.
   - **The state** is the turn's new messages, masked as ADR-0018 and ADR-0022 mask what goes to a qualifier. For a task run (ADR-0011), it is the task's title and description.
   - **The qualifier** is the agent's own, Clef or Jev. One per agent, never both. A subagent uses its creator's.
3. **The pick holds for the whole turn:** every tool round, and the last call at the bound. It is stored with the turn, so a turn recovered after an eviction keeps it. A continuation past the bound (ADR-0040) keeps it too. Any other turn picks again.
4. **ADR-0009's hot-path rules apply.**
   - The question has an 800 ms timeout.
   - It sits behind a circuit breaker: while the qualifier keeps failing, turns go straight to the fallback instead of each waiting out the timeout.
5. **The pick never exceeds what the agent may run on.**
   - **For a subagent:** ADR-0036 §5 caps its tier at its creator's. When the creator is on `auto`, the cap is the tier the creator ran on in the turn that created the subagent.
   - **The fallback is `medium`, or the cap when that is lower.** It applies when the qualifier fails, misses the timeout, is skipped by the breaker, or answers outside the options. `medium` sits between a cheap model that may fail a hard request and a frontier model's cost.
6. **The rest of the trio applies as resolved.** The `provider` and the `effort` are untouched. The picked tier finds its model in `MODEL_ROUTES`, with the same route fallbacks and the routes of ADR-0037.
7. **The identity section states `auto`, not the pick.** It says the agent runs on `auto`, and what each tier it may pick runs on. The system prompt therefore stays the same from turn to turn, and so does Kelpie's replay key (`promptKey`).
8. **Each turn records its pick and its source,** the qualifier or the fallback. The pick shows in the logs and in the weekly cost report (#269).
9. **Setting `auto` follows ADR-0036 §3,** like any tier.
   - It needs the user's yes, except for a subagent's tier at its creation, which its creator sets within §5.
   - The pick made for each turn is not a trio change, so it needs no yes.
10. **`auto` is never a default.** No agent, instance or subagent gets it unless someone sets it.

### Amendments

- **[ADR-0036](0036-agent-roles-models-and-subagents.md):**
  - §2: `tier` may be `auto` in `conversation`-area entries, and the identity section states `auto` rather than a resolved tier;
  - §5: a creator on `auto` caps its subagent at the tier it ran on when it created it;
  - §6 rule 5: the tier picked for each turn under `auto` is not a trio change.
- **[ADR-0024](0024-fixed-wait-end-of-turn.md) §3:** the qualifier's typed decisions include the tier of a turn on `auto`, besides the memory rerank.

## Consequences

- **A turn on `auto` costs one more qualifier call.**
  - **With Clef:** on the order of ADR-0022's US$ 0.000043 per call on Workers AI. It is billed only after Workers AI's free allocation, under the cost alert at 90% (#269).
  - **With Jev:** TypeSafe bills each call.
  - The cost exists only for agents set to `auto`, by the user's choice.
- **A turn starts up to 800 ms later** while the qualifier answers, after the wait of ADR-0024.
- **Switching tiers between turns has a cost.**
  - A provider's prompt cache is per model, so the first turn on the other model pays a full cache write of the history.
  - Native output is replayed by provider, not by model ([`anthropic.ts#L276-L280`](https://github.com/guedesdiogo/kelpie/blob/1b1d945/packages/llm/src/anthropic.ts#L276-L280)). The new model may ignore the earlier turns' reasoning.
  - Route fallbacks cause the same today, but only on errors. Under `auto`, switching is routine.
  - The story measures how often the tier switches. A "sticky" pick that changes only on a clear difference is a later option.
- **Within a turn the tier holds.** A route fallback may still change the model mid-turn, as it can today.
- **The pick is unmeasured.**
  - The story measures it on labeled turns before `auto` is offered, as ADR-0009 asks of every decision.
  - It also logs how often the fallback answers.
- **The implementation builds on #286's trio.** It also adds the circuit breaker ADR-0009 describes, which no decision has needed until now.

## Alternatives considered

- **eve's form:** any model ids, described in the agent's configuration. Kelpie keeps model ids out of settings (ADR-0036 §2), and three tiers are enough to describe.
- **A model call to route.** It is slower and costs more than a typed decision, which is what the qualifier is for.
- **A heuristic, such as the message's length.** It is too weak to pick a model on. The fallback is a fixed tier instead.
- **Let `auto` pick the effort too.** It may come later, once the tier's pick is measured.

## References

- [Research note 10](../research/10-eve.md), Adapt 3 and Q3
- [ADR-0009](0009-qualifier-and-jev.md), [ADR-0011](0011-agent-task-board.md), [ADR-0018](0018-jev-direct-api.md), [ADR-0022](0022-clef-qualifier.md), [ADR-0024](0024-fixed-wait-end-of-turn.md), [ADR-0036](0036-agent-roles-models-and-subagents.md), [ADR-0037](0037-conversations-through-claude-code.md), [ADR-0040](0040-continue-at-the-tool-bound.md)
- eve's per-turn pick: [`research/jev-decision-models.md`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/research/jev-decision-models.md), [`ai/decide.ts`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/ai/decide.ts#L10-L27)
