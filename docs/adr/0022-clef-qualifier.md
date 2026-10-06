# ADR-0022: Each agent chooses its end-of-turn qualifier, Clef on Workers AI by default, Jev as the option

- Status: Proposed
- Date: 2026-10-06
- Issue: [#117](https://github.com/guedesdiogo/kelpie/issues/117)

## Context

[ADR-0018](0018-jev-direct-api.md) made Jev, called through TypeSafe's API, the end-of-turn qualifier. Cloudflare now hosts two decision models of its own on Workers AI, `clef` (27B) and `clef-flash` (9B).
- They speak the same System One API.
- They are reached through the `AI` binding, with no key and no Unified Billing fee.
- Cloudflare doesn't use the inputs to train or improve models.

The owner decided on 2026-10-06:
> «Podemos manter a opção do jev, mas já quero focar no clef. E permitimos a escolha do usuário sobre qual prefere usar»

He also decided to keep masking for Clef («Pode manter»).

The [spike](../spikes/clef-end-of-turn-ptbr.md) measured both models from São Paulo on the 101 PT-BR sequences of the Jev spike. Each model's bands were measured on the 71 sequences the heuristic leaves to the qualifier:

| | `clef` | `clef-flash` | Jev 1.13.0 |
|---|---|---|---|
| Hybrid: confident decisions of 101, wrong ones in brackets | 81 (0) | 65 (0) | 69 (1–2) |
| Bands | 0.95 / 0.46 | 0.87 / 0.37 | 0.70 / 0.40 |
| p50 / p95 | 455 / 835 ms | 250 / 743 ms | 251 / 317 ms |
| Calls over the 800 ms timeout | 6.4% | 3.5% | 0% |
| Per turn the heuristic leaves | US$ 0.000043 | US$ 0.000016 | US$ 0.000013 |

The spike also found that Clef refuses `runDecision`'s question ids: `turn.end::user_finished` breaks its `^[A-Za-z0-9_.-]{1,100}$` pattern.

## Decision

This amends ADR-0018 in five points:

1. **Each agent chooses its qualifier.** Its setting `qualifier` is `clef` or `jev`, and the default is `clef`. The owner changes it through the configuration commands (ADR-0013). An agent set to `jev` without `TYPESAFE_API_KEY` uses the heuristic, as before.
2. **Clef runs in `llm-gateway` through the `AI` binding.**
   - `CLEF_MODEL` pins the model, as `JEV_MODEL` pins Jev's version.
   - The default is `clef`, for its accuracy.
   - `clef-flash` remains a deploy-time choice.
3. **End-of-turn bands are per model.**
   - `clef` starts at 0.95 / 0.46, and `clef-flash` at 0.87 / 0.37.
   - Jev keeps 0.70 / 0.40, and the heuristic 0.8 / 0.3.
   - Bands are measured on the sequences the heuristic leaves to the qualifier, because that is all it sees in the hybrid. They are recalibrated on labeled real conversations, as ADR-0009 requires, and whenever the pinned model changes.
4. **The adapter renames question ids for Clef.** Any character outside `[A-Za-z0-9_.-]` becomes `_`, so `turn.end::user_finished` goes out as `turn.end__user_finished`. The answers come back under the caller's keys.
5. **Masking applies to Clef as it does to Jev.** The end-of-turn decision needs no personal values.

The 800 ms decision timeout stays. On 6.4% of calls `clef` answers later, and those turns fall back to the heuristic.

## Consequences

- **No key is needed for the default qualifier.** A new instance gets Clef's end of turn as soon as `llm-gateway` deploys.
- **Existing agents move from Jev to Clef** when `conversation-runtime` deploys, because they have no stored setting. Setting an agent to `jev` keeps the old behavior.
- **The spend moves to the account's Workers AI usage.** At US$ 0.000043 per turn the heuristic leaves, that is about three times Jev's cost, and still about four cents per thousand such turns.
- **One turn in sixteen loses Clef's decision to the timeout.** The turn isn't delayed: the decision runs while the buffer waits out its quiet window, which is at least 1.5 s. The `conversation: end of turn` log's `source` and `ms` show how often it happens live.
- **Clef's answers are deterministic.** Repeated calls gave the same probabilities, so live behavior can be replayed.
- **TypeSafe's terms still apply only to agents set to `jev`.**

## Alternatives considered

- **`clef-flash` as the default.** It is as fast as Jev at the median and the cheapest Clef, but its hybrid decides 65 sequences against `clef`'s 81. It confuses pauses and lone words ("pera", "primeiro") with finished messages.
- **Jev stays the default and Clef is the option.** Jev's latency is the best, but its hybrid decides fewer sequences and makes errors. It also needs a key, and TypeSafe offers zero data retention only on enterprise plans. The owner chose to focus on Clef.
- **A 1.4 s decision timeout,** with `llm-gateway`'s bound raised to match. It would keep every Clef answer measured, at no cost in reply time while the quiet window is longer. It changes ADR-0009's 800 ms, so it waits until live data shows the fallbacks matter.
- **One set of bands for every Clef model.** `clef-flash` would almost never close a turn fast at `clef`'s upper band, and its lower band would wrongly hold back finished sequences.
- **Turning masking off for Clef,** since the text stays with Cloudflare, which already stores the conversations. The owner chose to keep it.

## References

- [Spike: Cloudflare's Clef as the PT-BR end-of-turn qualifier](../spikes/clef-end-of-turn-ptbr.md)
- [Spike: Jev's latency from Brazil and its PT-BR end-of-turn accuracy](../spikes/jev-end-of-turn-ptbr.md)
- Workers AI: [clef](https://developers.cloudflare.com/workers-ai/models/clef/), [clef-flash](https://developers.cloudflare.com/workers-ai/models/clef-flash/), [data usage](https://developers.cloudflare.com/workers-ai/platform/data-usage/)
