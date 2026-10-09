# ADR-0026: The owner's own act on a Kelpie page or button is a yes, besides a typed code

- Status: Accepted
- Date: 2026-10-09
- Issue: [#186](https://github.com/guedesdiogo/kelpie/issues/186)
- Accepted by the owner on 2026-10-07, on #48: «Link/botão como o sim»

## Context

[ADR-0013](0013-self-configuration.md) requires an explicit yes before an agent changes access, cost or an external account. The yes must come from the owner, in the same conversation. Story 3.11 (#48) built that yes as a code:
- after the agent's reply, Kelpie sends a notice of its own with the change and a 6-character code;
- the owner replies with just that code.

The owner's smoke test of #48 found the code to be friction: «por que precisa de mim para enviar aquele código… não daria para ele mesmo resolver isso?». The model can't say yes itself, though. Otherwise a vault note, a pasted message or a tool's output could connect channels or change settings. On 2026-10-07 the owner chose a link or a button as the yes.

Two of the setup agent's tools already lead to an admin API page that sits behind the owner's Access login and the owner check:
- `connect_telegram` leads to the secure form;
- `pair_telegram` leads to the pairing page.

Each page names what it does, and runs it only when the owner submits it there. The model, however, passed the link on in its own words, so it could have altered it. The form's one-time token also stayed in history.

## Decision

This amends ADR-0013's confirmation for the setup agent's tools.

1. **An act on an admin API page is a yes.**
   - **What counts:** the owner submits a page behind their Access login and the owner check, the page names the change, and it runs only on that submission. The page is not bound to a conversation: the owner may open it by its URL.
   - **The secure form** (`connect_telegram`) is the owner's yes to connecting a bot, so opening a form needs no code.
   - **The pairing page** (`pair_telegram`) is the owner's yes to pairing.
2. **Kelpie sends those links itself.**
   - The tool hands the link to the host. The host sends it after the agent's reply, as a notice of its own that the model can't alter. The notice names the agent only by its id, because names come from the model.
   - The model learns only that the link was sent. History, later requests and the outbox's inspection never hold the link.
   - Only a page on the admin API's origin can be sent this way, and it is the notice's one link.
3. **In the webchat, a Confirm button sends the code.**
   - A confirmation's notice carries a Confirm button, bound to that confirmation's id.
   - The owner's press counts only when it comes from the socket of the user who asked, for a confirmation of theirs that is still open. The conversation then replies with the code for them. The rest of ADR-0013's gate is unchanged: one change, once, within its 10 minutes.
   - Text that the model or a tool writes can't press the button. Only Kelpie's own notices carry it, and only the page can send a press.
4. **The typed code stays.** It is how the owner confirms on Telegram, and it still works in the webchat. Telegram's inline buttons are a later addition. Their callback data must then carry the confirmation's id, never a counter or "the oldest pending" one.

The rest of ADR-0013 stands. Content from tools, web pages, documents or other agents never confirms, and smaller changes still run directly.

## Consequences

- Connecting a bot and pairing take no code. The form's token reaches only the owner.
- In the webchat, a settings change takes one press.
- The conversation stores, with each notice, its one link or its confirmation's id. A turn stores the links its tools had Kelpie send until its reply is written.
- **What doesn't change:** a notice is still not history, so it doesn't come back once its turn has settled and the webchat reloads.
- **A residual of #188:** a reply may still link any admin API page, so the model can show a fake form link beside the real one. Such a page is behind Access, and a form that doesn't exist says the link no longer works.

## Alternatives considered

- **Let the button run the change directly, without the model.** The conversation would need the tool's code and its original input. Replying with the code keeps one gate for the button and the typed code.
- **A new "approved" state on the confirmation.** It would add a second path into the gate. A press that sends the code reuses the code's checks:
  - only the requester;
  - only after the notice;
  - once;
  - within its time.
- **Keep the code for `connect_telegram`.** It would ask for two yeses for one change: the code, then the form.

## References

- [ADR-0013](0013-self-configuration.md), [ADR-0023](0023-webchat-access-login.md)
- [#186](https://github.com/guedesdiogo/kelpie/issues/186), where the reference check is recorded, and [#48](https://github.com/guedesdiogo/kelpie/issues/48)
