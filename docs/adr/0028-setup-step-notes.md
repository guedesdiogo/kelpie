# ADR-0028: A setup step the owner finishes is told to the conversation that sent its link

- Status: Accepted
- Date: 2026-10-10
- Issue: [#206](https://github.com/guedesdiogo/kelpie/issues/206)
- Accepted by the owner on 2026-10-10: «quero que o llm da conversa receba o retorno dos formulários para não precisa que eu tenha de dizer "feito"», and the plan on #206 approved with «ok para 1, 2 e 3»

## Context

Since [ADR-0026](0026-confirmation-by-owner-act.md), the setup agent's links go to admin API pages, where the owner's own act is the yes:
- the secure form connects an agent's Telegram bot;
- the pairing page leads to a Telegram link whose Start pairs the owner's account.

Neither place knows which conversation sent the link. In the owner's first run on `0.2.93`, the agent learned that each step was done only when the owner typed «feito».

The reference check on #206 found:
- **hermes-agent tells no one when a pairing is approved.** The user sends their message again, or a dashboard polls.
- **Its background notifications** run through the normal turn path, with a footer saying no human wrote them. They are stored as timeline notices, never as user bubbles, and they can't answer approvals.

## Decision

1. **The conversation waits for the step.**
   - When a setup tool has Kelpie send a link, the conversation tells the agent's `AgentHost` that it waits for that step, by its object's name.
   - The wait lasts as long as the link: the form's 15 minutes, or a day for pairing. The pairing page doesn't expire, and the Telegram code's hour starts only when the owner presses the page's button.
2. **What finishes the step reports it.**
   - The admin API reports when a form's token is stored. `ingress` reports when a pairing code is redeemed.
   - Each report is bounded and best effort: the page or the webhook answers whatever happens to it.
   - The `AgentHost` tells each conversation still waiting, once, and drops waits that ran out.
3. **Kelpie writes a note into the conversation.**
   - Its fixed words say no person wrote it: "Kelpie, automatically (the owner didn't write this): …". They are built only from checked fields: the step, the agent's id, the bot's username, and whether Telegram was pointed at Kelpie.
   - The note never interrupts a turn. It waits for the running one, or joins the owner's waiting messages, or starts a turn of its own. While the conversation is paused, it waits for the owner's next message.
4. **A turn the note starts acts for the owner who finished the step.** The note is authored as that owner, so the setup tools of the next step work.
   - This is the owner's own act, as in ADR-0026.
   - Like any owner turn, it can run the changes that need no confirmation.
   - Confirmations still need the code or the button. A note is never the owner's yes.
5. **A note is never the owner's words.** It is marked in the conversation's records, and kept out of everything that reads what the person said:
   - the code gate;
   - the links a reply may show (#130, #188);
   - the webchat's replay;
   - session pages and the vault's memory (#109);
   - recall's question;
   - the conversation's language (ADR-0027).

## Consequences

- `ingress` binds the `AgentHost`, as the admin API already does.
- The `AgentHost` keeps a small table of waits, and the conversation's records gain the marker.
- **Residual:** a wait is noted after the reply's bubbles are written. An eviction between the two, or an `AgentHost` that doesn't answer, loses the wait, and the owner says "done" as before.
- **Residual:** two conversations waiting for the same agent's step are both told. That is true either way: the bot is connected.

## Alternatives considered

- **Polling:** the conversation could check the form's or the pairing's state on a schedule. That means more calls, a delay, and a binding to the Directory that the runtime avoids.
- **Showing the note to the owner as a message.** The agent's reply already says it, and a message the owner didn't type would read as theirs.
- **Interrupting the running turn, as a message does.** The note isn't a new request from the owner, and waiting for the turn loses nothing.

## References

- [ADR-0013](0013-self-configuration.md), [ADR-0026](0026-confirmation-by-owner-act.md), [ADR-0027](0027-fixed-texts-in-three-languages.md)
- [#206](https://github.com/guedesdiogo/kelpie/issues/206), where the reference check is recorded
