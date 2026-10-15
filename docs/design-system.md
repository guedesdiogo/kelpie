# Design system

Kelpie's interface follows one visual identity and one motion system, decided in [ADR-0043](adr/0043-design-system.md). This document holds the values. A page, component or animation takes its colors, type, spacing, radii and motion from the tokens below and never from literal values.

The direction is called **Mistura** ("mix"): the identity of the water spirit (kelp colors, shapes that change) with the discipline of the herding dog (fast, grouped, no bounce). What the owner does a hundred times a day moves quickly and plainly. The moments that matter (approving, spending, delegating, remembering) get the expressive motion.

A live reference with every interaction below runs in the owner's motion lab (a private page). This document is the source of truth when the two differ.

## 1. Color

Every color is a token with a light and a dark value. The theme follows the operating system unless the owner picks one.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#E7EEEC` | `#091514` | Page background |
| `--surface` | `#F7FAF9` | `#0F1F1E` | Panels, cards, the chat window |
| `--sunken` | `#DAE5E2` | `#0B1918` | Wells, agent bubbles, tracks, hover |
| `--fg` | `#0C2523` | `#DBEAE6` | Text |
| `--muted` | `#4C6663` | `#88A39E` | Secondary text, meta, idle icons |
| `--line` | `#C2D2CE` | `#21403B` | Borders and dividers (decorative, never the only boundary of a control) |
| `--accent` | `#0A7469` | `#3BC3AE` | Kelp: primary actions, the owner's bubbles, focus, links, progress |
| `--on-accent` | `#F0FAF8` | `#03201B` | Text and icons on `--accent` |
| `--warm` | `#915708` | `#EEAE4A` | Attention: an agent is waiting for the owner. Nothing else uses it |
| `--ok` | `#1B7C45` | `#55C585` | Done, approved, turned on |
| `--danger` | `#BA3A27` | `#F07461` | Errors, refusals that need action |

- **Text on `--ok`** uses `--surface`, so it inverts with the theme.
- **Tints** come from `color-mix()` with a token, never from a new literal: a focus halo is `--accent` at 18%, a hold-to-confirm fill `--accent` at 28%, a text highlight `--accent` at 24%, a receipt icon well `--ok` at 16%, a scrim `--fg` at 16%.
- **Shadows** are black at low alpha in both themes: `--shadow` is `0 1px 2px rgb(0 0 0 / .06), 0 14px 30px -18px rgb(0 0 0 / .38)`, and `--shadow-pop` (palettes, menus) is `0 18px 40px -16px rgb(0 0 0 / .5)`.

### Measured contrast

WCAG 2 contrast ratios, measured on 2026-10-15 from the hex values above. AA asks 4.5 for text and 3 for large text and icons.

| Pair | Light | Dark |
|---|---|---|
| `--fg` on `--bg` / `--surface` / `--sunken` | 13.67 / 15.33 / 12.48 | 14.99 / 13.70 / 14.51 |
| `--muted` on `--bg` / `--surface` / `--sunken` | 5.27 / 5.90 / 4.81 | 6.89 / 6.30 / 6.67 |
| `--on-accent` on `--accent` | 5.31 | 7.83 |
| `--accent` on `--bg` / `--surface` / `--sunken` (links) | 4.80 / 5.38 / 4.38 | 8.51 / 7.78 / 8.23 |
| `--warm` on `--bg` / `--surface` / `--sunken` | 5.00 / 5.60 / 4.56 | 9.56 / 8.74 / 9.25 |
| `--ok` on `--surface`, and `--surface` on `--ok` | 4.98 | 7.86 |
| `--danger` on `--surface` | 5.37 | 5.97 |

`--accent` as text stays off `--sunken`: 4.38 in light misses AA. On `--sunken`, links and accent text use `--fg` with an underline.

`--line` on `--surface` is 1.49 in light and 1.51 in dark. That is why a border never carries meaning alone: an input also has its fill or label, and a selected item also changes its fill.

## 2. Type

