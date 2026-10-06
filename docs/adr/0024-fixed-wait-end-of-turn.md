# ADR-0024: Kelpie answers after a fixed, configurable wait; end of turn uses no qualifier

- Status: Accepted
- Date: 2026-10-06
- Issue: [#133](https://github.com/guedesdiogo/kelpie/issues/133)
- Accepted by the owner on 2026-10-06: «Não vamos usar o qualificador para isso. Vamos usar um "timeout" de 10 segundos (permitir ser configurável)»

## Context

Until now the buffer waited a quiet window chosen by an end-of-turn decision:
- [ADR-0009](0009-qualifier-and-jev.md) made the decision a typed one, answered through a qualifier;
- [ADR-0018](0018-jev-direct-api.md) made it hybrid, with thresholds per qualifier;
- [ADR-0022](0022-clef-qualifier.md) made Clef the default qualifier, with bands per model.

A heuristic, then Clef or Jev, gave the probability that the owner had finished. That probability picked 1.5 s, 3 s or 6 s, capped at 10 s from the first fragment.

The first live turns, on 2026-10-06, showed the decision's cost. One of two Clef calls missed the 800 ms timeout, and the other took 722 ms. The owner then decided that end of turn should not use the qualifier at all, and that Kelpie should wait a fixed, configurable time.

## Decision

This amends ADR-0009, ADR-0018 and ADR-0022 for end of turn:

1. **The buffer makes no end-of-turn decision.**
   - An agent answers `quietMs` after the owner's latest message, 10 s by default. Each new message starts the wait again.
   - `maxWaitMs`, 60 s by default, still caps the wait from the first buffered message, so a stream of messages is answered.
   - Both are agent settings, set through the configuration commands (ADR-0013).
2. **The end-of-turn decision is removed:** its heuristic, its bands per qualifier, and its hybrid with Clef or Jev.
3. **The qualifier stays for other typed decisions.** The first is the memory rerank (#110).
   - The agent's `qualifier` setting keeps choosing Clef or Jev for them, by the owner's decision on #110: «a ideia é usar um ou outro como qualificador, não ter cenários que usam os dois».
   - These stay as ADR-0018 and ADR-0022 set them: `llm-gateway`'s `qualify`, the Clef and Jev adapters, the masking, and the renaming of question ids for Clef.
4. **The webchat's typing hold stays.** While the owner types for longer than the wait, a planned answer moves on, within the cap.

## Consequences

- **Every reply waits at least the configured time,** 10 s by default, even after a complete question. This is the owner's choice.
  - Nothing shows during the wait; "typing" appears when the model starts answering.
  - A shorter `quietMs` per agent trades speed for more interruptions.
- **No qualifier call, cost or latency risk per message.** The decision's timeout and its fallbacks are gone from the hot path.
- **Behavior is predictable.** The same message always waits the same time.
- **Settings stored before this change give way.** A configured agent stores its whole settings, so it holds the old windows and the old 10 s cap; both are ignored when read, and the new defaults apply. The configuration commands no longer accept `quietWindow`.
- **A pause command (#134)** lets the owner hold an answer until their next message, which a fixed wait alone can't do.

## Alternatives considered

- **Keep Clef, with a 1.4 s decision timeout:** it keeps the adaptive wait, at the cost of a model call per unsure message. The owner chose a fixed wait.
- **Clef-flash:** it is faster, but its hybrid decided 65 of 101 sequences against `clef`'s 81, and its p95 was still near the timeout.
- **The heuristic alone, with its adaptive windows:** it costs nothing, but it misreads informal PT-BR more often (68% at 0.5 in the spikes). It would keep a rule set to maintain.

## References

- [#133](https://github.com/guedesdiogo/kelpie/issues/133), [#134](https://github.com/guedesdiogo/kelpie/issues/134)
- [Spike: Cloudflare's Clef as the PT-BR end-of-turn qualifier](../spikes/clef-end-of-turn-ptbr.md)
