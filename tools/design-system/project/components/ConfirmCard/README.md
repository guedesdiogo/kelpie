# ConfirmCard

The card where the owner's press is the yes: it names who asks, shows the evidence, and offers Confirm, Deny this call and a hold to pause (5.3, moment grammar; ADR-0026, ADR-0044).

A confirmation nobody answers expires after its 10 minutes (ADR-0026 §3), and the card collapses into an "expired" receipt with a neutral icon.

**The compact card** (#378, decision 13): the agent's still 40 px mascot in Waiting and "`agenda` asks for your confirmation" with the task and how long the request stays open, the request in one line, the evidence marked "Written by the agent", the two answers on the right, and the smaller hold under them as a pill.

**Decide in place.**
- A Sidebar row draws the same card under itself for its agent's request (ADR-0052). Its press and its hold go over that row's socket, never over the open conversation's.
- A press in the card's first 400 ms is ignored, after it draws or draws again: it may have appeared under the pointer (ADR-0052 §5). An open card's content never changes in place.
- The card names the agent that asks by its id, and its task by number ("`agenda` asks, on task #123"). A task's title, written by the agent, may follow only as quoted data.
- It carries what the owner needs to decide without leaving it: the event, the diff, the cost. For a write to memory: the operation, the note's path, its text, and a warning when it replaces an existing note.

**Three answers** (ADR-0044):
- **Confirm**, the primary button;
- **Deny this call**, beside it. It closes the confirmation, and the agent goes on without that change;
- **Hold to pause this conversation**, a smaller control under them. It uses the hold of 5.4 and runs the existing pause: the next answer waits for the owner's next message, and background tasks keep running.

**What the card shows is bounded** (ADR-0044 §1). The agent is named by its id. The evidence comes from the tool call's typed fields, appears as quoted data marked as written by the agent, and never carries a link or a control.

**The agent's mascot answers with the card** (see Mascot), in the conversation's header:
- while the card is open, it takes Waiting: its eyes on the owner, brows up, the amber bubble; among its gestures, it points at the card;
- Confirm brings Approved for 1.1 s, a happy jump, then what comes next;
- Deny (#361) and an expiry bring no announcement: the pose changes as for any state change, as quiet as the neutral receipt;
- from the keyboard, each change shows the new pose without its announcement.

**Motion.**
- **The press.** The button scales to `scale-press` and grows to the card's full width (width and position, `spring-moment`). The other button leaves as it grows (exit, `scale-in-moment`).
- **Working.** Its label rolls to a spinner and what is happening ("Creating the event"). After 5 s, a still ring and the elapsed time take its place (rule 8).
- **Success:** its fill turns `ok` (`dur-fade`); the check draws in 280 ms; the button pops (`scale` 1.03 to 1, `spring-pop`); a ring leaves its edge (650 ms, opacity 0.7 to 0, scale 1 to 1.5).
- **Denied,** the button grows the same way, then the card folds into a neutral receipt: a `muted` icon, no check, no pop and no ring, in `dur-fade`.
- **The receipt.** The card collapses into it: its content fades (exit), its height goes to the receipt's (`spring-moment`), and the receipt rises 4px. It says who decided what and when, in the owner's time zone: "You confirmed at 14:32" or "You denied at 14:32. `agenda` goes on without it." A polite live region announces it.

**From the keyboard.** Enter or Space acts only with focus on a button; Enter in the composer sends a message and never confirms or denies. A key already held down when the card appeared doesn't count. A keyboard confirm or deny skips the grow, the pop and the ring: a confirm goes from the label to the spinner, to the check, to the receipt; a deny, which runs nothing, goes straight to the receipt.

**The consumer provides** the agent's id, the task number, the typed evidence fields and the three handlers.

**Reduced motion:** the grow, the pop and the ring go. The color change, the check and the receipt stay, each with a fade. The mascot is Still.
