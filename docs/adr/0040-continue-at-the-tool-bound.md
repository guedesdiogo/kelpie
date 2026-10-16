# ADR-0040: When a turn reaches its tool bound, Kelpie offers to continue, and the owner's press grants one more bound

- Status: Accepted
- Date: 2026-10-14
- Issue: [#307](https://github.com/guedesdiogo/kelpie/issues/307)
- Amended by: [ADR-0055](0055-composer-files-dictation-and-model.md), a continuation also keeps the earlier turn's one-reply `max` (§4)
- Decided by the owner on 2026-10-13, answering research note 10's Q2: «Q2: sim»

## Context

**Kelpie's bound ends the work.** ADR-0025 §3 bounds a turn's tools at 5 rounds, within the agent's `toolLoopMs`. Past either bound:
- the remaining calls get an error result saying the limit is reached;
- one last call then answers with what it has;
- if that call still asks for tools, a fixed text answers: "I couldn't finish this within my limits. Ask me again, or narrow it down."

Either way the work stops. To go on, the owner has to ask again in words, and the next turn's model has to work out what that refers to.

**eve holds the turn instead.** It has no per-turn bound. When a session reaches its token or cost budget, the turn holds on a fixed continue-or-stop request that the harness writes, not the model ([`budget-request.ts`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/harness/hitl/budget-request.ts#L1-L21)).

Research note 10 asked whether Kelpie should offer a Continue button at its bound, as an owner's act (ADR-0026). The owner answered «sim».

## Decision

1. **The bound stays.** ADR-0025 §3 is unchanged up to the turn's reply: the error results, the last call, and the fixed text when the last call still asks for tools.
2. **Kelpie then offers to continue,** in a notice of its own sent after the turn's reply.
   - **When:** whenever the turn reached either bound, its 5 rounds or its `toolLoopMs`, including a call stopped by the time limit. A turn that stopped for a new message, a pause or a failure gets no notice.
   - **What it says:** that the agent stopped at its limit for tools on this turn, and how to continue. It is a fixed text in the conversation's language (ADR-0027) that the model can't alter.
   - **In the webchat:** a Continue button of its own, bound to that notice's id, under the rules of ADR-0026 §3's Confirm button.
   - **On Telegram:** until its buttons arrive (ADR-0026 §4), the notice asks the owner to reply to continue. Any reply starts a new turn with a fresh bound, as today, so no code is needed.
3. **Only the turn's requester may press it:** the author of the turn's latest message, from their own socket.
   - The offer lasts 10 minutes, as a confirmation does.
   - Any new message from that user closes it, because their next turn starts anyway.
4. **Continuing starts a new turn with a fresh bound.**
   - The press sends a fixed "Continue" for the owner, in the conversation's language, through the same path as a Confirm press's code (ADR-0026 §3), the buffer's wait included (ADR-0024).
   - That turn gets 5 more rounds and a full `toolLoopMs`.
   - History holds the earlier calls and their results, so the model resumes from them.
   - **It keeps the earlier turn's recall question,** instead of asking memory about the word "Continue". On `auto` (ADR-0041), it also keeps that turn's tier.
   - The press is the owner's act: text from the model, a tool or another agent can't continue (ADR-0013).
5. **No cap on how many times.** Each continuation is one act of the owner's, so a person decides every extra bound.

**Out of scope:**
- **Background tasks (ADR-0011).** A task that reaches its bound follows its own story, once #54 exists: its natural place is Waiting, with the same choice.
- **Turns on ADR-0037's `claude-code` route,** whose tool loop runs inside Claude Code. That route's story defines their bound.

### Amendments

- **[ADR-0025](0025-turn-tool-loop.md) §3:** after the reply of a turn that reached its bound, Kelpie offers to continue. Continuing grants one more bound in a new turn, which keeps the earlier turn's recall question.
- **[ADR-0026](0026-confirmation-by-owner-act.md):** besides confirmations, Kelpie's notices may carry a Continue button past the tool bound. It is a separate button under the same rules: bound to the notice's id, pressed only by the requester, for 10 minutes.

## Consequences

- **Work that runs out of rounds or time can go on with one press,** instead of a new request the model has to interpret.
- **Each continuation costs another bound's model calls,** at the owner's choice every time.
- **The bound still protects against a looping model:** no continuation happens without a person.
- **The conversation gains a second kind of open notice** beside confirmations, with its own expiry and requester check.
- **On Telegram, continuing is an ordinary reply** until its buttons arrive. That reply drives its own recall, as any message does.

## Alternatives considered

- **Raise or remove the bound,** as eve does with a session budget instead. A looping model would spend until the budget ran out. Per-agent budgets don't exist yet (ADR-0036 §5).
- **Let the model decide to continue.** That removes the bound.
- **Hold the turn open on the question,** as eve does. Kelpie's turn ends with its reply (ADR-0025), and a new turn over the same history gives the same result with no new machinery.

## References

- [Research note 10](../research/10-eve.md), Adapt 2 and Q2
- [ADR-0011](0011-agent-task-board.md), [ADR-0013](0013-self-configuration.md), [ADR-0024](0024-fixed-wait-end-of-turn.md), [ADR-0025](0025-turn-tool-loop.md), [ADR-0026](0026-confirmation-by-owner-act.md), [ADR-0027](0027-fixed-texts-in-three-languages.md), [ADR-0037](0037-conversations-through-claude-code.md), [ADR-0041](0041-auto-tier-by-qualifier.md)
- Kelpie's bound: [`tools.ts#L11-L44`](https://github.com/guedesdiogo/kelpie/blob/1b1d945/apps/conversation-runtime/src/tools.ts#L11-L44), [`conversation-agent.ts#L1044-L1048`](https://github.com/guedesdiogo/kelpie/blob/1b1d945/apps/conversation-runtime/src/conversation-agent.ts#L1044-L1048)
