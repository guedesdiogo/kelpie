# HoldButton

Hold to turn on something that costs: the action runs only at the end of a deliberate gesture, and letting go early undoes nothing (5.4, moment grammar).

A feature that costs beyond the Workers Paid plan turns on only at the owner's request (CLAUDE.md). The same hold, smaller, is the "Hold to pause this conversation" control on a confirmation card (5.3).

- **The hold.** The owner holds the button: a fill (`accent` at 28%, the `--hold-fill` tint, under a label in `fg`) grows from the left, linearly, over `dur-hold` (1200 ms). Space and Enter hold it too, with focus on the button, and the fill grows for them as well, since it is progress.
- **Released early**, the fill goes back from where it is with `spring-moment-fast`, and the label returns.
- **Complete**, the button turns `ok`, pops (`scale` 1.03 to 1, `spring-pop`) and a ring leaves its edge (650 ms, opacity 0.7 to 0, scale 1 to 1.5), as in 5.3.
- **The boundary** is `muted`, like every control.
- **The typed confirmation code** in the chat (ADR-0026) stays as the alternative for anyone who can't hold. Say so under the button.
- On a phone, the label stays visible above the finger (5.15).
- **The consumer provides** the label, the label once done, and what runs on completion.
- **Reduced motion:** the fill still grows and empties, without the spring. Completion changes the color and shows the check, without the pop and the ring.
