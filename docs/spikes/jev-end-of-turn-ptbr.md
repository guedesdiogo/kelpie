# Spike: Jev's latency from Brazil and its PT-BR end-of-turn accuracy

- **Date:** 2026-10-05
- **Issue:** [#27](https://github.com/guedesdiogo/kelpie/issues/27)
- **Status:** Jev is fast enough for the hot path and beats the heuristic, but its PT-BR probabilities need their own thresholds
- **Source:** [`spikes/jev-end-of-turn/` at `96c8eb3`](https://github.com/guedesdiogo/kelpie/tree/96c8eb3/spikes/jev-end-of-turn), on branch `spike/jev-end-of-turn`. It isn't merged, like the earlier spikes' Workers ([ADR-0010](../adr/0010-monorepo-tooling.md)).

## Question

[ADR-0009](../adr/0009-qualifier-and-jev.md) lets Jev close the user's turn in the buffer, with an 800 ms timeout and the heuristic as fallback. Two things were unmeasured ([research note 04](../research/04-jev.md) §2.3, §2.5):
- Jev's latency from Brazil. TypeSafe serves it from the US West Coast.
- Its accuracy on informal PT-BR. TypeSafe says non-English works, "but not equally well".

The spike also checked that Jev accepts the production request as `endOfTurn` writes it:
- a `noul` question with no `criteria`;
- the question id `turn.end::user_finished`;
- an answer field the production policy can read.

## Method

- **Path.** Jev was called directly through TypeSafe's API (`POST /v1/systemone`), not through Cloudflare's Unified Billing. The owner chose this on 2026-10-05 to avoid the 5% fee on Cloudflare credit purchases. The model was pinned to `jev-1.13.0`.
- **Worker.** A throwaway Worker, `kelpie-spike-jev`, ran on the owner's account. It built the request from the production `endOfTurn` decision (its `state()` and `questions()`, with `runDecision`'s `turn.end::` prefix).
  - It timed the call inside the Worker, body included, and recorded `request.cf.colo`.
  - It was deleted after the run, together with the local file that held the API key.
- **Calls.** The runner called the Worker from São Paulo one request at a time. One cold call came first, then two passes over the set: 202 calls.
- **Data.** 101 synthetic PT-BR sequences, with no real user data.
  - 51 are finished, meaning the user is waiting for a reply; 50 aren't.
  - They cover the heuristic's own cases and cases outside its rules: sentences cut mid-way with no conjunction at the end, a list announced but not sent, "pera", laughter, a question followed by more fragments.
  - The labels were committed (`8ff6245`) before Jev or the heuristic ran.
- **Policies compared.** The production policy has three bands: at or above 0.8 the reply goes out fast, at or below 0.3 the buffer waits longer, and otherwise it waits the default time. A wrong fast close interrupts a user who is still typing. A wrong slow wait makes a finished user wait longer.

## Results

### The production request works as written

All four request variants answered, with and without the prefix and with and without `criteria`. The production one:

```json
{
  "model": "jev-1.13.0",
  "answers": { "turn.end::user_finished": { "type": "noul", "noul": 0.87 } },
  "usage": { "input_tokens": 312, "output_tokens": 24 }
}
```

`endOfTurn.policy` read it unchanged (`finished: 0.87`). Adding `criteria` changed the answer by 0.03 and cost 36 more input tokens.

### Latency

| Measure | Value |
|---|---|
| Colo | `GRU` on all 202 calls |
| Cold call | 249 ms |
| p50 | 251 ms |
| p95 | 317 ms |
| Max | 456 ms |
| Calls over the 800 ms timeout | 0 of 202 |

### Accuracy

| | Jev | Heuristic |
|---|---|---|
| Accuracy at 0.5 | 87% | 67% |
| Unfinished sequences recognized | 76% | 36% |
| Fast closes at the production bands (≥ 0.8) | 16, 0 wrong | 11, 0 wrong |
| Slow waits at the production bands (≤ 0.3) | 17, 0 wrong | 19, 1 wrong |
| Brier score | 0.138 | 0.190 |
| Expected calibration error | 0.197 | 0.072 |

- **Jev ranks well but compresses its probabilities on PT-BR.**
  - Finished sequences scored 0.45–0.89, median 0.70.
  - Unfinished ones scored 0.18–0.69, median 0.38.
  - None reached 0.9 or fell below 0.18. At the production bands, Jev decides barely more often than the heuristic (33 against 30 of 101).
- **With bands of its own, at or above 0.70 and at or below 0.40,** Jev decides 54 of 101 with no errors: 26 fast closes and 28 slow waits.
- **A hybrid decides the most.** It lets a confident heuristic rule decide first and Jev decide the rest with its own bands. That decides 69 of 101, with 1 error in the first pass and 2 in the second:
  - "fechado então 🤝" is a heuristic error, read as unfinished because it ends in "então";
  - "ola boa tarde / é a primeira vez que compro com vcs" got 0.72 from Jev in the second pass.
- **Repeated calls agree.** The same sequence moved by at most 0.07 between passes.

Decisions by kind of sequence, from the first pass. Each cell is the confident decisions taken, with the wrong ones in brackets:

| Kind | Label | n | Heuristic (0.8 / 0.3) | Jev (0.7 / 0.4) | Hybrid |
|---|---|---|---|---|---|
| question | finished | 2 | 2 (0) | 2 (0) | 2 (0) |
| question with no `?` | finished | 5 | 0 | 3 (0) | 3 (0) |
| greeting, then a request | finished | 4 | 2 (0) | 4 (0) | 4 (0) |
| statement with no punctuation | finished | 11 | 0 | 10 (0) | 10 (0) |
| statement | finished | 2 | 2 (0) | 1 (0) | 2 (0) |
| acknowledgement | finished | 13 | 3 (0) | 2 (0) | 5 (0) |
| emoji | finished | 3 | 2 (1) | 0 | 2 (1) |
| command | finished | 1 | 1 (0) | 0 | 1 (0) |
| laughter | finished | 3 | 0 | 0 | 0 |
| question, then context | finished | 2 | 0 | 1 (0) | 1 (0) |
| several fragments | finished | 5 | 0 | 3 (0) | 3 (0) |
| greeting alone | unfinished | 4 | 4 (0) | 0 | 4 (0) |
| greeting, then a preamble | unfinished | 3 | 0 | 0 | 0 |
| ends in a conjunction | unfinished | 6 | 6 (0) | 4 (0) | 6 (0) |
| ends in `,` `:` or `...` | unfinished | 6 | 6 (0) | 5 (0) | 6 (0) |
| pause ("pera") | unfinished | 6 | 1 (0) | 2 (0) | 3 (0) |
| announces more | unfinished | 7 | 0 | 2 (0) | 2 (0) |
| cut mid-sentence | unfinished | 10 | 0 | 9 (0) | 9 (0) |
| several fragments | unfinished | 8 | 1 (0) | 6 (0) | 6 (0) |

Where Jev is wrong at 0.5, it leans towards "finished":
- greetings alone ("oi", "bom dia", "olá"), at 0.55–0.67;
- pauses ("pera", "espera"), at about 0.58;
- announcements ("vou mandar o print", "primeiro"), at 0.50–0.64.

The heuristic covers greetings, and it is silent on the rest.

### Cost

On average 310 input tokens per call; output is free. The 202 calls cost US$ 0.0026, about US$ 0.000013 per turn.

## What this means for ADR-0009

- **The 800 ms timeout holds from Brazil,** with room to spare: p95 317 ms, max 456 ms. One fan-out call per turn fits.
- **Thresholds must be per qualifier.** The production bands (0.8 / 0.3) suit the heuristic's values, not Jev's compressed PT-BR probabilities. This set suggests 0.70 / 0.40 for Jev 1.13.0, to be recalibrated on real conversations before relying on it, and again when the pinned version changes.
- **End of turn should be hybrid,** as ADR-0009 already says. Confident heuristic rules (greetings, a trailing conjunction or `,` `:` `...`, a `?`, a command) decide first, and Jev decides the rest. This is a policy over both answers, calibrated against labels. The heuristic isn't trained on Jev's output, so the "no distillation" clause in TypeSafe's terms isn't touched.
- **The production request needs no change for the direct API.** `JevHttpQualifier` can send `endOfTurn`'s questions as they are and map `noul` straight through.

[ADR-0018](../adr/0018-jev-direct-api.md) records these changes.

## Residuals

- **The labels are mine,** written by the agent that also wrote the heuristic's rules. A few are arguable: whether "oi" alone waits for a reply or for more text is a matter of habit. The owner may spot-check a sample.
- **The thresholds come from 101 synthetic sequences.** That can overfit, and real chats are messier.
- **One afternoon and one colo:** São Paulo, around 16:00 local time. TypeSafe says its rate limits "are adjusting dynamically".
- **The heuristic's "então" rule misreads "fechado então"** as unfinished. That is a pre-existing bug, filed as a follow-up.
- **Privacy.** On the direct API, TypeSafe offers zero data retention only on enterprise plans. Masking personal data before every call (ADR-0009) is therefore required on live traffic.
