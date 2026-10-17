# Composer

Where the owner writes: one row, as the approved demo, with the text, then Pause, then Send, both round icon buttons inside the field on the right (5.20, frequent grammar; #378, decision 4).

- **The field** is one row with a 1px `muted` boundary, `r-panel` corners, `bg` inside, 6px of padding (12px on the left), at least 40px tall. With focus, the boundary turns `accent` with a 3px `--focus-halo`.
- **The text** is 15px (`text-base`), and 16px on a phone (`input-phone`) so the page doesn't zoom on focus. The placeholder, "Write to Agenda", is `muted`.
- **It grows** with its text up to 160px, about six lines, through `field-sizing: content`, at once (rule 1).
- **Send** is a 26px circle in `accent` with an up arrow in `on-accent`. Empty, it waits in `sunken` with a `muted` arrow, `aria-disabled` but focusable, and its tooltip says why: "Write a message to send". The first character turns it ready, a color change in `dur-fade` with no scale. It never shows a spinner and never becomes Stop: while an agent works, it queues. **Pause** is a 26px circle with a `muted` ring and two bars; pressed (`aria-pressed`), it fills with `sunken` and its bars turn `muted`. On a phone both grow to 44px. Pause keeps 12px from Send, so a tap meant for one never lands on the other. Each names itself in a tooltip (IconButton).
- **No keyboard hint on screen.** Screen readers keep it, in the field's label: Enter sends, Shift+Enter breaks the line. Nothing is sent while an input method composes (`isComposing` or keyCode 229). On a touch keyboard, Enter breaks the line and the button sends.
- **Pause stays a separate control.** A single button that turned Send into Pause would pause on a second tap right after sending. Offline, Pause stays pressable and its toast says why it can't pause.
- **Paused.** A line above the field, in `text-sm` `muted` with the pause icon, says what resumes it: "Paused. Agenda answers after your next message." Nothing waits on the owner, so it isn't `warm`, and writing is how they resume.
- **A printable key** pressed anywhere focuses the field, except in a field, a dialog or on a button, and "Skip to message" opens the tab order.
- **While the owner types,** the conversation's mascot only breathes and blinks: reading comes first.
- **The wrapper** pads it 8px above, 32px at the sides and 20px below (12px and 28px on a phone), with the safe-area inset under it, and keeps it above the keyboard (5.15).
- **Research (§8),** read on 2026-10-16: adopt Telegram Web A's single row with Send inside and room beside it ([code](https://github.com/Ajaxy/telegram-tt/blob/090e38f1dffec3e0a9aefbec8159a9931fbeec8f/src/styles/_composer-primitives.scss)), and Claude Code's queue-while-working with a separate stop ([doc](https://code.claude.com/docs/en/interactive-mode)); adapt Geist's rule to disable a button only with a tooltip that says why ([doc](https://vercel.com/geist/button)); avoid a Send that turns into Stop, as AI Elements' and Telegram's do, since a second tap would stop the agent.
- **The consumer provides** the agent's name, the send and pause handlers, and whether the conversation is paused.
- **Reduced motion:** nothing here moves; the paused line fades.
