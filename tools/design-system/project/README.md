Kelpie is a self-hosted team of AI agents. Its interface follows one visual identity and one motion system, called **Mistura** ("mix"): the identity of the water spirit (kelp colors, shapes that change) with the discipline of the herding dog (fast, grouped, no bounce). What the owner does a hundred times a day moves quickly and plainly. The moments that matter (approving, spending, delegating, remembering) get the expressive motion. Each agent is one of those changing shapes: a plush drop of water that stays alive in its place (see Mascot).

Take every color, size, radius, duration and easing from a token. A literal number is allowed only where a pattern sets it. The source of truth is [`docs/design-system.md`](https://github.com/guedesdiogo/kelpie/blob/main/docs/design-system.md), decided in [ADR-0043](https://github.com/guedesdiogo/kelpie/blob/main/docs/adr/0043-design-system.md) and extended by [ADR-0044](https://github.com/guedesdiogo/kelpie/blob/main/docs/adr/0044-design-system-review.md), [ADR-0045](https://github.com/guedesdiogo/kelpie/blob/main/docs/adr/0045-agent-mascot.md), [ADR-0046](https://github.com/guedesdiogo/kelpie/blob/main/docs/adr/0046-telegram-bot-photo.md), [ADR-0047](https://github.com/guedesdiogo/kelpie/blob/main/docs/adr/0047-mascot-offline.md), [ADR-0049](https://github.com/guedesdiogo/kelpie/blob/main/docs/adr/0049-logo-main-mascot-silhouette.md), [ADR-0051](https://github.com/guedesdiogo/kelpie/blob/main/docs/adr/0051-subagent-pups-return-one-by-one.md), [ADR-0053](https://github.com/guedesdiogo/kelpie/blob/main/docs/adr/0053-pups-in-the-conversation-header.md) and [ADR-0056](https://github.com/guedesdiogo/kelpie/blob/main/docs/adr/0056-agent-editor-and-random-mascot.md). Each component card names its pattern number there (5.1 to 5.26). Where the webchat's redesign (#378, shipped with #412) decided a component's look, `docs/design-system.md` carries the decision, and the card follows it and says so.

## Voice

Write the way a capable colleague talks.

- **Say what happened, then what to do.** "No connection. Trying again in 8 s." Not "Oops! Something went wrong."
- **Name things by what the owner knows.** A routine, a task, the vault. Never a table, a Durable Object or a queue.
- **No apologies, no exclamation marks, no whimsical verbs.** A phase says what is being done: "Reading people/ana-souza.md".
- **Empty states explain in one sentence why they are empty,** and offer the one action that fills them: "No agents yet, so nothing can answer you. Create one to start."
- **Receipts say who did what and when,** in the owner's time zone: "You confirmed at 14:32", "You denied at 14:32. `agenda` goes on without it."
- **Name an agent by its id** where it asks for something (`agenda` asks, on task #123), and by its name in the header and the roster.
- **The mascot carries no words.** Its bubbles hold a glyph (`?`, `!`, `…`, a struck-through plug); what the agent says goes in the conversation.
- **No emoji** in the interface. Fixed texts ship in English, Brazilian Portuguese and Spanish (ADR-0027).

## Color

Four themes: Light and Dark follow the operating system unless the owner picks one; the two more-contrast themes apply with `prefers-contrast: more` or Kelpie's own contrast setting.

- Set the page on `bg`, panels and cards on `surface`, wells and the agent's bubbles on `sunken`.
- Set text in `fg`, secondary text in `muted`.
- Use `accent` for primary actions, the owner's bubbles, focus, links and progress. Text on it is `on-accent`.
- Use `warm` only where the owner must act: an agent waiting, a free tier past 90%. Nothing else is amber, and no mascot color is.
- Use `ok` for done, approved and turned on; text on an `ok` fill is `surface`, so it inverts with the theme.
- Use `danger` for errors and refusals that need action; text on a `danger` or `warm` fill is `on-accent`.
- **Draw a control's boundary in `muted`.** `line` is decorative (1.49 on `surface`); inputs, checkboxes, the hold button and secondary buttons need 3:1.
- **Text on a tint is `fg`.** Make tints with `color-mix()` from a token, never a new literal: a focus halo is `accent` at 18%, a hold fill `accent` at 28%, a card that just landed `accent` at 22%, a text highlight `accent` at 24%, a receipt icon well `ok` at 16%, a scrim `fg` at 16%. `components/bundle.css` declares them as `--focus-halo`, `--hold-fill`, `--landed`, `--highlight`, `--receipt-well` and `--scrim`.
- **Shadows** are black at low alpha in every theme: `shadow` for cards, `shadow-pop` for palettes, menus and a lifted card.
- **Never set text** in `accent`, `ok` or `danger` on `sunken`, or in `ok` on `bg`, in the light themes: those four pairs miss AA. There, the text is `fg`, and the color moves to an underline or an icon (icons need 3:1, which all four pass).
- **A state never rides on color alone.** The glyphs of Presence carry it in forced colors and higher contrast; in `forced-colors` the system's colors replace the tokens. With `prefers-reduced-transparency: reduce`, scrims and tints become solid fills.

Measured contrast (WCAG 2), light / dark:

| Pair | Light | Dark |
|---|---|---|
| `fg` on `bg` / `surface` / `sunken` | 13.67 / 15.33 / 12.48 | 14.99 / 13.70 / 14.51 |
| `muted` on `bg` / `surface` / `sunken` | 5.27 / 5.90 / 4.81 | 6.89 / 6.30 / 6.67 |
| `on-accent` on `accent` | 5.31 | 7.83 |
| `accent` on `bg` / `surface` / `sunken` | 4.80 / 5.38 / 4.38 | 8.51 / 7.78 / 8.23 |
| `warm` on `bg` / `surface` / `sunken` | 5.00 / 5.60 / 4.56 | 9.56 / 8.74 / 9.25 |
| `ok` on `bg` / `surface` / `sunken` | 4.44 / 4.98 / 4.06 | 8.60 / 7.86 / 8.33 |
| `surface` on `ok` | 4.98 | 7.86 |
| `danger` on `bg` / `surface` / `sunken` | 4.79 / 5.37 / 4.38 | 6.53 / 5.97 / 6.32 |
| `on-accent` on `warm` / `danger` (the mascot's `?` and `!`) | 5.53 / 5.30 | 8.80 / 6.01 |

In the more-contrast themes only `line` and `muted` change: every boundary reaches 3:1 (3.11 to 3.82) and secondary text 7:1 (7.25 to 9.45). `accent`, `warm`, `ok` and `danger` keep their AA values.

## Type

- **Display** is Bricolage Grotesque at 680, tracking −0.03em, `text-wrap: balance`: headings, agent names in large sizes, the brand. Styles `text-h1`, `text-h2`, `text-h3`.
- **Body** is Geist at 400, 500 and 600, for all running text and UI. Styles `text-lg` (ledes), `text-base` (body), `text-ui` (bubbles, cards, buttons, lists), `text-sm` (meta, captions, tool rows).
- **Mono** is Geist Mono at 400 and 500, only for code, file paths, keys, times and counts. `text-xs` is the uppercase eyebrow with 0.08em tracking; the webchat uses no uppercase labels (#378): its labels are sentence case, in Geist.
- Use only the weights listed, with `font-synthesis-weight: none`. Each family keeps a system fallback stack.
- Set digits that change or line up (timers, counts, prices, times) with `font-variant-numeric: tabular-nums`. Keep running text near 65 characters a line.
- `text-h1` and `text-h2` are fluid in code: `clamp(46px, 7.4vw, 88px)` and `clamp(28px, 3.6vw, 42px)`. Inputs on a phone use `input-phone` (16px), so the page doesn't zoom on focus.
- The fonts are self-hosted variable files from Fontsource 5.3.0 under the SIL Open Font License; no page loads fonts from another origin.

## Space, radius and layering

- Space on the 4px grid: `space-1` (4px) to `space-16` (64px). Lay out groups with `gap`, not with margins on their children. Keep a side gutter of at least `space-4`.
- Round buttons and inputs with `r-btn`, bubbles and tool rows with `r-bubble`, cards, dialogs and the palette with `r-card`, large panels with `r-panel`, chips, pills and toasts with `r-chip`, keys and inline code with `r-sm`.
- **Nested corners shrink with depth:** an element inside a card uses the card's radius minus its padding, never less than 5px.
- **The phone (5.15):** the composer stays above the keyboard, following `visualViewport`, with safe-area padding. Sheets rise with `spring-slow`, stop at 40% and 90% of the height, follow the finger and close on a flick; dragging starts only when the sheet's content is at its top. Targets are at least 44px, primary actions sit in the bottom third, and a hold button's label stays visible above the finger. Under reduced motion, sheets fade in place.

## Motion

Motion depends on how often an interaction happens, not on which screen it is in. The full rules are in the Motion section.

- **Frequent** (messages, streaming, tool rows, the board, lists, menus, the palette, navigation): `spring-fast`, `spring-base`, `spring-slow`, `rise`, `scale-in`, `stagger`, `dur-exit`. Fast, no visible overshoot.
- **Moment** (confirming, turning on something that costs, delegating, saving to memory, presence changes): `spring-moment-fast`, `spring-moment`, `spring-moment-slow`, `spring-pop`, `rise-moment`, `scale-in-moment`, `stagger-moment`, `dur-exit-moment`. Springs that pass their target a little, and a signature: a parent's pups, the ring of a confirmation, the arc into the vault, a mascot's announcement.
- **Springs move things; curves change color.** Position and size use the `spring-*` easings over their `spring-*-dur`; color and opacity use `ease-fade` over `dur-fade` and never overshoot.
- **From the keyboard,** anything opened, moved or navigated appears at once; progress and results still show.
- **Leaving is faster than arriving:** exits use `dur-exit` or `dur-exit-moment` with `ease-exit`.
- **Loops stop within 5 s,** apart from the mascot's life in place.
- **Reduced motion replaces, it doesn't erase:** movement and scale become opacity in at most `dur-fade`; colors, focus, confirmations and progress stay; mascots go Still.
- Animate only `transform`, `opacity` and color in anything that runs daily, apart from the contained sizes some patterns name. Never write `transition: all`.
- **Sound** is opt-in and off by default: three sounds under 300 ms (confirmed, saved to memory, an agent needs you). No vibration. The mascot makes no sound.

## Logo

- The logo is Master's mascot as a silhouette, in `accent` (Logo card, 5.23). Use it only as the brand, never in place of an agent's mascot, and never in `warm`. On anything but `bg`, `surface` and `sunken`, set the mark in `on-accent` on an `accent` tile.

## Iconography

- **Icons** are the webchat's own 16px stroke glyphs (`assets/Icons/`): clock (held and queued), alert (a refusal or a failure), check, neutral (a neutral receipt), chevron, close and display; and, from the webchat's approved mockup (#378), pause and send (the composer), monitor, sun and moon (the theme), no Wi-Fi (a lost connection) and bell (what waits for the owner). The comfort controls add text-small and text-large, less-motion and contrast (a square split on its diagonal, never the working glyph's half-filled circle), from the §8 research; the owner approved the text-size pair on 2026-10-16, and #378 left it to a follow-up, since the webchat has no type-scale switch yet. The Sidebar and the AgentEditor (5.24 to 5.26) add chevron-up (the account), pencil (edit an agent), undo (a U-turn, since a circle reads as refresh), dice (randomize: three pips, since a shuffle means reorder) and lock (a read-only field), and the editor's sections: profile (an ID card), mascot-body (the mascot's outline at rest), soul (a page with a heart), rules (a list), memory (two stacked notes) and skills (a puzzle piece). None is a lone diamond, a triangle, or a hollow or dashed circle: those are the state glyphs. The mascot's pause draws the mascot's own outline at 20px: mid-hop for Alive, with a badge for States only, on a line for Still. Draw them inline with a 1.5px stroke in `currentColor`, round caps and joins, `aria-hidden`: the text beside an icon carries the meaning, so color never does alone. The SVG files in the assets are inked in `fg` (`#0C2523`) for previews; in code, draw the paths with `currentColor`.
- **State glyphs** (Presence): a half-filled circle for working, a diamond for waiting, a hollow circle for idle, a triangle for an error, a dashed circle for no response, a struck-through circle for no connection. Draw them as SVG; Geist has no such characters.
- **Prefer an icon to a word** where the icon is clear, as the theme and the composer do: every icon button names itself in a tooltip and to screen readers (IconButton card, 5.26). On touch, an icon is never the only label, with one exception the owner approved on 2026-10-16: the composer's Pause, whose paused line names the state.
- **Agents are their mascots,** at a size from the Mascot card, never a photo, an initial or a generic icon.
- **No emoji.** Arrows in labels are text (`↓ 3 new`, `↗` after a link's host).

## Accessibility

- **Focus** is a solid 2px `accent` outline 2px away, at least 3:1 on every ground in every theme.
- **The keyboard** reaches everything: Enter or Space act only with focus on a control; a key held down when a card appeared doesn't count; Escape closes what opened.
- **Live regions:** a polite region announces each new reply once, each receipt and each toast; an error toast uses `role="alert"`. A replayed history is never announced.
- **The pause:** the mascot's motion is Alive, States only or Still (WCAG 2.2.2), and reduced motion means Still.
- **Elapsed times** update once a second, or once a minute under the less-motion switch.

## Not synced

- The `latin-ext` font files are not in `fonts/`: they need `unicode-range`, which `tokens.json` can't carry. Pages with extended letters load them from the webchat (`apps/ingress/public/webchat/fonts/`).
- The tints are `color-mix()` values, which `tokens.json` can't hold; they are declared in `components/bundle.css`.
- The webchat is plain JavaScript with no component library, so the component cards are hand-written from the patterns in `docs/design-system.md` and the webchat's `style.css`. The mascot is not: `components/bundle.js` carries the webchat's own engine, `apps/ingress/public/webchat/mascot*.js` at `main@59907ec`, as `window.Kelpie.mascot`, built from `main` alone. It has carried the Offline state of ADR-0047 since #412, and the AgentEditor's `restyle` since #414.
