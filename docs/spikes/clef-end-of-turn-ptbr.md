# Spike: Cloudflare's Clef as the PT-BR end-of-turn qualifier

- **Date:** 2026-10-06
- **Issue:** [#117](https://github.com/guedesdiogo/kelpie/issues/117)
- **Status:** `clef` decides the most turns with no error, but its latency tail passes the 800 ms timeout on 6% of calls
- **Source:** [`spikes/clef-end-of-turn/` at `b062cf2`](https://github.com/guedesdiogo/kelpie/tree/b062cf2/spikes/clef-end-of-turn), on branch `spike/clef-end-of-turn`. It isn't merged, like the earlier spikes' Workers.

## Question

Cloudflare hosts two decision models of its own on Workers AI:
- [`@cf/cloudflare/clef`](https://developers.cloudflare.com/workers-ai/models/clef/), 27B, at US$ 0.24 per million input tokens;
- [`@cf/cloudflare/clef-flash`](https://developers.cloudflare.com/workers-ai/models/clef-flash/), 9B, at US$ 0.09.

Both speak the System One API that Jev uses. They are called through the `AI` binding, with no key and no Unified Billing fee. Cloudflare doesn't use the inputs to train or improve models ([data usage](https://developers.cloudflare.com/workers-ai/platform/data-usage/)).

On 2026-10-06 the owner asked to focus on Clef and to keep Jev as an option. The spike measures both Clef models the way the [Jev spike](jev-end-of-turn-ptbr.md) measured Jev:
- on the same 101 labeled PT-BR sequences;
- with production's request: `endOfTurn`'s masked state and its single `noul` question.

## Method

- **Worker.** A throwaway Worker, `kelpie-spike-clef`, ran on the owner's account with an `AI` binding.
  - It timed each call inside the Worker and recorded `request.cf.colo`.
  - It was deleted after the run, together with the local file that held its token.
- **Calls.** For each model: one cold call, then two passes over the set, one request at a time from São Paulo. That makes 202 calls per model.
- **Data.** The Jev spike's frozen set: 51 finished sequences and 50 unfinished, synthetic, with no real user data.
- **Bands.** Production's end of turn is hybrid ([ADR-0018](../adr/0018-jev-direct-api.md)): a confident heuristic decides first, so the qualifier only sees what the heuristic leaves. In this set that is 71 of 101 sequences.
  - Each model's bands are the widest that make no wrong decision on those 71, in either pass.
  - `scripts/analyze.ts` derives them, and the per-kind table, from the run files.

## Results

### Clef refuses production's question id

The first calls failed with `invalid_request`. A question id must match `^[A-Za-z0-9_.-]{1,100}$`, and `runDecision` names the question `turn.end::user_finished`. Jev accepts `::`; Clef doesn't.

The Worker then sent `turn.end__user_finished` and mapped the answer back, which is what the production adapter has to do. After that, none of the 404 calls failed and production's policy declined none of the answers:

```json
{
  "model": "clef-flash",
  "answers": { "turn.end__user_finished": { "type": "noul", "noul": 0.9323 } },
  "usage": { "input_tokens": 181, "output_tokens": 0 }
}
```

### Latency

| Measure | `clef` | `clef-flash` | Jev 1.13.0 (spike #27) |
|---|---|---|---|
| Colo | `GRU` on all calls | `GRU` on all calls | `GRU` |
| Cold call | 773 ms | 433 ms | 249 ms |
| p50 | 455 ms | 250 ms | 251 ms |
| p95 | 835 ms | 743 ms | 317 ms |
| Max | 1,346 ms | 995 ms | 456 ms |
| Calls over the 800 ms timeout | 13 of 202 (6.4%) | 7 of 202 (3.5%) | 0 of 202 |

A call past the timeout isn't an error: `runDecision` falls back to the heuristic for that turn.

### Accuracy

| | `clef` | `clef-flash` | Jev 1.13.0 | Heuristic |
|---|---|---|---|---|
| Accuracy at 0.5 | 84% | 81% | 87% | 68% |
| Unfinished sequences recognized | 70% | 66% | 76% | 36% |
| Brier score | 0.116 | 0.125 | 0.138 | 0.184 |
| Expected calibration error | 0.131 | 0.103 | 0.197 | 0.082 |
| Bands measured on the 71 left by the heuristic | **0.95 / 0.46** | **0.87 / 0.37** | 0.70 / 0.40 | 0.8 / 0.3 |
| Hybrid: confident decisions of 101, wrong ones in brackets | **81 (0)** | 65 (0) | 69 (1–2) | 30 (0) |
| Largest change between passes | 0 | 0 | 0.07 | — |

The heuristic scores 68% here, against 67% in the Jev spike: the fix in #97 now reads "fechado então" correctly.

- **Clef spreads its probabilities**, where Jev compressed them.
  - `clef`'s finished sequences scored 0.47–0.98, median 0.96.
  - Its unfinished ones scored 0.02–0.94, median 0.17.
- **The few unfinished sequences Clef scores high set its upper band.** For `clef` these are greetings followed by a preamble ("boa noite / desculpa o horário", 0.94), an announced code ("vou te passar o código do rastreio / BR", 0.93), and "vou mandar o print" (0.86).
  - Lone greetings, trailing `:` and conjunctions also score high, but the heuristic settles those before Clef is asked.
- **`clef-flash` can't tell pauses and lone words apart from finished messages.** "pera", "espera", "primeiro" and "tipo" score 0.86–0.91. On its own bands it closes the turn fast on only 2 sequences.
- **Answers are deterministic.** Both passes gave identical probabilities for every sequence.

Decisions by kind of sequence, from the first pass. Each cell is the confident decisions taken, with the wrong ones in brackets. The heuristic is at 0.8 / 0.3, and each model at its own bands.

| Kind | Label | n | Heuristic | `clef` | Hybrid with `clef` | `clef-flash` | Hybrid with `clef-flash` |
|---|---|---|---|---|---|---|---|
| question | finished | 2 | 2 (0) | 2 (0) | 2 (0) | 2 (0) | 2 (0) |
| question with no `?` | finished | 5 | 0 | 3 (0) | 3 (0) | 2 (0) | 2 (0) |
| greeting, then a request | finished | 4 | 2 (0) | 4 (0) | 4 (0) | 2 (0) | 3 (0) |
| statement with no punctuation | finished | 11 | 0 | 9 (0) | 9 (0) | 6 (0) | 6 (0) |
| statement | finished | 2 | 2 (0) | 2 (0) | 2 (0) | 1 (0) | 2 (0) |
| acknowledgement | finished | 13 | 3 (0) | 5 (0) | 7 (0) | 2 (0) | 4 (0) |
| emoji | finished | 3 | 2 (0) | 1 (0) | 3 (0) | 2 (0) | 3 (0) |
| command | finished | 1 | 1 (0) | 0 | 1 (0) | 0 | 1 (0) |
| laughter | finished | 3 | 0 | 1 (0) | 1 (0) | 1 (0) | 1 (0) |
| question, then context | finished | 2 | 0 | 2 (0) | 2 (0) | 0 | 0 |
| several fragments | finished | 5 | 0 | 5 (0) | 5 (0) | 0 | 0 |
| greeting alone | unfinished | 4 | 4 (0) | 1 (0) | 4 (0) | 2 (2) | 4 (0) |
| greeting, then a preamble | unfinished | 3 | 0 | 1 (0) | 1 (0) | 1 (0) | 1 (0) |
| ends in a conjunction | unfinished | 6 | 6 (0) | 5 (0) | 6 (0) | 5 (1) | 6 (0) |
| ends in `,` `:` or `...` | unfinished | 6 | 6 (0) | 4 (0) | 6 (0) | 4 (0) | 6 (0) |
| pause ("pera") | unfinished | 6 | 1 (0) | 3 (0) | 4 (0) | 2 (1) | 2 (0) |
| announces more | unfinished | 7 | 0 | 5 (0) | 5 (0) | 5 (0) | 5 (0) |
| cut mid-sentence | unfinished | 10 | 0 | 10 (0) | 10 (0) | 10 (0) | 10 (0) |
| several fragments | unfinished | 8 | 1 (0) | 6 (0) | 6 (0) | 7 (0) | 7 (0) |

Each model's own column counts every sequence at that model's bands, which were measured on the 71 the heuristic leaves. Its wrong decisions there are cases the heuristic settles first in the hybrid.

### Cost

Each call counts about 179 input tokens, against Jev's 310 for the same request. Clef reports no output tokens.

| | Cost of the 202 calls | Per turn the heuristic leaves |
|---|---|---|
| `clef` | US$ 0.0087 | US$ 0.000043 |
| `clef-flash` | US$ 0.0033 | US$ 0.000016 |
| Jev 1.13.0 | US$ 0.0026 | US$ 0.000013 |

## What this means

- **`clef` is the strongest default for accuracy.** Its hybrid decides 81 of 101 sequences with no error, against Jev's 69 with 1 to 2. It does this through the `AI` binding: no key, and nothing leaves Cloudflare.
- **Its latency tail is the cost.** One call in 16 takes longer than the 800 ms timeout and falls back to the heuristic.
  - The decision runs while the buffer waits out its quiet window, which is at least 1.5 s. So a slower answer doesn't delay the reply; only a timed-out one loses Clef's decision.
  - Raising the timeout to about 1.4 s, and `llm-gateway`'s own bound with it, would keep every answer measured here. That changes ADR-0009's 800 ms, so it is left as an option.
- **`clef-flash` is fast but weaker than Jev.** Its hybrid decides 65.
- **Bands must be per model.** `clef` and `clef-flash` need different ones, so switching `CLEF_MODEL` without switching the bands would mislead the policy.
- **The production adapter must rename question ids.** It sends `::` as `__` and maps the answers back.

[ADR-0022](../adr/0022-clef-qualifier.md) records the decision, and [#118](https://github.com/guedesdiogo/kelpie/issues/118) implements it.

## Residuals

- **The labels and the bands come from 101 synthetic sequences,** as in the Jev spike.
  - A single sequence sets each band: "boa noite / desculpa o horário" sets `clef`'s upper one, and "kkkkk / verdade" its lower one.
  - Real conversations will move them.
- **One morning and one colo:** São Paulo, around 07:50 local time. Workers AI capacity elsewhere, or at other hours, may give a different latency tail.
- **No masked text was measured.** The set holds nothing that masking changes, as in the Jev spike.
- **Clef doesn't document zero data retention.** What Cloudflare documents is that it doesn't train on inputs, and stores them only in a storage service you use. Masking stays on for Clef, by the owner's decision of 2026-10-06.
