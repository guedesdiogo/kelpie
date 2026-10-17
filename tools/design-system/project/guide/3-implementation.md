# Implementation notes

- **CSS first.** Tokens are custom properties. Springs are the `linear()` values above, supported in every current browser. Enter and exit use transitions with `@starting-style`. Choreographed sequences use the Web Animations API, which takes the same easings.
- **View Transitions** fit navigation between views. They never wrap a list that streams.
- **The Motion library** fits only where the owner drags something with velocity, such as reordering the board. It is loaded with the page that needs it.
- **An entrance plays once.** It is keyed to the element, so a streaming update never replays it. It never leaves content at opacity 0 if the animation doesn't run, which happens when a background tab pauses timelines. A list animates entries only up to 60 rows; past that, rows appear at once.
- **Heavy effects stay off the DOM's per-frame path.** No pattern uses an SVG filter now; a filter, a blur or anything heavier belongs in a shader scoped to its element, or nowhere. Full-screen WebGL stays out of the product.
- **The mascot engine is the one continuous loop.** A new surface that shows an agent reuses it (5.19): one shared timer, observers that stop figures out of view, and the plush painted once per size. Nothing draws an agent another way.
- **The stack is still open.** These choices guide whatever UI stack Kelpie picks; the [viability study](https://github.com/guedesdiogo/kelpie/blob/main/docs/viability-study.md) lists it among its open questions.
