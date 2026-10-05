# ADR-0018: Jev goes through TypeSafe's API first, and end of turn uses thresholds per qualifier

- Status: Proposed
- Date: 2026-10-05
- Issue: [#27](https://github.com/guedesdiogo/kelpie/issues/27)

## Context

[ADR-0009](0009-qualifier-and-jev.md) has `JevWorkersAIQualifier` implemented first. On Cloudflare, Jev is a third-party model, paid for only with Unified Billing credits, and every credit purchase carries a 5% fee. Using it would also take a second AI Gateway. The instance's gateway requires provider credentials, so that a call missing its OpenAI key fails instead of billing credits, and that setting refuses Unified Billing.

The owner decided on 2026-10-05 to call Jev directly through TypeSafe's API, to avoid the fee.

The [spike](../spikes/jev-end-of-turn-ptbr.md) then measured that path from São Paulo on 101 labeled PT-BR sequences:
- **Latency:** p50 251 ms and p95 317 ms. None of the 202 calls exceeded the 800 ms timeout.
- **Accuracy:** 87% against the heuristic's 67% at 0.5.
- **Probabilities:** compressed. Finished sequences scored 0.45–0.89 and unfinished ones 0.18–0.69. At the production bands (0.8 / 0.3), Jev took barely more confident decisions than the heuristic: 33 against 30.
- **Hybrid:** a confident heuristic rule decides first and Jev decides the rest with its own bands, 0.70 / 0.40. That took 69 confident decisions, with 1 to 2 errors.

## Decision

This amends ADR-0009 in four points:
- **`JevHttpQualifier` is implemented first.** It calls TypeSafe's `POST /v1/systemone` with a pinned model, `jev-1.13.0` today. The Workers AI and OpenRouter variants stay options, selected by configuration. The key never goes through chat (ADR-0013).
- **Each qualifier has its own end-of-turn bands:**
  - the heuristic keeps 0.8 / 0.3;
  - Jev 1.13.0 starts at 0.70 / 0.40. It is recalibrated on labeled real conversations before automatic mode, as ADR-0009 already requires, and again whenever the pinned version changes.
- **End of turn is hybrid.** A confident heuristic rule decides first: a greeting alone, a trailing conjunction or `,` `:` `...`, a `?`, a command. Jev decides the rest. The heuristic is never tuned on Jev's answers, so the policy doesn't distil Jev.
- **Personal data is masked before every call, without exception.** On the direct API, TypeSafe offers zero data retention only on enterprise plans.

## Consequences

- No 5% fee. The spend is TypeSafe credits, about US$ 0.000013 per turn at 310 input tokens.
- **No zero data retention below enterprise.** Masking, already in ADR-0009, becomes the safeguard.
- **No AI Gateway logs or analytics for Jev.** Usage comes from each response's `usage` field.
- **`quietWindowMs` takes its thresholds from the qualifier that answered,** not from constants.
- **Rate limits are per TypeSafe account:** 80 requests/s and 100K tokens/s, far above a single player's traffic.

## Alternatives considered

- **The Workers AI binding first**, as ADR-0009 had it. It has zero data retention and gateway logs, but costs 5% on every credit purchase and a second gateway.
- **One set of bands for every qualifier.** Jev would add almost nothing at the heuristic's bands.
- **Jev alone, without the hybrid.** It made 54 confident decisions with no errors, against the hybrid's 69 with 1 to 2. One of the hybrid's errors comes from a heuristic bug ("fechado então" read as unfinished), which can be fixed. The hybrid is also what ADR-0009 called for.

## References

- [Spike: Jev's latency from Brazil and its PT-BR end-of-turn accuracy](../spikes/jev-end-of-turn-ptbr.md)
- [Research 04: §2 access paths, price and privacy](../research/04-jev.md)
- [TypeSafe API reference](https://docs.typesafe.ai/api.md) and [models](https://docs.typesafe.ai/models.md)
