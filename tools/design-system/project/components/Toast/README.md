# Toast

A toast reports what finished out of sight, or offers Undo; a result that can show where it happened shows there instead (5.13, frequent grammar).

- **A result shows where it happened first:** a receipt, a row, a count. A toast is only for what finished out of sight, or for an action that offers Undo.
- **Placement.** Toasts sit at the bottom center, at most three stacked, each lower one at a scale of 1 − 0.05 per step. They enter with `rise` and `spring-base`, and leave with an exit. A toast is a `surface` chip (`r-chip`) with `shadow-pop`.
- **Timing.** A toast stays 5 s, or 10 s with Undo. An error stays until it is dismissed. Its timer pauses on hover, on focus and while the tab is hidden, and a thin bar shows the time left.
- **Undo.** Inside Kelpie (the vault, tasks), Undo reverses the change. For anything with effects outside Kelpie, the action waits for the toast to end, and Undo cancels it. That delay never applies to a confirmed change, which already has the owner's yes.
- **A polite live region** announces each toast; an error uses `role="alert"`.
- **The consumer provides** the text, the kind (done, undo, error) and the undo handler.
- **Reduced motion:** toasts fade in and out, without the stack offset. The time-left bar still shrinks, since it is progress.