| Role | Family | Weights | Notes |
|---|---|---|---|
| Display | Bricolage Grotesque | 680 | Headings, agent names in large sizes, the brand. Tracking `-0.03em`, `text-wrap: balance`. |
| Body | Geist | 400, 500, 600 | All running text and UI. |
| Mono | Geist Mono | 400, 500 | Code, file paths, keys, times, counts and eyebrows. |

Only the weights listed are loaded, with `font-synthesis-weight: none`. All three are under the SIL Open Font License, and they are self-hosted: the webchat's content policy is `default-src 'self'` (#140), and no page loads fonts from another origin. Each `font-family` keeps a system fallback stack.

| Token | Size | Line height | Use |
|---|---|---|---|
| `--text-xs` | 11.5px | 1.4 | Eyebrows (mono, uppercase, tracking `.08em`), badges |
| `--text-sm` | 12.5px | 1.4 | Meta, captions, tool rows, card details |
| `--text-ui` | 13.5px | 1.45 | Dense UI: bubbles, cards, buttons, lists |
| `--text-base` | 15px | 1.55 | Body text |
| `--text-lg` | 17.5px | 1.55 | Lede paragraphs |
| `--text-h3` | 22px | 1.05 | Section and card titles |
| `--text-h2` | `clamp(28px, 3.6vw, 42px)` | 1.05 | Page sections |
| `--text-h1` | `clamp(46px, 7.4vw, 88px)` | 0.94 | Page titles |

Digits that change or line up (timers, counts, prices, times) use `font-variant-numeric: tabular-nums`. Running text stays near 65 characters per line.

## 3. Space, radius and layering

**Spacing** runs on a 4px grid: `--space-1` 4px, `-2` 8px, `-3` 12px, `-4` 16px, `-5` 20px, `-6` 24px, `-8` 32px, `-10` 40px, `-12` 48px, `-16` 64px. Groups lay out with `gap`, not with margins on their children. A page keeps a side gutter of at least 16px.

| Token | Value | Use |
|---|---|---|
| `--r-sm` | 6px | Keys, inline code, small wells |
| `--r-btn` | 10px | Buttons, inputs, segmented controls |
| `--r-bubble` | 14px | Chat bubbles, tool rows |
| `--r-card` | 14px | Cards, dialogs, the palette |
| `--r-panel` | 16px | Large panels and the chat window |
| `--r-chip` | 999px | Chips, badges, status pills, toasts |

Nested corners shrink with depth: an element inside a card uses the card's radius minus its padding, never less than 5px.

## 4. Motion

### 4.1 Two grammars

Motion depends on how often an interaction happens, not on which screen it is in.

| Grammar | Applies to | Character |
|---|---|---|
| **Frequent** | Messages, streaming, tool rows, the task board, lists, menus, the palette, navigation | Fast, no overshoot, small distances, tight stagger |
| **Moment** | Approving, turning on something that costs, delegating to subagents, saving to memory, agent presence changes | Springs that pass their target a little, larger distances, one signature effect each |

Anything triggered from the keyboard does not animate in either grammar.

### 4.2 Springs

A spring is given as stiffness and damping ratio, at mass 1. The Motion library takes the damping coefficient `c = 2 · ratio · √stiffness`. In CSS, a spring is a `linear()` easing over its settle time (the time it takes to stay within 0.1% of its target), sampled at 21 points.

| Token | Stiffness / ratio | Motion `damping` | Settles | Overshoot | Use |
|---|---|---|---|---|---|
| `--spring-fast` | 1400 / 0.9 | 67.3 | 194 ms | 0.1% | Chips, labels that roll, the palette, highlights |
| `--spring-base` | 700 / 0.9 | 47.6 | 266 ms | 0.1% | Bubbles, cards, lists, panels |
| `--spring-slow` | 300 / 0.9 | 31.2 | 394 ms | 0.1% | Large surfaces, drawers |
| `--spring-moment-fast` | 800 / 0.6 | 33.9 | 393 ms | 9.2% | A released hold, small moment feedback |
| `--spring-moment` | 380 / 0.8 | 31.2 | 457 ms | 1.4% | Moment layout: a button that grows, a card that collapses |
| `--spring-moment-slow` | 200 / 0.8 | 22.6 | 611 ms | 1.4% | Travel: subagents leaving their parent, links drawing |
| `--spring-pop` | 800 / 0.55 | 31.1 | 471 ms | 12.3% | Confirmations: a check, a vault that receives, an avatar that changes state |

