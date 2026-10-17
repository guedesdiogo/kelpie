# TaskBoard

The task board: a routine's fire becomes a card that leaves its chip, the agent that takes it enters the card as its 20 px mascot, and the card travels between columns (5.5, frequent grammar; ADR-0011, ADR-0039).

- **The routine fires.** Its chip pulses once (`scale` 1.05 to 1, `spring-fast`), and the new card leaves it: from the chip's position at scale 0.7 to its slot at the top of its column (FLIP, `spring-base`). The cards below move down with it.
- **Column counts** roll like labels.
- **An agent takes the task.** Its mascot enters on the card at 20 px (`scale-in`, `spring-fast`): the shape, the color and the eyes only, still, since the card already says the state. The card travels to the next column (FLIP, `spring-base`). A progress bar fills only from real progress.
- **Done**, the check draws and the title turns `muted`. The card carries the evidence of the work (a link, a file, a screenshot) and its duration in the past tense: "Ran 4 min 12 s".
- **Delegation shows.** A task the owner gave an agent carries "Delegated by you": the owner stays accountable, the agent does the work.
- **Dragging a card.** People move a task only between Backlog and To do; from In progress on, the agent owns its status (ADR-0011). So only cards in those two columns lift, and only those columns accept a drop; other cards and columns show a no-drop cursor.
  - Picked up, it scales to 1.03 with `spring-fast` and takes `shadow-pop`. Its slot keeps a dashed outline at 40%, and the other cards open the gap (FLIP, `spring-base`).
  - Released, it settles with `spring-base`, and the `--landed` tint (`accent` at 22%) fades from it in 400 ms.
  - A move is optimistic. If the server refuses it, the card returns to its slot with `spring-base`, and a toast says why.
  - Every Backlog and To do card also has a Move menu. From the keyboard, Space lifts it, the arrows move it at once, Space drops it and Escape cancels. A live region says where it landed: "Moved to To do, position 1".
- **The consumer provides** the columns, the cards (title, agent, origin, delegation, evidence, duration) and the move handler.
- **Reduced motion:** a card fades out of one column and into the next, and counts change with a fade. A dragged card follows the pointer without the lift, and the landing tint fades in `dur-fade`.
