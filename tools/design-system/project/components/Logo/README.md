# Logo

Kelpie's logo is Master's mascot as a flat silhouette: the `mark` shape with its round ears, in one color, with no face, fur, accessory or shadow; it names the product and never moves (5.23, ADR-0049).

- **The files** come from `scripts/brand-icons.mjs` and live in `docs/brand/`; the Logos assets here are copies: `kelpie-mark.svg`, `kelpie-lockup-light.svg` and `kelpie-lockup-dark.svg`, the 16 px favicon master `favicon-16.svg`, and the home-screen sources `app-icon.svg`, `app-icon-rounded.svg` and `app-icon-maskable.svg`.
- **The mark** comes from the engine's 120 grid: the shape at 24..96 × 36..108 with corners 36, 36, 36 and 11.5, and the ears, circles of 10.5 at (38, 42) and (82, 42). If the main mascot's default changes, the mark changes with it, through a new ADR.
- **The lockup** sets the mark beside "Kelpie" in Bricolage Grotesque 680, tracking −0.03em: the mark is 1.3 cap heights tall, centered on the cap band, and its right edge sits half a cap from the K's stem. The webchat's sidebar sets the word at 17 px. Nothing comes within half a cap of the lockup, or a quarter of the mark's height of the mark alone.
- **Color:** the mark and the word are `accent`. On `bg`, `surface` and `sunken` they measure 4.80, 5.38 and 4.38 in light, and 8.51, 7.78 and 8.23 in dark; the logo that links home keeps 3:1, which every pair passes. On anything else (a photo, another color), the mark goes in `on-accent` on an `accent` tile. It is never `warm`.
- **Small sizes have their own drawings:** at 32 px and below, the favicon's masters put the body on whole pixels and the ears a little larger.
- **The favicon is an opaque tile:** `accent`, radius 22% of its side, with the mark in `on-accent` (5.31:1 in light, 7.83:1 in dark). Safari ignores the dark block inside an SVG favicon, so the light tile is the one every browser can show.
- **It never stands in for an agent.** Every agent, the main one included, shows its own mascot. The logo carries no state, badge or glyph; the amber dot of Presence belongs to the tab's favicon, not to the logo.
- **Reduced motion:** nothing changes; it doesn't move.