```css
:root {
  --spring-fast: linear(0, 0.063, 0.176, 0.323, 0.466, 0.58, 0.687, 0.773, 0.839, 0.884, 0.921, 0.948, 0.965, 0.978, 0.987, 0.993, 0.996, 0.998, 1, 1, 1);
  --spring-fast-dur: 194ms;
  --spring-base: linear(0, 0.052, 0.174, 0.309, 0.441, 0.561, 0.671, 0.754, 0.82, 0.874, 0.912, 0.939, 0.961, 0.975, 0.984, 0.991, 0.995, 0.998, 1, 1, 1);
  --spring-base-dur: 266ms;
  --spring-slow: linear(0, 0.052, 0.157, 0.291, 0.426, 0.543, 0.649, 0.737, 0.807, 0.859, 0.901, 0.932, 0.954, 0.97, 0.981, 0.989, 0.994, 0.997, 0.999, 1, 1);
  --spring-slow-dur: 394ms;
  --spring-moment-fast: linear(0, 0.133, 0.384, 0.656, 0.872, 1.004, 1.074, 1.092, 1.081, 1.057, 1.033, 1.013, 1, 0.993, 0.992, 0.993, 0.995, 0.997, 0.999, 1, 1);
  --spring-moment-fast-dur: 393ms;
  --spring-moment: linear(0, 0.083, 0.254, 0.443, 0.606, 0.745, 0.849, 0.92, 0.966, 0.993, 1.007, 1.013, 1.014, 1.012, 1.01, 1.007, 1.005, 1.003, 1.002, 1.001, 1);
  --spring-moment-dur: 457ms;
  --spring-moment-slow: linear(0, 0.079, 0.238, 0.423, 0.588, 0.728, 0.832, 0.907, 0.956, 0.987, 1.004, 1.012, 1.014, 1.013, 1.011, 1.009, 1.006, 1.004, 1.003, 1.001, 1);
  --spring-moment-slow-dur: 611ms;
  --spring-pop: linear(0, 0.184, 0.513, 0.827, 1.023, 1.112, 1.12, 1.086, 1.045, 1.011, 0.992, 0.985, 0.987, 0.991, 0.996, 1, 1.002, 1.002, 1.001, 1.001, 1);
  --spring-pop-dur: 471ms;
}
```

A spring's numbers come from simulating it, not from guessing: changing one means re-running the simulation and updating its row, its `linear()` and its duration together.

### 4.3 Durations, curves and distances

| Token | Value | Use |
|---|---|---|
| `--dur-press` | 100ms | Press feedback (`scale: var(--scale-press)`) |
| `--dur-fade` | 150ms | Opacity and color changes; every animation under reduced motion |
| `--dur-word` | 110ms | A streamed word fading in |
| `--dur-exit` | 120ms | Leaving, frequent grammar |
| `--dur-exit-moment` | 170ms | Leaving, moment grammar |
| `--dur-travel` | 720ms | Something that crosses the screen to where it is kept (a note into the vault) |
| `--dur-hold` | 1200ms | Hold-to-confirm |
| `--ease-standard` | `cubic-bezier(.2, 0, 0, 1)` | Non-spring movement |
| `--ease-fade` | `cubic-bezier(0, 0, .2, 1)` | Opacity and color |
| `--ease-exit` | `cubic-bezier(.4, 0, 1, 1)` | Exits |
| `--ease-travel` | `cubic-bezier(.55, 0, .25, 1)` | Travel |
| `--stagger` / `--stagger-moment` | 30ms / 60ms | Delay between siblings entering |
| `--rise` / `--rise-moment` | 8px / 18px | Distance an element rises as it enters |
| `--scale-in` / `--scale-in-moment` | 0.97 / 0.92 | Scale an element enters from; never from 0 |
| `--scale-press` | 0.97 | Pressed controls |

