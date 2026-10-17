# CommandPalette

The palette is the clearest case of rule 1: opened by a click it grows from its trigger; opened from the keyboard it is simply there (5.8, frequent grammar).

- **Opened by a click**, it grows from its trigger: `scale` 0.97 (`scale-in`) and 6px above, to 1, with `spring-fast`. The scrim (`fg` at 16%) fades in `dur-fade`.
- **Opened with ⌘K or Ctrl K**, it appears at once. Arrow keys, filtering, Enter and Escape are instant too.
- **Only the pointer animates.** Hovering moves the highlight with `spring-fast`. A pointer that hasn't moved since the palette opened doesn't move the highlight.
- **Closed by a click**, it leaves in `dur-exit`.
- **It is a `surface` card** with `r-card` corners and `shadow-pop`; its field's boundary is `muted`.
- **The consumer provides** the commands (icon, label, action).
- **Reduced motion:** a click opens and closes it with a fade, and the highlight jumps.
