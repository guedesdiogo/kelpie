# ADR-0009: Typed decisions go through a Qualifier; Jev is preferred, never required

- Status: Accepted
- Date: 2026-10-03
- Issue: [#5](https://github.com/guedesdiogo/kelpie/issues/5)
- Amended by: [ADR-0018](0018-jev-direct-api.md), Jev goes through TypeSafe's API first, end-of-turn thresholds are set per qualifier, and masking before every call is mandatory; [ADR-0024](0024-fixed-wait-end-of-turn.md), end of turn uses no qualifier: Kelpie answers after a fixed, configurable wait

## Context

The owner wants Jev, TypeSafe AI's decision model, as the default qualifier wherever it is viable: tools, skills, memories and more. Jev returns probabilities for typed questions (`noul`, `choice`, `score`) and does not generate text. The research found:
- It launched on 2026-09-15.
- Nobody can run it for free.
- Its accuracy in Portuguese and its latency from Brazil are unmeasured.
- Its terms forbid training a model to imitate its output.

Each access path has a ceiling:
- **Workers AI binding:** 200 requests per 60 s per gateway, roughly 50–65 user turns per minute, plus a 5% fee; zero data retention.
- **TypeSafe API:** 80 requests/s; no zero retention below enterprise.
- **OpenRouter:** no waitlist; limits unverified.

The owner's decision: have the three options available, implement Workers AI first, make it ready for TypeSafe or OpenRouter, and never make it mandatory, only preferred.

## Decision

- A `Qualifier` interface carries every typed decision.
- Implementations:
  - `JevWorkersAIQualifier`, first;
  - `JevHttpQualifier` (TypeSafe) and an OpenRouter variant, added later and selected by configuration;
  - `HeuristicQualifier`, the keyless default that a fresh clone runs with, and the fallback;
  - `FakeQualifier`, for CI.
- Each decision has its questions, a policy in code, a timeout and a deterministic fallback. Hot-path questions share one fan-out call per turn with an 800 ms timeout and a circuit breaker.
- Where Jev is used follows the study's table: end of turn (hybrid), tools, skills, memories (as a reranker), model tier, ambiguous group messages, sub-agents, memory writes, escalation, and review triage. Prompt-injection screening and pre-send review use it only as one layer. Reply splitting doesn't use it.
- Personal data is masked before any call. Instructions are written in English.

## Consequences

- Kelpie runs with zero keys, and Jev improves it when configured.
- Thresholds need a labeled PT-BR set per decision before automatic mode.
- Whether a model version can be pinned on the Workers AI path is unverified.
- The fallback can't be distilled from Jev's answers.

## Alternatives considered

- **Jev required.** Nobody could run a clone without paying.
- **LLM-as-judge everywhere.** Slower, and its scores aren't calibrated. It remains an implementation for off-hot-path decisions.

## References

- [Viability study §5](../viability-study.md#5-where-jev-fits)
- [Research 04: §4 decision table, §5 Qualifier interface, §6 risks](../research/04-jev.md)
- [Research 00: C4, C6, C7](../research/00-cross-check.md)