### 4.4 Rules

1. **Frequency decides.** What happens more than a hundred times a day (the palette, shortcuts, arrow keys, filtering) does not animate. Tens of times a day: at most 160 ms. Occasional: 200 to 300 ms. Rare: the moment grammar.
2. **Respond before animating.** Feedback within 100 ms. A control highlights when pressed and commits when released.
3. **Springs move things; curves change color.** Position and size use springs. Color and opacity never overshoot.
4. **Everything can be interrupted.** A released hold goes back from where it is, at the speed it had. Nothing blocks input while it animates.
5. **Things come from where they start.** A popover grows from its trigger, a task comes out of its routine, a note leaves the sentence and enters the vault. A dialog stays centered.
6. **One element carries the states.** The same button goes from "Approve" to "Creating" to a receipt; the same bubble goes from typing to the reply. Nothing is swapped for a different element in another place.
7. **Streaming is calm.** Only new words appear, with opacity alone, in `--dur-word`. Nothing animates layout per token, and the word wrappers are removed when the stream ends. Phases have their real names, the elapsed time appears after 3 s, and progress is never faked.
8. **Motion announces a change; a state stays still.** A loop stops within 5 s (WCAG 2.2.2), and from then on a state shows through color, shape and text: an elapsed time shows that an agent is still working. A spinner appears only after 150 to 300 ms of waiting and stays at least 300 ms.
9. **Leaving is faster than arriving.** Entries use springs; exits use `--dur-exit` or `--dur-exit-moment` with `--ease-exit`.
10. **Reduced motion replaces, it doesn't erase.** With `prefers-reduced-motion: reduce`, movement and scale become opacity in at most `--dur-fade`; colors, focus, confirmations and progress stay. Loops are static. The interface offers the same switch for people who want less motion without changing their system.

Two engineering rules come with them: animate only `transform`, `opacity` and color in anything that runs daily (a small, contained `width` or `height` is the exception, as in 5.3), and never write `transition: all`.

## 5. Patterns

Each pattern names its grammar and its numbers. "Exit" means the grammar's exit duration and curve.

### 5.1 Paced replies

Frequent. Kelpie waits `quietMs` after the owner's latest message before answering ([ADR-0024](adr/0024-fixed-wait-end-of-turn.md)).

- Each message the owner sends enters from below the composer (`--rise`, `--scale-in`, `--spring-base`, origin at the bottom right), and the bubbles above slide up with it (FLIP, `--spring-base`).
- A 3px bar under the thread shows the wait: it drains linearly over `quietMs`, and a new message refills it in the first 7% of the time.
- When the wait ends, a typing bubble appears; its dots blink in steps, 0.8 s per cycle.
- The reply takes the typing bubble's place in the same element: its width and height go to the reply's size (`--spring-base`), and the text fades in after 70 ms.

### 5.2 Tool calls and streaming

Frequent.

- A tool row appears when a call starts, with the call's real name. Each new action replaces the label above it: the old label leaves upward (exit, 75% of its height), and the new one rises with `--spring-fast`.
- Done, the row becomes a one-line summary ("3 steps · 2.6 s") with a check. A click opens it: height with `--spring-base`, rows entering with `--stagger`.
- Streamed text follows rule 7.

### 5.3 Approve an action

Moment. The owner's press is the yes ([ADR-0026](adr/0026-confirmation-by-owner-act.md)).

- The pressed button scales to `--scale-press`. The other button leaves (exit, scale 0.92), and the chosen one grows into the row: width and position with `--spring-moment`.
- Its label rolls to a spinner and what is happening ("Creating the event").
- On success, its fill turns `--ok` (`--dur-fade`), the check draws in 280 ms, the button pops (`scale` 1.03 to 1, `--spring-pop`), and a ring leaves its edge (650 ms, opacity 0.7 to 0, scale 1 to 1.5).
- The card then collapses into a receipt: its content fades (exit), its height goes to the receipt's (`--spring-moment`), and the receipt rises 4px. The receipt says who decided and when, in the owner's time zone, and a polite live region announces it.
- A key that was already held down when the request appeared doesn't approve or refuse it. Enter and Escape count only when pressed after the card is shown.

