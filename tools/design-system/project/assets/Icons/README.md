# Icons

The webchat's seven glyphs, from `apps/ingress/public/webchat/icons.js`: 16px, a 1.5px stroke, round caps and joins. These files are inked in `fg` (#0C2523) so they show in an `<img>`; in code, draw the same paths with `currentColor` and `aria-hidden`, since the text beside an icon carries its meaning.

- `clock`: a message held during the wait (PacedReply) or queued while offline (ConnectionBanner).
- `alert`: a refusal or a failure, in `danger`.
- `check`: done, in `ok`; it draws in 280 ms after a confirmation.
- `neutral`: a neutral receipt (denied, expired), in `muted`.
- `chevron`: a switcher or a summary that opens.
- `close`: dismiss.
- `display`: the Display menu.

From the webchat's approved mockup (#378):
- `pause` and `send`: the composer's round buttons; Send sits on `accent` in `on-accent`.
- `monitor`, `sun` and `moon`: the theme's System, Light and Dark.
- `wifi-off`: the banner of a lost connection.
- `bell`: the strip that counts the agents waiting for the owner, in `warm`.
- `mascot-alive`, `mascot-states` and `mascot-still`: the mascot's pause, drawn as the main mascot's outline (round ears) on a 20px grid with a 1.4px stroke.

From the §8 research on the comfort controls (the owner approved the text-size pair on 2026-10-16):
- `text-small` and `text-large`: outlined letters for the text size, as Lucide's `a-large-small`.
- `less-motion`: a circle with one trail, after Material's `motion_blur`.
- `contrast`: a rounded square split on its diagonal, after Material's `contrast_square`; never the half-filled circle, which is the working glyph.

From the Sidebar and the agent's editor (5.24 to 5.26, #412 and #414), in `icons.js`:
- `chevron-up`: the account at the Sidebar's foot, whose menu opens upward.
- `pencil`: the badge on a mascot that opens its editor.
- `undo`: a U-turn arrow, never a circle, which reads as refresh.
- `dice`: Randomize, a die with three pips; a shuffle would mean reorder.
- `lock`: a read-only field, such as Master's specialty.
- `profile`, `mascot-body`, `soul`, `rules`, `memory` and `skills`: the editor's sections, an ID card, the mascot's outline at rest (a 20px grid, as the mascot's pause), a page with a heart, a list, two stacked notes and a puzzle piece. None is a lone diamond, a triangle, or a hollow or dashed circle: those are the glyphs of Presence.
