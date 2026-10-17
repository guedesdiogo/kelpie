# Button

A button commits an action when it is released; the primary one is `accent`, every other one draws its boundary in `muted`.

- **Primary** (`k-btn primary`): `accent` fill, `on-accent` text, weight 600, `r-btn` corners, 8px by 15px of padding (the lab's button, #378). One per view: Confirm, Sign in again. Send is not a word button: it is the composer's round icon (IconButton).
- **Secondary** (`k-btn`): no fill, a 1px `muted` boundary, `fg` text. `line` is too faint for a control's boundary (1.49 on `surface`, WCAG 1.4.11).
- **Done** (`k-btn ok`): `ok` fill with `surface` text, the state a primary button reaches after its action ran (5.3, 5.4).
- **Disabled**: `muted` text; a disabled primary loses its fill for `sunken`.
- **Pressing** scales to `scale-press` within `dur-press` (rule 2: feedback within 100 ms). It commits on release.
- **Focus** shows a 2px `accent` outline 2px away, on every ground.
- **From the keyboard**, Enter and Space act only with focus on the button; nothing opened from the keyboard animates its way in (4.1).
- **Prefer an icon** where it is clear (IconButton); keep words for decisions, such as Confirm and Deny this call.
- On a phone, targets are at least 44px and primary actions sit in the bottom third (5.15).
- **Reduced motion** keeps the press feedback as a color change only.