### 5.4 Turn on something that costs

Moment. A feature that costs beyond the Workers Paid plan turns on only at the owner's request (CLAUDE.md).

- The owner holds the button: a fill (`--accent` at 28%) grows from the left, linearly, over `--dur-hold`. Space and Enter hold it too.
- Released early, the fill goes back from where it is with `--spring-moment-fast`, and the label returns.
- Complete, the button turns `--ok`, pops, and rings as in 5.3.
- Typing the confirmation code in the chat ([ADR-0026](adr/0026-confirmation-by-owner-act.md)) stays as the alternative for anyone who can't hold.

### 5.5 A routine becomes a task

Frequent. Each fire of a routine creates a task ([ADR-0039](adr/0039-routines-as-vault-files.md)).

- The routine's chip pops (`scale` 1.05 to 1) and the new card leaves it: from the chip's position at scale 0.7 to its slot at the top of its column (FLIP, `--spring-base`). The cards below move down with it.
- Column counts roll like labels (5.2).
- When an agent takes the task, its avatar pops onto the card, and the card travels to the next column (FLIP). A progress bar fills only from real progress.
- Done, the check draws and the title turns `--muted`.

### 5.6 Subagents

Moment. Subagents are temporary and never exceed their creator ([ADR-0036](adr/0036-agent-roles-models-and-subagents.md)).

- The parent pulses (`scale` 0.9 to 1, `--spring-pop`).
- Each subagent leaves the parent as a drop, under an SVG "goo" filter (Gaussian blur 7, alpha matrix 20 / −9). It travels to its place with `--spring-moment-slow`, `--stagger-moment` apart.
- A link draws from the parent (stroke offset, `--spring-moment-slow`, 60 ms later), and the label enters from the left 140 ms later.
- When it is done, it travels back and fades into the parent; the link retracts, and the parent swallows it (`scale` 1.12 to 1, `--spring-pop`, at 55% of the return).
- Under reduced motion, subagents fade in and out at their places.

### 5.7 Saved to memory

Moment.

- The learned phrase gets a highlight that grows from its start (`--accent` at 24%, `--spring-moment`). It is not `--warm`: remembering asks nothing of the owner.
- A chip with the real file path, such as `people/ana-souza.md`, lifts from the phrase (`--rise`, scale 0.9). It travels in `--dur-travel` (`--ease-travel`) along an arc 60px above the straight line to the vault, shrinking to 0.35 and fading over the last 18%.
- The vault pops (`scale` 1.14 to 1, `--spring-pop`), its count rolls, and "Saved to `<path>`" stays for 2.6 s.

### 5.8 Command palette

Frequent, and the clearest case of rule 1.

- Opened by a click, it grows from its trigger: `scale` 0.97 and 6px above, to 1, with `--spring-fast`. The scrim fades in `--dur-fade`.
- Opened with ⌘K or Ctrl K, it appears at once. Arrow keys, filtering, Enter and Escape are instant too.
- Only the pointer animates: hovering moves the highlight with `--spring-fast`. A pointer that hasn't moved since the palette opened doesn't move the highlight.
- Closed by a click, it leaves in `--dur-exit`.

### 5.9 Agent presence

Moment grammar: the roster is where Kelpie spends its novelty.

| State | Shows | Motion |
|---|---|---|
| Working | `--accent` ring, elapsed time `m:ss` | The ring turns three times, 1.4 s each, then stops |
| Waiting for the owner | `--warm` ring, "waiting for you", time since | A halo pulses three times, 1.6 s each, then stops |
| Idle | Avatar at 45% opacity, grayscale | None |
| Error | `--danger` ring, what failed | One shake, 380 ms |

