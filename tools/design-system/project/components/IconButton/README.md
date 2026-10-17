# IconButton

An icon stands in for a word only where the owner knows the action, and it always says its name, in a tooltip and to screen readers (5.26, frequent grammar; #378, from the owner: «Use mais icones do que texto [...] todos podem ter hover para mostrar o texto»).

- **Three sizes:**
  - **Bordered** (`k-icb`): 34px square, a 1px `muted` boundary, `r-btn`, a 16px icon in `fg`, `sunken` on hover. For actions that stand on their own: Undo, Randomize all. Close, in a panel's head, drops the boundary.
  - **Quiet** (`k-icb quiet`): 28px, no boundary, the icon in `muted`, `sunken` on hover. For a small one inside a header or a row: "Randomize shape".
  - **Round** (Composer): 26px circles inside the composer, Send in `accent` and Pause with a `muted` ring.
  - On the phone, each is 44px.
- **A disabled one stays focusable,** `aria-disabled`, and its tooltip says why: "Nothing to undo", "Write a message to send".
- **The icons** are the webchat's `icons.js`: 16px, a 1.5px stroke in `currentColor`, round caps and joins, `aria-hidden` (see Iconography). Undo is a U-turn arrow, since a circle reads as refresh; Randomize is a die with three pips, since a shuffle means reorder. The AgentEditor's sections are an ID card, the mascot's own outline, a page with a heart, a list, two stacked notes and a puzzle piece. None is a lone diamond, a triangle, or a hollow or dashed circle: those are the glyphs of Presence.
- **Its name** is its `aria-label`, and its tooltip shows the same words, verb first ("Randomize all", "Pause this conversation"), or why it waits. Nothing uses `title` (WCAG 1.4.13).
- **The tooltip's timing:**
  - the first waits 400 ms, then rises from 4px and 0.97 with `spring-fast`;
  - another within 300 ms of one hiding shows at once, with no animation;
  - keyboard focus shows one at once, a click's focus none, and Escape hides it without moving focus;
  - it has no timer, the pointer can move onto it, and it leaves in `dur-exit`.
- **The tooltip** is a `fg` chip with `bg` text, `r-sm`, 6px above its button. Near a top edge, it opens below.
- **On touch,** an icon is never the only label: a row or a menu keeps its words there. The one exception, approved by the owner on 2026-10-16, is the composer's Pause, whose paused line names the state.
- **Pressing** scales to `scale-press` within `dur-press`; it commits on release.
- **Research (§8),** read on 2026-10-16, with the findings on #379: adopt Emil Kowalski's tooltip rules, Radix's, Primer's and Geist's delays, and the HIG on help and undo; avoid icons that replace labels the owner hasn't learned, against Linear's 2026 refresh.
- **The consumer provides** the icon, the label and the action.
- **Reduced motion:** tooltips appear and leave with a fade; the press has no scale.
