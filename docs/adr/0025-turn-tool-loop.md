# ADR-0025: A turn runs its tools in a bounded loop that keeps history append-only

- Status: Accepted
- Date: 2026-10-06
- Issue: [#141](https://github.com/guedesdiogo/kelpie/issues/141)
- Accepted by the owner on 2026-10-06, in the decisions on [#126](https://github.com/guedesdiogo/kelpie/issues/126):
  - on interruption: «aceito, mas quando for enviado a proxima mensagem essa mensagem que parou no meio deve ser considerada»;
  - on bounds: 5 rounds, and a time bound of at least 120 s that can go higher;
  - on status: the webchat shows the turn's real step, and other channels show "typing".

## Context

Before this ADR, a turn made one model call and sent no tools. Two stories need the model to call tools:
- the setup agent's configuration commands, Story 3.11 ([#48](https://github.com/guedesdiogo/kelpie/issues/48));
- the memory tools, Story 4.15 ([#126](https://github.com/guedesdiogo/kelpie/issues/126)).

Three constraints come from earlier decisions:
- **Interruption.** [ADR-0002](0002-runtime-foundation.md) has a new message interrupt the turn in flight.
- **An unchanged prefix.** [ADR-0017](0017-history-compaction.md) and #137 keep every request's earlier messages unchanged. Opus 5.5, Sonnet 5.5 and Fable 5.1 bind each thinking block to everything sent before it.
- **Calls and results.** Providers reject a tool call that has no result.

## Decision

1. **Providers.** Each provider offers an agent tools (ADR-0014's tool layer). A tool has a spec, a plain-words label and a `run`.
   - A run gets the actor, the agent, the turn's memory scopes and an abort signal. The actor is built from the turn's admitted user, `via: agent:<id>`, never from model output.
   - A turn asks for its tools once and sends the same list in every round.
2. **The loop.** A reply that asks for tools goes into history as a row of the turn, native output included. Its calls run one at a time, and a `tool` row with every call's result follows the reply.
   - The next call sends history again, unchanged. The turn's memory block goes back as a text part of the turn's last user message, where the first round's adapter placed it. From round 2 on, no `context` field is sent.
   - Only the final reply is delivered. A reply that called tools, including any text it said before them, is never shown to the person.
3. **Bounds.** A turn runs at most 5 rounds of tools, within the agent's `toolLoopMs`.
   - `toolLoopMs` is 120 s by default, the floor the owner set, and can go up to 10 minutes. It counts from the turn's first model call.
   - Past either bound, the remaining calls get an error result saying the limit is reached. That result is the notice: it sits in the newest tool result, never in a message of its own. One last call then answers, with the same tools, so the prefix stays.
   - If that call still asks for tools, a fixed text answers, and its calls never reach history.
4. **Interruption.** A new message, a pause or a failure settles the turn at once.
   - Calls that finished keep their results.
   - Every call that never ran gets a stub result, so each call has its result row.
   - The turn's memory block stays with it once a call is in history.
   - The next turn answers every message since the last reply, and can revise what the interrupted calls did.
   - After an eviction, a recovered turn first gives stubs to the calls left without a result, then calls the model again with the block it first sent. Recall doesn't run again.
5. **History.** Calls and results stay in history for later requests, checkpoints and replays.
   - A checkpoint cut falls on a user message, so it never separates a call from its result.
   - The webchat's replay and the session pages show only what the person saw.
   - The checkpoint summary skips rows with no text of their own.
6. **Status.** Once the wait for more messages is over, a channel that can show the turn's step does: the webchat shows reading memory, thinking, and each tool by its label, then typing before the bubbles, and clears the step when a turn stops without a reply. The other channels, Telegram included, keep "typing" up from the start of processing.

## Consequences

- #48 and #126 add their providers without changing the loop. Production has none until they land, so requests are unchanged until then.
- A tool error reaches the model as a fixed text. The error's own message is never passed on or logged, because it could quote personal data.
- Calls run one at a time, so a round with several slow calls can reach the time bound sooner. Running them in parallel can come later, for calls known to be independent.
- The fixed texts are in English. The model answers in the person's language otherwise.
- The checkpoint summary sees what the model said, not the tools' results.

## Alternatives considered

- **Notices as a new system or user message.** That adds a message the model didn't see in earlier rounds, which changes the prefix and breaks preserved thinking.
- **Dropping the calls of an interrupted turn.** The provider rejects calls that have no results, and whatever those calls did, such as a memory write, would vanish from what the next turn sees.
- **Running calls in parallel now.** Faster, but configuration commands and memory writes can depend on order.
- **A loop without bounds.** A model that keeps asking for tools would keep the person waiting and spend without limit.

## References

- [ADR-0002](0002-runtime-foundation.md), [ADR-0013](0013-self-configuration.md), [ADR-0014](0014-agent-tool-scope.md), [ADR-0017](0017-history-compaction.md)
- [#126's reference check](https://github.com/guedesdiogo/kelpie/issues/126#issuecomment-6019748684) and [the owner's decisions](https://github.com/guedesdiogo/kelpie/issues/126#issuecomment-6021666858)