On a change, the avatar pops (`scale` 0.86 to 1, `--spring-pop`) and the status line rolls. The roster never reorders when a state changes: a list that jumps under the pointer costs a misclick. How the agent itself looks (avatar or mascot) is still open (ADR-0043 §5).

## 6. Implementation notes

- **CSS first.** Tokens are custom properties. Springs are the `linear()` values above, supported in every current browser. Enter and exit use transitions with `@starting-style`. Choreographed sequences use the Web Animations API, which takes the same easings.
- **View Transitions** fit navigation between views. They never wrap a list that streams.
- **The Motion library** fits only where the owner drags something with velocity, such as reordering the board. It is loaded with the page that needs it.
- **An entrance plays once.** It is keyed to the element, so a streaming update never replays it, and it never leaves content at opacity 0 if the animation doesn't run (a background tab pauses timelines). A list animates entries only up to 60 rows; past that, rows appear at once.
- **Heavy effects stay off the DOM's per-frame path.** The goo is one SVG filter on one layer. Anything heavier belongs in a shader or not at all.
- These choices guide whatever UI stack Kelpie picks; the stack itself is still open ([viability study](viability-study.md), open questions).

## 7. Review checklist

A pull request that changes the interface answers yes to each line:

- [ ] Every color, size, radius, duration and easing comes from a token.
- [ ] Only `transform`, `opacity` and color animate, apart from the contained cases in 5.1 and 5.3; no `transition: all`.
- [ ] Keyboard-triggered actions don't animate.
- [ ] Loops stop within 5 s, and the steady state reads without motion.
- [ ] Exits are faster than entries.
- [ ] Interrupting an animation leaves no element stuck halfway.
- [ ] Under reduced motion, every movement becomes a short fade, and no feedback disappears.
- [ ] New text meets the contrast in section 1, in both themes.

## 8. Sources

Research done on 2026-10-15. The rules above cite these:

- Award winners studied:
  - [Awwwards annual awards](https://www.awwwards.com/annual-awards/winners);
  - [CSS Design Awards, website of the year](https://www.cssdesignawards.com/woty-award-winners);
  - Apple Design Awards [2024](https://www.apple.com/newsroom/2024/06/apple-announces-winners-of-the-2024-apple-design-awards/), [2025](https://www.apple.com/newsroom/2025/06/apple-unveils-winners-and-finalists-of-the-2025-apple-design-awards/) and [2026](https://www.apple.com/newsroom/2026/06/apple-reveals-winners-of-the-2026-apple-design-awards/);
  - [the Dropbox Brand case study](https://www.awwwards.com/case-study-dropbox-brand-guidelines.html).
- Motion craft:
  - [Apple, Designing Fluid Interfaces](https://developer.apple.com/videos/play/wwdc2018/803/) and [Animate with springs](https://developer.apple.com/videos/play/wwdc2023/10158/);
  - [Rauno Freiberg, Invisible Details of Interaction Design](https://rauno.me/craft/interaction-design);
  - [Benji Taylor, Family Values](https://benji.org/family-values);
  - [Emil Kowalski's animation rules](https://github.com/emilkowalski/skills);
  - [Vercel's interface guidelines](https://vercel.com/design/guidelines);
  - [Linear's agent interaction model](https://linear.app/developers/agent-interaction).
- Design systems:
  - [Material 3's motion tokens](https://github.com/androidx/androidx/tree/androidx-main/compose/material3/material3/src/commonMain/kotlin/androidx/compose/material3/tokens), the source of the spring values;
  - [IBM Carbon motion](https://carbondesignsystem.com/elements/motion/overview/), for productive versus expressive motion.
- Streaming: [Streamdown animation](https://streamdown.ai/docs/animation).
- Accessibility:
  - [WCAG 2.2.2 Pause, Stop, Hide](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html);
  - [WCAG 2.3.3 Animation from Interactions](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html);
  - [web.dev on prefers-reduced-motion](https://web.dev/articles/prefers-reduced-motion).
