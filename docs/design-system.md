# Design system

Kelpie's interface follows one visual identity and one motion system, decided in [ADR-0043](adr/0043-design-system.md) and extended by its first review in [ADR-0044](adr/0044-design-system-review.md), by the agent mascot in [ADR-0045](adr/0045-agent-mascot.md), by its Telegram photo in [ADR-0046](adr/0046-telegram-bot-photo.md), by the logo in [ADR-0049](adr/0049-logo-main-mascot-silhouette.md), by the subagents' pups in [ADR-0051](adr/0051-subagent-pups-return-one-by-one.md) and [ADR-0053](adr/0053-pups-in-the-conversation-header.md), and by the agent's editor in [ADR-0056](adr/0056-agent-editor-and-random-mascot.md). This document holds the values. A page, component or animation takes its colors, type, spacing, radii and motion from the tokens below. A literal number is allowed only where a pattern in section 5 sets it.

The direction is called **Mistura** ("mix"): the identity of the water spirit (kelp colors, shapes that change) with the discipline of the herding dog (Pastoreio, "herding": fast, grouped, no bounce). What the owner does a hundred times a day moves quickly and plainly. The moments that matter (approving, spending, delegating, remembering) get the expressive motion. Each agent is one of those changing shapes: a plush drop of water that stays alive in its place (5.19).

Live references run in the owner's motion lab and in the mascot's concept page (private pages). This document is the source of truth when the two differ.

## 1. Color

Every color is a token with a light and a dark value. The theme follows the operating system unless the owner picks one.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#E7EEEC` | `#091514` | Page background |
| `--surface` | `#F7FAF9` | `#0F1F1E` | Panels, cards, the chat window |
| `--sunken` | `#DAE5E2` | `#0B1918` | Wells, agent bubbles, tracks, hover |
| `--fg` | `#0C2523` | `#DBEAE6` | Text |
| `--muted` | `#4C6663` | `#88A39E` | Secondary text, meta, idle icons |
| `--line` | `#C2D2CE` | `#21403B` | Borders and dividers. Decorative: a control's boundary uses `--muted` |
| `--accent` | `#0A7469` | `#3BC3AE` | Kelp: primary actions, the owner's bubbles, focus, links, progress |
| `--on-accent` | `#F0FAF8` | `#03201B` | Text and icons on `--accent` |
| `--warm` | `#915708` | `#EEAE4A` | Attention: the owner needs to act (an agent is waiting, a free tier is near its end). Nothing else uses it |
| `--ok` | `#1B7C45` | `#55C585` | Done, approved, turned on |
| `--danger` | `#BA3A27` | `#F07461` | Errors, refusals that need action |

- **Text on `--ok`** uses `--surface`, so it inverts with the theme.
- **The mascot's body colors** are the one exception to light and dark pairs. They color the figure, not the page, so each has one value in both themes, and none is amber (5.19).
- **Text on a tint** (a highlight, a hold fill) is `--fg`. Text on a solid fill uses that fill's own text color: `--on-accent` on `--accent`, `--warm` and `--danger`, and `--surface` on `--ok`.
- **Tints** come from `color-mix()` with a token, never from a new literal: a focus halo is `--accent` at 18%, a hold-to-confirm fill `--accent` at 28%, a card that just landed `--accent` at 22%, a text highlight `--accent` at 24%, a receipt icon well `--ok` at 16%, a scrim `--fg` at 16%.
- **Shadows** are black at low alpha in both themes: `--shadow` is `0 1px 2px rgb(0 0 0 / .06), 0 14px 30px -18px rgb(0 0 0 / .38)`, and `--shadow-pop` (palettes, menus) is `0 18px 40px -16px rgb(0 0 0 / .5)`.

### Higher contrast

With `prefers-contrast: more`, or Kelpie's own contrast setting (5.17), two tokens change, and tints give way to solid fills and borders:

| Token | Light | Dark | Measured |
|---|---|---|---|
| `--line` | `#6B8480` | `#557570` | 3.41 / 3.82 / 3.11 in light, 3.69 / 3.37 / 3.57 in dark, on `--bg` / `--surface` / `--sunken` |
| `--muted` | `#344B48` | `#A5BEB9` | 7.94 / 8.90 / 7.25 in light, 9.45 / 8.64 / 9.14 in dark |

Every boundary then reaches 3:1, and secondary text 7:1. `--accent`, `--warm`, `--ok` and `--danger` keep their AA values (section 1's table), so text in those colors stays at 4.5:1, not 7:1.

With `prefers-reduced-transparency: reduce`, scrims and tints become solid fills. In `forced-colors` mode the system's colors replace the tokens, and the state glyphs of 5.9 carry the meaning that color would. A mascot's state is read there from the glyph and the label beside it (ADR-0045 §9).

### Measured contrast

WCAG 2 contrast ratios, measured on 2026-10-15 from the hex values above. AA asks 4.5 for text and 3 for large text and icons.

| Pair | Light | Dark |
|---|---|---|
| `--fg` on `--bg` / `--surface` / `--sunken` | 13.67 / 15.33 / 12.48 | 14.99 / 13.70 / 14.51 |
| `--muted` on `--bg` / `--surface` / `--sunken` | 5.27 / 5.90 / 4.81 | 6.89 / 6.30 / 6.67 |
| `--on-accent` on `--accent` | 5.31 | 7.83 |
| `--accent` on `--bg` / `--surface` / `--sunken` (links) | 4.80 / 5.38 / 4.38 | 8.51 / 7.78 / 8.23 |
| `--warm` on `--bg` / `--surface` / `--sunken` | 5.00 / 5.60 / 4.56 | 9.56 / 8.74 / 9.25 |
| `--ok` on `--bg` / `--surface` / `--sunken` | 4.44 / 4.98 / 4.06 | 8.60 / 7.86 / 8.33 |
| `--surface` on `--ok` | 4.98 | 7.86 |
| `--danger` on `--bg` / `--surface` / `--sunken` | 4.79 / 5.37 / 4.38 | 6.53 / 5.97 / 6.32 |
| `--on-accent` on `--warm` / `--danger` (the mascot's `?` and `!`, at the bubble's middle stop) | 5.53 / 5.30 | 8.80 / 6.01 |

The mascot's bubble is a gradient around its token, lighter at the top left, so its glyph measures lower there. The glyph never carries the state alone: the label, the glyph of 5.9 and the pose do too.

Four pairs miss AA in light, so text never uses them: `--accent`, `--ok` and `--danger` on `--sunken`, and `--ok` on `--bg`. There, the text is `--fg`, and the color moves to an underline or an icon (icons need 3:1, which all four pass).

`--line` on `--surface` is 1.49 in light and 1.51 in dark, below the 3:1 a control's boundary needs (WCAG 1.4.11). Inputs, checkboxes and the hold button draw their boundary in `--muted` (5.90 and 6.30 on `--surface`), and a selected item also changes its fill.

## 2. Type

| Role | Family | Weights | Notes |
|---|---|---|---|
| Display | Bricolage Grotesque | 680 | Headings, agent names in large sizes, the brand. Tracking `-0.03em`, `text-wrap: balance`. |
| Body | Geist | 400, 500, 600 | All running text and UI. |
| Mono | Geist Mono | 400, 500 | Code, file paths, keys, times, counts and eyebrows. |

Only the weights listed are used, with `font-synthesis-weight: none`.
- **The files are variable fonts,** each smaller than the static weights it replaces. Geist's latin file is 29.4 KB, and each of its static weights 33 to 35 KB. Every `@font-face` is held to the weights listed: `400 600`, `400 500` and `680`.
- **They are self-hosted.** All three are under the SIL Open Font License, with their license beside them. The webchat's content policy is `default-src 'self'` (#140), and no page loads fonts from another origin.
- **They come from Fontsource 5.3.0,** byte for byte: `@fontsource-variable/geist`, `@fontsource-variable/geist-mono` and `@fontsource-variable/bricolage-grotesque`, the `latin` and `latin-ext` `wght` files. A new version is fetched the same way, under a new name.
- **Each family ships latin and latin-ext,** chosen by `unicode-range`, so a page that writes no extended letters never loads them.
- **Names carry the version** (`geist-latin-wght-5.3.0.woff2`), so a browser keeps them a year. `font-display: swap`, and only Geist 400 is preloaded.
- **Each `font-family` keeps a system fallback stack.**

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

**The webchat has no uppercase labels** (owner, 2026-10-16, #378). Its day labels, menus, cards and the sidebar write in sentence case, and Geist Mono is only for times, counts, paths and code. The eyebrow above stays for the documentation pages.

### Voice

Kelpie writes the way a capable colleague talks.
- **Say what happened, then what to do.** "No connection. Trying again in 8 s." Not "Oops! Something went wrong."
- **Name things by what the owner knows.** A routine, a task, the vault. Never a table, a Durable Object or a queue.
- **No apologies, no exclamation marks, no whimsical verbs.** A phase says what is being done: "Reading people/ana-souza.md".
- **Empty states explain in one sentence why they are empty**, and offer the one action that fills them.
- **Receipts say who did what and when,** in the owner's time zone.
- **The mascot carries no words.** Its bubbles hold a glyph (`?`, `!`, `…`); what the agent says goes in the conversation.

The fixed texts follow [ADR-0027](adr/0027-fixed-texts-in-three-languages.md): English, Brazilian Portuguese and Spanish.

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
| **Frequent** | Messages, streaming, tool rows, the task board, lists, menus, the palette, navigation | Fast, no visible overshoot, small distances, tight stagger |
| **Moment** | Confirming an action, turning on something that costs, delegating to subagents, saving to memory, agent presence changes | Springs that pass their target a little, larger distances, and a signature: a parent's pups, the ring of a confirmation, the arc into the vault, a mascot's announcement |

**The mascot's life in place** (breathing, blinking, its repertoire) is not UI motion in either grammar. It uses the frequent springs, runs under its own guards, and is the one exception to rule 8 (5.19, ADR-0045 §6).

**From the keyboard**, anything opened, moved or navigated appears at once. What shows progress or a result still shows: a hold fill grows while the key is held, and a confirmation still turns `--ok` and shows its check, without the grow, the pop or the ring. A mascot whose state a keyboard action changes takes the new pose without its announcement.

### 4.2 Springs

A spring is given as stiffness and damping ratio, at mass 1. The Motion library takes the damping coefficient `c = 2 · ratio · √stiffness`.

The other columns come from simulating each spring with semi-implicit Euler, in 1 ms steps:
- **90%** is when it first covers 90% of its distance, which is roughly how long it feels;
- **settles** is the first moment, after 40 ms, when it is within 0.1% of its target and moving slower than 0.02 per second. The CSS `linear()` easing runs over this time, sampled at 21 points;
- **overshoot** is the simulated peak past the target. The exact values are slightly higher: 0.15% at a ratio of 0.9, 1.5% at 0.8, 9.5% at 0.6 and 12.6% at 0.55.

| Token | Stiffness / ratio | Motion `damping` | 90% | Settles | Overshoot | Use |
|---|---|---|---|---|---|---|
| `--spring-fast` | 1400 / 0.9 | 67.3 | 91 ms | 194 ms | 0.1% | Chips, labels that roll, the palette, highlights |
| `--spring-base` | 700 / 0.9 | 47.6 | 129 ms | 266 ms | 0.1% | Bubbles, cards, lists, panels |
| `--spring-slow` | 300 / 0.9 | 31.2 | 197 ms | 394 ms | 0.1% | Large surfaces, drawers, a mascot dozing off |
| `--spring-moment-fast` | 800 / 0.6 | 33.9 | 83 ms | 393 ms | 9.2% | A released hold, small moment feedback |
| `--spring-moment` | 380 / 0.8 | 31.2 | 153 ms | 457 ms | 1.4% | Moment layout: a button that grows, a card that collapses, a mascot's pose |
| `--spring-moment-slow` | 200 / 0.8 | 22.6 | 211 ms | 611 ms | 1.4% | Large moment travel; no pattern uses it since ADR-0051 |
| `--spring-pop` | 800 / 0.55 | 31.1 | 79 ms | 471 ms | 12.3% | Confirmations: a check, a vault that receives, a mascot that changes state, and its bubble |

The first six are Material 3's standard and expressive spatial springs. `--spring-pop` is Kelpie's own, a little bouncier than Material 3's expressive fast spring.

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

Changing a spring means simulating it again the same way, and updating its row, its `linear()` and its duration together.

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
| `--stagger` / `--stagger-moment` | 30ms / 60ms | Delay between siblings entering. A stagger stops at 300 ms: after the tenth sibling at 30 ms, after the fifth at 60 ms. The rest arrive with the last staggered one |
| `--rise` / `--rise-moment` | 8px / 18px | Distance an element rises as it enters |
| `--scale-in` / `--scale-in-moment` | 0.97 / 0.92 | Scale an element enters from; never from 0 |
| `--scale-press` | 0.97 | Pressed controls |

### 4.4 Rules

1. **Frequency decides.** What happens more than a hundred times a day does not animate: the palette opened from the keyboard, shortcuts, arrow keys, filtering. What happens tens of times a day reaches 90% of its distance within 160 ms (`--spring-fast` 91 ms, `--spring-base` 129 ms). What happens occasionally does within 200 ms (`--spring-slow`, 197 ms). Rare actions use the moment grammar.
2. **Respond before animating.** Feedback within 100 ms. A control highlights when pressed and commits when released.
3. **Springs move things; curves change color.** Position and size use springs. Color and opacity never overshoot.
4. **Everything can be interrupted.** A released hold goes back from where it is, at the speed it had. Nothing blocks input while it animates.
5. **Things come from where they start.** A popover grows from its trigger, a task comes out of its routine, a note leaves the sentence and enters the vault, the task's object comes out of the mascot's body. A dialog stays centered.
6. **One element carries the states.** The same button goes from "Confirm" to "Creating" to a receipt; the same bubble goes from typing to the reply; the same mascot changes pose from state to state. Nothing is swapped for a different element in another place.
7. **Streaming is calm.** Only new words appear, with opacity alone, in `--dur-word`. Nothing animates layout per token, and the word wrappers are removed when the stream ends. Phases have their real names, the elapsed time appears after 3 s, and progress is never faked.
8. **Motion announces a change; a state stays still.**
   - A loop stops within 5 s. From then on, a state shows through color, shape and text.
   - The one exception is the mascot's life in place, in every state, under its own guards (ADR-0045 §6).
   - An elapsed time shows that an agent is still working. It updates once a second, or once a minute under the less-motion switch: that is the control WCAG 2.2.2 asks of information that updates by itself.
   - A spinner appears only after 150 to 300 ms of waiting and stays at least 300 ms.
9. **Leaving is faster than arriving.** Entries use springs; exits use `--dur-exit` or `--dur-exit-moment` with `--ease-exit`.
10. **Reduced motion replaces, it doesn't erase.**
    - The trigger is `prefers-reduced-motion: reduce`, or Kelpie's own switch for less motion, for people who don't want to change their system.
    - Movement and scale become opacity, in at most `--dur-fade`. Colors, focus, confirmations and progress stay. Loops are still. A mascot goes Still: the state's pose, with a 150 ms crossfade on a change (5.19).
    - This also meets WCAG 2.3.3 (level AAA): motion from interactions can be turned off.

Two engineering rules come with them:
- in anything that runs daily, animate only `transform`, `opacity` and color. The exceptions are the contained size changes in 5.1, 5.2, 5.3, 5.9, 5.17, 5.18 and 5.25 (the editor's panel growing from its row, its content kept at its final size; a skill's review card opening from its field; the skills list opening the gap for a new skill), and the one mask reveal in 5.7;
- never write `transition: all`.

### 4.5 Sound

Sound is opt-in and off by default ([ADR-0044](adr/0044-design-system-review.md) §4).
- **Only three sounds:** an action was confirmed, something was saved to memory, an agent needs the owner. Each lasts under 300 ms.
- **They have a setting of their own,** separate from the less-motion switch.
- **A frequent action never makes a sound.**
- **Browser notifications** are opt-in the same way. Only "an agent needs you" raises one, and only while Kelpie's tab is hidden.
- **The mascot makes no sound.** Its snores and sighs are drawn (ADR-0045 §6).
- **No vibration.**

## 5. Patterns

Each pattern names its grammar, its numbers and what it becomes under reduced motion. "Exit" means the grammar's exit duration and curve.

### 5.1 Paced replies

Frequent. Kelpie waits `quietMs` after the owner's latest message before answering ([ADR-0024](adr/0024-fixed-wait-end-of-turn.md)).

- **The owner's message.** It enters from below the composer (`--rise`, `--scale-in`, `--spring-base`, origin at the bottom right), and the bubbles above slide up with it (FLIP, `--spring-base`).
- **Held messages.** While the buffer holds them, each of the owner's messages carries a small clock in `--muted` under it, "held". The bubble itself doesn't change, so its text keeps its contrast. The mark fades out (`--dur-fade`) when the turn starts reading them.
- **The wait.** A 64px track, 3px tall, over the composer shows it, wherever the interface knows the buffer's deadline, beside "Waiting for you to finish" in `--muted`. Once the wait ends, the line reads "Kelpie is writing" until the reply or a stop (decision 10, #378). ADR-0043 amends ADR-0024 for this; before, nothing showed during the wait.
  - The webchat learns the deadline from one socket message, `wait`, added with its redesign (#140). It says how long is left and how long the wait is, in ms, so the browser's clock doesn't matter, and whether the owner's typing holds it.
  - The conversation sends it after planning a flush, when the typing hold moves it, and to a socket that opens during it. It sends `deadline: null` when the turn starts reading, or a pause cancels the wait.
  - The bar follows the buffer's real deadline: `quietMs` after the latest message, capped by `maxWaitMs` from the first.
  - A new message refills it in the first 7% of the time, then it drains linearly.
  - While the webchat holds the answer because the owner is still typing, the bar stays full. It drains toward the `maxWaitMs` deadline once that comes first.
  - With `quietMs: 0` there is no wait and no bar.
- **Typing.** When the wait ends, a typing bubble appears. Its dots blink in steps, 0.8 s per cycle, for five cycles. Then they rest at 60% opacity until the reply comes.
- **The reply.** It takes the typing bubble's place in the same element: its width and height go to the reply's size (`--spring-base`), and the text fades in after 70 ms.
- **The header's mascot follows the turn** (5.19). It listens while the bar shows, takes Typing with the typing bubble, and greets a reply with Idle's hop and smile.
- **Reduced motion:**
  - bubbles fade in where they land;
  - the bar still drains, since it is progress;
  - the dots rest at 60% from the start;
  - the mascot is Still (5.19).

### 5.2 Tool calls and streaming

Frequent.

- **The row.** It appears when a call starts, with the call's real name. A call that changes something carries a "changes" tag beside its name; a call that only reads carries none.
- **The mascot follows the same call.** While a row runs, the header's mascot holds that tool's object when it has one, and thinks otherwise (5.19). Between calls, it thinks or types the reply.
- **Each new action** replaces the label above it: the old label leaves upward (exit, 75% of its height), and the new one rises with `--spring-fast`.
- **The spinner** follows rule 8, and turns for at most 5 s. After that, a still ring and the elapsed time say the call is running.
- **The time sits on the right,** from 3 s, in Geist Mono with tabular figures, counting whole seconds and then `m:ss` (decision 11, #378).
- **Done**, the label says what was done, with a check (decision 11). Until the runtime names what a call did, the webchat writes a one-line summary instead ("3 steps · 2.6 s"). A click opens the row: height with `--spring-base`, rows entering with `--stagger`.
- **Typed results.** A result with a known type (an event, a file, a table, a link) shows as a card of that type, not as running text. The card enters with `--rise` and `--spring-base`, or with a fade under reduced motion.
- **Streamed text** follows rule 7.
- **Reduced motion:**
  - labels swap with a fade;
  - the spinner is a still ring;
  - the summary opens at once;
  - the mascot is Still (5.19).

### 5.3 Confirm an action

Moment. The owner's press is the yes ([ADR-0026](adr/0026-confirmation-by-owner-act.md)). A confirmation nobody answers expires after its 10 minutes (ADR-0026 §3), and its card collapses into an "expired" receipt with a neutral icon.

- **Decide in place.** The card names the agent that asks by its id, and its task by number ("`agenda` asks, on task #123"). A task's title, written by the agent, may follow only as quoted data. It carries what the owner needs to decide without leaving it: the event, the diff, the cost. For a write to memory, that is the operation, the note's path, its text, and a warning when it replaces an existing note.
- **Three answers** ([ADR-0044](adr/0044-design-system-review.md)):
  - **Confirm**, the primary button;
  - **Deny this call**, beside it. It closes the confirmation, and the agent goes on without that change;
  - **Hold to pause this conversation**, a smaller control under them. It uses the hold of 5.4 and runs the existing pause (#134): the next answer waits for the owner's next message, and background tasks keep running.
- **The card is compact** (decision 13, #378): who asks, with the agent's still 40px mascot in Waiting and until when it holds; then the text; then the actions on the right, and the hold under them.
- **A sidebar row draws the same card** under itself for its agent's request (5.9, [ADR-0052](adr/0052-webchat-presence-sockets.md)). Its press and its hold go over that row's socket, never over the open conversation's.
- **A press in the card's first 400 ms is ignored,** after it draws or draws again: it may have appeared under the pointer (ADR-0052 §5). An open card's content never changes in place.
- **What the card shows is bounded** (ADR-0044 §1). The agent is named by its id. The evidence comes from the tool call's typed fields, appears as quoted data marked as written by the agent, and never carries a link or a control.
- **The agent's mascot answers with the card** (5.19):
  - while the card is open, it takes Waiting: its eyes on the owner, brows up, the amber bubble; among its gestures, it points at the card;
  - Confirm brings Approved for 1.1 s, a happy jump, then what comes next;
  - Deny (#361) and an expiry bring no announcement: the pose changes as for any state change, as quiet as the neutral receipt;
  - from the keyboard, each change shows the new pose without its announcement.
- **The press.** The button scales to `--scale-press` and grows to the card's full width (width and position, `--spring-moment`). The other button leaves as it grows (exit, `--scale-in-moment`).
- **Working.** Its label rolls to a spinner and what is happening ("Creating the event"). The spinner follows rule 8: after 5 s, a still ring and the elapsed time take its place.
- **Success:**
  - its fill turns `--ok` (`--dur-fade`);
  - the check draws in 280 ms;
  - the button pops (`scale` 1.03 to 1, `--spring-pop`);
  - a ring leaves its edge (650 ms, opacity 0.7 to 0, scale 1 to 1.5).
- **Denied,** the button grows the same way, then the card folds into a neutral receipt: a `--muted` icon, no check, no pop and no ring, in `--dur-fade`.
- **The receipt.**
  - The card collapses into it: its content fades (exit), its height goes to the receipt's (`--spring-moment`), and the receipt rises 4px.
  - The receipt says who decided what and when, in the owner's time zone: "You confirmed at 14:32" or "You denied at 14:32. `agenda` goes on without it."
  - A polite live region announces it.
- **From the keyboard:**
  - Enter or Space acts only with focus on a button. Enter in the composer sends a message; it never confirms or denies.
  - A key already held down when the card appeared doesn't count.
  - A keyboard confirm or deny skips the grow, the pop and the ring. A confirm goes from the label to the spinner, to the check, to the receipt; a deny, which runs nothing, goes straight to the receipt.
- **Reduced motion:** the grow, the pop and the ring go. The color change, the check and the receipt stay, each with a fade. The mascot is Still (5.19).

### 5.4 Turn on something that costs

Moment. A feature that costs beyond the Workers Paid plan turns on only at the owner's request (CLAUDE.md).

- **The hold.** The owner holds the button: a fill (`--accent` at 28%, under a label in `--fg`) grows from the left, linearly, over `--dur-hold`. Space and Enter hold it too, with focus on the button, and the fill grows for them as well, since it is progress.
- **Released early**, the fill goes back from where it is with `--spring-moment-fast`, and the label returns.
- **Complete**, the button turns `--ok`, pops, and rings as in 5.3.
- **The typed confirmation code** in the chat ([ADR-0026](adr/0026-confirmation-by-owner-act.md)) stays as the alternative for anyone who can't hold.
- **Reduced motion:** the fill still grows and empties, without the spring. Completion changes the color and shows the check, without the pop and the ring.

### 5.5 A routine becomes a task

Frequent. Each fire of a routine creates a task ([ADR-0039](adr/0039-routines-as-vault-files.md)).

- **The routine fires.** Its chip pulses once (`scale` 1.05 to 1, `--spring-fast`), and the new card leaves it: from the chip's position at scale 0.7 to its slot at the top of its column (FLIP, `--spring-base`). The cards below move down with it.
- **Column counts** roll like labels (5.2).
- **An agent takes the task.** Its mascot enters on the card at 20 px (`--scale-in`, `--spring-fast`), and the card travels to the next column (FLIP, `--spring-base`). A progress bar fills only from real progress.
- **Done**, the check draws and the title turns `--muted`. The card carries the evidence of the work (a link, a file, a screenshot) and its duration in the past tense: "Ran 4 min 12 s".
- **Delegation shows.** A task the owner gave an agent carries "Delegated by you": the owner stays accountable, the agent does the work.
- **Dragging a card.** People move a task only between Backlog and To do; from In progress on, the agent owns its status ([ADR-0011](adr/0011-agent-task-board.md)). So only cards in those two columns lift, and only those columns accept a drop. Other cards and columns show a no-drop cursor and don't lift.
  - Picked up, it scales to 1.03 with `--spring-fast` and takes `--shadow-pop`.
  - Its slot keeps a dashed outline at 40%, and the other cards open the gap (FLIP, `--spring-base`).
  - Released, it settles with `--spring-base`, and a tint of `--accent` at 22% fades from it in 400 ms.
  - A move is optimistic. If the server refuses it, the card returns to its slot with `--spring-base`, and a toast says why.
  - Every Backlog and To do card also has a Move menu.
  - From the keyboard, Space lifts it, the arrows move it at once, Space drops it and Escape cancels. A live region says where it landed: "Moved to To do, position 1".
- **Reduced motion:** a card fades out of one column and into the next, and counts change with a fade. A dragged card follows the pointer without the lift, and the landing tint fades in `--dur-fade`.

### 5.6 Subagents

Moment. Subagents are temporary and never exceed their creator ([ADR-0036](adr/0036-agent-roles-models-and-subagents.md)). They work as pups of their parent's mascot, which leave it and come back one by one ([ADR-0051](adr/0051-subagent-pups-return-one-by-one.md)), in the conversation's header and on the agent's profile ([ADR-0053](adr/0053-pups-in-the-conversation-header.md)).

- **Each subagent at work is a pup** of the parent's mascot (ADR-0045 §7): the same shape and head, a lighter color, dot eyes, no accessory, and 40% of the size.
- **A pup follows its subagent's tasks.** It leaves when its subagent starts a task and comes back when that task ends. A subagent with no task shows no pup. At most three pups show, since a creator has at most three live subagents (ADR-0036).
- **Where pups play:** beside the parent, on its ground, with no link between them.
  - **In the conversation's header,** at 20 px, beside the 48 px mascot (below).
  - **On the agent's profile,** where its mascot shows at 160 px (5.19). At 40%, a pup is 64 px and keeps the full face of 5.19's 48 px row.
- **Where pups don't play:** the roster, the switcher's list, task cards, the empty conversation's 160 px figure and the Telegram photo. The empty conversation's header still draws them.
- **Offline.** No pups show while the page is Offline (ADR-0047). Pups out when it goes Offline fade out in `--dur-fade`. When it is back, the pups of tasks still running reappear at their places, without leaving again.
- **The header's row.**
  - Pups stand in a row between the mascot's box and the agent's name (5.21). The row is as tall as the box, and pups stand on its bottom edge, the parent's ground.
  - The row starts `--space-1` from the box, and pups stand `--space-1` apart. The name keeps `--space-3` after the row.
  - A header pup is 20 px: 40% of 48 px is 19.2 px. It has the shape, the head, the lighter color and dot eyes. A task card at 20 px drops the head (5.19), but a pup keeps it: the head makes it its parent's. If the engine's head doesn't read at 20 px, it is dropped as on a task card.
  - It has no mouth, brows, mittens or task's object. It breathes, blinks and plays its announcements, such as a success's hop, with no gestures and no dozing.
  - A failed pup shows 5.9's triangle glyph above its head, bare, 10 px in `--danger`. It sits on the header's background, inside the row's height and the pup's width, where `--danger` passes 3:1 in every theme; on the bodies it wouldn't. It is drawn in SVG and hidden from screen readers. The engine's round badge isn't drawn on header pups.
  - A working or waiting pup carries no mark. A waiting pup looks at the parent.
  - Header pups aren't interactive: at 20 px they are below the 24 px target size (WCAG 2.5.8).
  - For screen readers, the row is a list named for the parent's subagents, such as "Research's subagents". Each pup is an item named by its task and state, such as "read the reviews, failed". The figures are hidden.
- **Pups close up toward the parent.**
  - They stand left-aligned next to it, in the order they left.
  - When one goes back, the pups after it slide toward the parent with `--spring-moment`, as a `transform` from where they were.
  - A pup that leaves later takes the first free place after the others.
- **The header's name moves as little as it can.**
  - When the row needs more room, the name and the status line slide to their new place with `--spring-moment`, as a `transform` from where they were. They never stretch.
  - The row keeps the width of the most pups out since it last emptied. When the last pup is back, the row empties 1 s later, so a subagent that starts its next task at once doesn't move the name.
  - The name ends in an ellipsis when it doesn't fit. On a 320 px screen with three pups out, beside today's Display button, which has a label, it keeps about 70 px.
- **The parent's state** comes from 5.9 and 5.19 as for any agent. Delegating is not a state of its own.
- **Leaving.** Each pup comes out of the parent's middle at a scale of 0.3 and goes to its place with `--spring-moment`, `--stagger-moment` apart. As each one leaves, the parent pulses (`scale` 0.9 to 1, `--spring-pop`). On the profile the pup takes Working with its task's object (5.19).
- **Coming back, in the order the tasks end:**
  - **A task that succeeded.** The pup hops, and on the profile smiles too, as a reply that lands (5.19). 520 ms later it travels back into the parent's middle, shrinking to 0.3 and fading, in `--dur-exit-moment` with `--ease-exit` (rule 9). The parent swallows it (`scale` 1.12 to 1, `--spring-pop`).
  - **A task that failed.** On the profile the pup takes Error; in the header it shows its triangle. It stays 30 s, as 5.9's failures do, then goes back the same way with no smile or hop. Dismissing the failure where 5.9 lists it sends the pup back at once. If the creator sends the task back to To do, its pup leaves again when it runs.
  - **A task cancelled,** by the owner's stop or by its agent, or lost with its subagent, goes back with no smile or hop and doesn't count as failed. An ending the page can't tell is never shown as a success. The pause doesn't cancel tasks (5.3).
  - **A task that waits for an answer.** The subagent's question goes to its creator, not to the owner (ADR-0036). The pup stays out with no amber, looking at the parent, and the strip of 5.9 doesn't count it. On the profile it holds its task's object at rest. If the creator then asks the owner, the parent's state follows 5.9 and 5.19, for example Waiting while a confirmation is open (5.3).
- **On the profile, a status line counts them back** in a polite live region:
  - "1 of 3 back", which counts subagents, not departures: 3 is the subagents that went out since none was out, at most three, and one that leaves again counts as out until it is back;
  - "All 3 are back", or "It's back" for a single pup;
  - "1 failed" when one did;
  - "1 waiting on <creator's name>", such as "1 waiting on Kelpie", while one waits on its creator.
- **In the conversation, the header's count** is its own polite live region, on the status line's row. A middle dot separates it from the phase only when both show.
  - It isn't 5.20's status line, which still names only the turn's phase, so a change of phase doesn't repeat it. The count changes only when a pup leaves, fails, waits or comes back.
  - Its parts, joined by middle dots, come in this order: "1 failed", while a failed pup is out; "1 waiting on <creator's name>"; "2 subagents at work", or "1 subagent at work", counting the pups out that work.
  - When the last pup is back, it reads "All subagents are back" for 5 s, so screen readers hear the end, then empties.
  - On a narrow header, the phase ends in an ellipsis first. Then the count hides its parts whole, from the last, so a failure stays in sight. Screen readers still read the whole count.
  - Offline empties it with the pups. While paused it stays, since the pause cancels no task.
- **These texts are fixed** ([ADR-0027](adr/0027-fixed-texts-in-three-languages.md)).
- **The parent's mascot** greets the reply that relays the result, as 5.1 says.
- **Reduced motion:** pups fade in and out at their places in `--dur-fade`; the pups after a returning one, and the header's name, take their new places at once; the mascots are Still (5.19).

### 5.7 Saved to memory

Moment.

- **The highlight.** The learned phrase gets a highlight that grows from its start (`--accent` at 24%, `--spring-moment`). It is not `--warm`: remembering asks nothing of the owner.
- **The chip.** A chip with the real file path, such as `people/ana-souza.md`, lifts from the phrase (`--rise-moment`, `--scale-in-moment`). It travels in `--dur-travel` (`--ease-travel`) along an arc 60px above the straight line to the vault, shrinking to 0.35 and fading over the last 18%.
- **The vault** pops (`scale` 1.14 to 1, `--spring-pop`), and its count rolls. While the agent writes to the vault, its mascot holds the paper and pencil (5.19).
- **The toast** (5.13) says where the note went, from which conversation, when and by which agent: "Saved to `people/ana-souza.md` · From this conversation, today at 14:32 · by Kelpie". It offers Open and Undo for 10 s. Undo sends the chip back along the same arc and takes the highlight away. In the vault, Undo writes a new version that removes the note; history keeps both.
- **Each note keeps its origin.** The vault shows who wrote each passage, from a write log rather than markers in the file: the owner, an agent or an import.
- **Off the record.** A conversation can be marked so nothing from it enters the vault.
- **A new note appears as ink.** Its text reveals left to right under a mask, over `--dur-travel`. Only a new note does this; chat keeps rule 7.
- **Reduced motion:** the highlight fades in, the chip fades out where it is, the count changes with a fade, a new note appears whole, and the mascot is Still (5.19).

### 5.8 Command palette

Frequent, and the clearest case of rule 1.

- **Opened by a click**, it grows from its trigger: `scale` 0.97 and 6px above, to 1, with `--spring-fast`. The scrim fades in `--dur-fade`.
- **Opened with ⌘K or Ctrl K**, it appears at once. Arrow keys, filtering, Enter and Escape are instant too.
- **Only the pointer animates.** Hovering moves the highlight with `--spring-fast`. A pointer that hasn't moved since the palette opened doesn't move the highlight.
- **Closed by a click**, it leaves in `--dur-exit`.
- **Reduced motion:** a click opens and closes it with a fade, and the highlight jumps.

### 5.9 Agent presence

Moment grammar. Every place that shows an agent shows its mascot (5.19), at the size that place allows. The mascot is where Kelpie spends its novelty; the rest of a roster stays quiet.

| State | The mascot at 48 px and up (5.19) | At 36 px | Glyph and label | Motion |
|---|---|---|---|---|
| Working | the task's object in its mittens, or thinking bubbles | an `--accent` badge with the tool's icon | a half-filled circle, "working", the elapsed time `m:ss` | the object pops out, or at 36 px the badge pops; in Alive, the activity's loop |
| Waiting for the owner | its eyes on the owner, brows up, the amber bubble `?` | a `--warm` badge | a diamond, "waiting for you", the time since | a hop, and the bubble or badge pulses three times |
| Idle | eyes open, in its own color; dozing after 45 s | no badge | a hollow circle, "idle" | in Alive, it breathes and draws idle gestures |
| Error | worried brows, the red bubble `!` | a `--danger` badge | a triangle, what failed | one shake, and the bubble or badge pops |
| No response | the working pose without its activity, beside a still, dashed `--muted` bubble `…` | the working badge; the glyph and the label carry the state | a dashed circle, "no response for 1 min" | the bubble pops, then nothing |
| Offline | the plug that came out, held by its cord, beside a solid `--muted` bubble with a struck-through plug | a `--muted` badge | a struck-through circle, "no connection", no time | the plug drops and swings and the bubble pops, or at 36 px the badge pops; in Alive, a calm repertoire (5.19) |

- **The glyph and the label carry the state on their own.** At 36 px the badge has no glyph of its own, so the glyph and the label beside the figure are what name the state. The 5.9 glyphs are drawn as SVG, since Geist has no such characters, and are hidden from screen readers, which read the label. In higher contrast, in forced colors, and wherever a figure can't be drawn, they are what shows the state.
- **No response** is a working agent from which nothing has arrived for 60 s: no streamed token, and no tool call starting or ending. A tool call still within its time bound counts as activity. The webchat can't tell it apart, and doesn't show it (5.19).
- **On a change,** the mascot plays its new state's announcement (5.19), and the status line rolls.
- **A roster stays calm.** At 36 px its repertoire plays one gesture at a time across the whole list, every 7 to 16 s, and never a hop; a state's announcement still plays. Pressing a row does what the roster defines, never a clap.
- **What waits for the owner is counted, not moved.**
  - A strip above the roster counts the agents waiting, with a bell in `--warm` on a 14% `--warm` tint: "1 agent waiting for you". Its count, in Geist Mono, rolls. It enters with `--rise` and `--spring-fast`, and leaves when nothing waits. Its slot above the roster is reserved, so the rows never move when it appears.
  - The browser tab's title starts with the count, "(2) Kelpie", and the favicon gets a `--warm` dot (5.23).
    - The agent's name stays after the count, "(1) Assistant · Kelpie". The title and the favicon change only when the count does.
    - The count is the strip's: a confirmation answered or expired leaves it, and neither writing nor looking at the tab does.
    - Safari keeps the favicon the page loaded with ([WebKit bug 266426](https://bugs.webkit.org/show_bug.cgi?id=266426)), so the title carries the count there.
  - A free tier past 90% joins the count (5.16).
- **A row** (decision 15, #378): the agent's 36px mascot with only 5.19's badge, and no ring around it; its name; a line with the glyph, then "state · what it does"; and the time on the right in Geist Mono with tabular figures, `m:ss` while it works and "3 min ago" while it waits. The open conversation's row stands on `--surface`.
- **The pencil** (#379): a 24 px badge on the mascot's top right, in `--surface` with a `--muted` ring, opens the agent's editor (5.25).
  - It shows while the pointer rests on the mascot, fading in and scaling from 0.9 with `--spring-fast`. Under reduced motion it only fades. The row's link still takes a press on the mascot.
  - It is a real button, "Edit Agenda", in the tab order right after the row that holds the list's tab stop, and it shows while it has focus.
  - Where nothing hovers, it rests on every mascot.
  - It belongs to the mascot: a row that draws no mascot has none. A press on the mascot itself never opens the editor.
- **Each row follows its own agent** ([ADR-0052](adr/0052-webchat-presence-sockets.md)).
  - The open conversation's row reads that conversation's own socket. Every other row, up to 16 in the Registry's order, reads a presence socket of its own. Past 16, a row shows its mascot and name with no state, and the list says once that it follows the first 16.
  - A row shows no state until its first frame arrives; it is never Idle by default.
  - A row whose socket has been closed 2 s shows Offline, alone.
  - A request expires on the page's clock too, so a row stops waiting when its last request does.
- **A row opens in place.** The row opens its agent's conversation. A waiting row's state, "waiting for you", is a disclosure (`aria-expanded`): pressing it grows the request under the row (height, `--spring-moment`), with the card of 5.3. From the keyboard it appears at once. For the conversation that is open, the disclosure moves focus to its card in the thread instead. Once the card folds, its receipt shows 1.6 s and the request closes.
- **The keyboard.** The list is one tab stop, with roving focus and `aria-current` on the open agent. ↑, ↓, Home and End move, with no animation, and Enter opens a row. → opens a waiting row's request, and ← or Escape closes it.
- **Finished work leaves; failures stay.** A subagent or task that succeeded leaves a list at once. One that failed stays 30 s with its triangle glyph and what failed, and can be dismissed.
- **An agent is compared with itself.** Its numbers sit against its own last 30 days, never in a ranking of agents.
- **The roster never reorders** when a state changes: a list that jumps under the pointer costs a misclick.
- **Reduced motion:** mascots are Still (5.19): the state's pose, its badge and its bubble, with a 150 ms crossfade on a change. The elapsed time shows minutes only ("2 min") and updates once a minute. The strip and an opening row appear with a fade, and counts change with a fade.

### 5.10 Following the chat

Frequent.

- **It follows the end only near it.** The thread follows new content while the reader is within 150px of its end. Scrolling up, by wheel, touch or key, stops the follow.
- **New messages below** show a pill at the bottom, "↓ 3 new". It enters with `--rise` and `--spring-fast`, and its count rolls.
  - A press scrolls to the end with `--spring-base`.
  - End jumps at once.
  - Reaching the end by hand removes the pill (exit).
- **When an approval waits below,** the pill reads "↓ Approval waiting" instead.
- **Selecting text** pauses the follow until the selection ends.
- **Sending a message** always returns to the end.
- **An approval never forces a scroll.** It counts in the pill and in the strip of 5.9.
- **Reduced motion:** the scroll jumps, and the pill fades.

### 5.11 Loading

Frequent.

- **The first 200 ms show nothing new.** The old content stays.
- **A skeleton.** Past 200 ms, a skeleton in the final layout's shape replaces it, and stays at least 400 ms. It never shimmers.
- **The content** replaces the skeleton with a `--dur-fade` fade in the same place, without moving the layout. A group announces itself once (`role="status"`).
- **Past 10 s,** the work becomes a background task with real progress, and the screen is free again.
- **Reduced motion:** the same, since it is all fades.

### 5.12 A lost connection

Frequent.

- **The first 2 s show no banner.**
- **The banner.** Then a banner enters at the top (from 8px above, `--spring-base`): the no-Wi-Fi icon, what happened, when the next try is ("No connection. Trying again in 8 s", digits in Geist Mono), and "Try now" (decision 14, #378).
- **Queued messages.** What the owner sends meanwhile shows in `--sunken` with its text in `--muted`, a clock and "queued" (decision 14). It goes out in order when the connection is back.
- **Every mascot that shows a state shows Offline (5.19) when the banner enters.** It says what the page knows, that the connection is gone, and nothing about the turn it no longer sees (rule 7). Every agent in the roster reads "no connection" with the same glyph (ADR-0047).
- **Back,** the banner turns `--ok`, "Back. 1 message sent.", for 2.6 s, then leaves, and every Offline mascot's plug clicks home (5.19). A new connection starts from the history, and a mascot takes Waiting again if a confirmation is still open. A confirmation still open after its turn settled isn't in the history: the conversation lists it, and its card draws again at the thread's end with the time it was asked ([ADR-0052](adr/0052-webchat-presence-sockets.md) §4). A sidebar row whose own socket came through reads its state again, and the others try at once. Alerts stay quiet for the first 4 s after reconnecting, so a backlog doesn't arrive as a burst.
- **An expired login** opens a centered dialog, and keeps the draft. The dialog shows the conversation's mascot at 160 px in Offline, holding its plug, and behind it every mascot that shows a state is Offline too.
  - The page tells it from a lost connection by asking ingress with `X-Requested-With`, which Access answers with 401 once the session expired.
  - Under Access, signing in is a full page of its own, so the dialog says what happened and holds one button, "Sign in again". The page keeps the draft and the messages not yet accepted in the tab's storage, signs in again through a reload, and restores them with "Restored your unsent message".
  - A message not yet accepted goes out again by itself only within 10 minutes. An older one, from a tab reopened later, comes back into the composer as a draft, so nothing old is sent without the owner.
- **Reduced motion:** the banner fades. Under the less-motion switch it says "Trying again shortly" without a counting number.

### 5.13 Toasts and undo

Frequent.

- **A result shows where it happened first:** a receipt, a row, a count. A toast is only for what finished out of sight, or for an action that offers Undo.
- **Placement.** Toasts sit at the bottom center, at most three stacked, each lower one at a scale of 1 − 0.05 per step. They enter with `--rise` and `--spring-base`, and leave with an exit.
- **Timing.**
  - A toast stays 5 s, or 10 s with Undo. An error stays until it is dismissed.
  - Its timer pauses on hover, on focus and while the tab is hidden, and a thin bar shows the time left.
- **Undo.** Inside Kelpie (the vault, tasks), Undo reverses the change. For anything with effects outside Kelpie, the action waits for the toast to end, and Undo cancels it. That delay never applies to a confirmed change (5.3), which already has the owner's yes.
- **A polite live region** announces each toast.
- **Reduced motion:** toasts fade in and out, without the stack offset. The time-left bar still shrinks, since it is progress.

### 5.14 Moving between views

Frequent.

- **From a list to a detail,** the agent's mascot, in its box, and its name travel to their new place with a View Transition (`--spring-base`), and the rest crossfades.
- **Back** reverses the direction.
- **From the keyboard,** and in a browser without View Transitions, the view changes at once.
- **A streaming chat** is never part of the transition.
- **Reduced motion:** a crossfade only.

### 5.15 The phone

Frequent.

- **The composer stays above the keyboard,** following `visualViewport`, with safe-area padding.
- **Sheets.**
  - They rise with `--spring-slow` and stop at 40% and 90% of the height.
  - They follow the finger and close on a flick.
  - Dragging starts only when the sheet's content is at its top.
- **Targets.** They are at least 44px. Primary actions sit in the bottom third, and a hold button's label stays visible above the finger.
- **Inputs** use 16px text on a phone, a size of their own since `--text-base` is 15px, so the page doesn't zoom on focus.
- **Reduced motion:** sheets fade in place.

### 5.16 Numbers and trends

Frequent; crossing a limit is a moment.

- **Changing digits** roll with `--spring-fast`, at most once a second, in Geist Mono with tabular figures.
- **A sparkline** is 24px tall, a 1.5px `--accent` line, with a dot on its last point. It draws once (`--spring-slow`), then gains points.
- **Crossing 90% of a free tier** (#269), such as R2's 10 GB or Browser Run's 10 hours a month:
  - the card's border and icon turn `--warm`, and its text, in `--fg`, says so;
  - it joins the count of 5.9;
  - it pops once (`--spring-pop`);
  - it offers to show what used it. #269 sets no spend limit, so turning a feature off stays in that feature's own setting.
- **Reduced motion:** values change with a fade, and the line appears whole.

### 5.17 The first run

Moment.

- **Comfort comes first.** Before anything else, one step sets motion (full or less), text size, contrast and the mascot's pause (Alive, States only or Still, 5.19). That is where the less-motion switch of rule 10 lives. The step can be reopened in settings. Until the management UI has them, the webchat's Display menu (5.22) holds the switch, the theme, the contrast and the mascot's pause.
- **The first agent.**
  - Until it exists, the empty state says in one sentence why the roster is empty, and offers one button.
  - When it is created, its mascot enters its slot with `--spring-pop` and plays Idle's hop and smile, and the empty block collapses with `--spring-moment`.
- **Channels and secrets** are asked at the step that needs them, not up front.
- **Reduced motion:** fades.

### 5.18 Finished work folds into its receipt

Moment.

- **When a conversation or task finishes,** its detail folds into a summary in one movement: height, and a vertical scale to 0.98, with `--spring-moment`.
- **The summary** lists the real vault paths the work used, as links.
- **Reduced motion:** a fade.

### 5.19 The agent's mascot

Moment for its states, frequent for its life in place ([ADR-0045](adr/0045-agent-mascot.md)). Each agent is a soft, furry drop of water that stays alive where it is. The engine is `apps/ingress/public/webchat/mascot*.js`: plain modules, SVG and the Web Animations API, with no library.

**Anatomy and axes.** Five axes, 374,400 combinations. Each is an agent setting (`mascot`), set through the configuration commands and validated against these ids:

| Axis | Options |
|---|---|
| Shape | `mark`, `bubble`, `drop`, `pebble`, `buoy`, `jellyfish`, `cloud`, `dune`, `star`, `heart`, `bean`, `block` |
| Color | `kelp`, `lagoon`, `tide`, `sky`, `indigo`, `anemone`, `pink`, `fawn`, `cocoa`, `moss`, `lime`, `slate` |
| Eyes | `dots`, `pills`, `shine`, `marbles`, `cyclops`, `half-moon`, `frog`, `stars`, `big`, `buttons`; `cheeks` on or off |
| Head | `none`; `ears`: `pointed`, `floppy`, `round`; `horns`: `two`, `one`, `antennae`; `hair`: `strands`, `curl`, `mohawk`; `leaves`: `one`, `two`, `kelp` |
| Accessory | `none`; `glasses`: `round`, `dark`; `bow`: `tie`, `head`; `hat`: `beret`, `top`, `beanie`; `belt`: `belt`, `collar` |

- **The main agent starts as Kelpie:** `mark`, `kelp`, `big` eyes, round ears and no accessory ([ADR-0049](adr/0049-logo-main-mascot-silhouette.md)). Its silhouette is the logo (5.23).
- **A new agent starts with a random mascot,** saved as its setting, which the owner edits from there (5.25, [ADR-0056](adr/0056-agent-editor-and-random-mascot.md)). An agent created before shows a mascot derived from its id until its first edit saves one. A new option goes at the end of its axis; derived mascots draw from the options above, frozen, so a new one never changes them.
- **A hat hides what sits in the middle of the head:** one horn, antennae, hair and leaves. Ears and two horns stay.
- **Body colors are tokens with one value in both themes,** since they color the figure, not the page. None is amber, which means the owner needs to act.

| Token | Value | Token | Value | Token | Value |
|---|---|---|---|---|---|
| `--mascot-kelp` | `#2E9E8E` | `--mascot-indigo` | `#777CE2` | `--mascot-cocoa` | `#A47458` |
| `--mascot-lagoon` | `#2FB3C6` | `--mascot-anemone` | `#B07CCF` | `--mascot-moss` | `#8AAA45` |
| `--mascot-tide` | `#4F8FD6` | `--mascot-pink` | `#E58BB0` | `--mascot-lime` | `#B3CC3E` |
| `--mascot-sky` | `#7EBDE9` | `--mascot-fawn` | `#B8916E` | `--mascot-slate` | `#7F95A5` |

- **The plush.** Soft parts (the body, ears, hair, leaves, felt and knit hats, mittens) are painted once per piece and size on a canvas: the shape shaded as a volume lit from the top left, then short strands in three layers. The painting is kept as an image, and motion only moves finished images and vectors. Until it is painted, the flat vector shows.
- **Hard parts** (eyes, mouth, glasses, bow tie, horns, antennae, tag, buckle) are crisp vectors with gloss and a soft shadow on the fur.

**States.** Each state has a pose that reads when still, a short announcement when it starts, and a repertoire while it lasts. In Alive the mascot breathes all the time, and draws a gesture from its state's repertoire by weight, never one of the last two (with only two, never the last one).

| State | Shown when | Pose | Announcement | Repertoire |
|---|---|---|---|---|
| Idle | 5.9 Idle | eyes open | a hop and a smile when a reply lands | blinks, glances, looks around and at the owner, wiggles, twitches an ear, hops (12 s apart), stretches, scratches its head, yawns; in Alive, waves when the pointer arrives and claps when tapped |
| Dozing | Idle, after 45 s without an event | eyes closed, a hand as a pillow, "z" | drifts off with `--spring-slow` | snores, stirs; every 20 s at most, wakes bored, rubs its eyes, yawns, rests its chin and dozes again |
| Listening | the wait of 5.1, where its bar shows | head tilted, hand cupped at the ear | its ears twitch | twitches an ear, tilts the other way, blinks, nods |
| Typing | 5.1's typing bubble | mouth open, hands on the keys | talks for about 4 s | talks, blinks |
| Working | 5.9 Working | the task's object and the hands | the object pops out of the body | the activity's loop, blinks, nods |
| Waiting for the owner | 5.9 Waiting; in the webchat, a confirmation's notice (5.3), until it is answered or expires | big eyes, brows up, the amber bubble with `?` | a hop, and the bubble pops and pulses three times | waves, sways, drums on its chin, points at the card, pulses the bubble |
| Approved | the owner's yes, for 1.1 s, then what comes next | arched eyes, a smile, thumbs up | a happy jump with sparks | none |
| Error | 5.9 Error; in the webchat, the notice of a turn no route answered, until the next message or turn | worried brows, hands on its cheeks, the red bubble with `!` | one shake, and the bubble pops | wipes its brow, trembles, pleads, sighs, waves for help, looks down |
| No response | 5.9 No response. The webchat gets no streamed tokens, so it can't tell a slow model from none, and doesn't show it | approved by the owner on #366: the task's object rests, and it looks up at the owner beside a still, dashed `--muted` bubble with `…` | the bubble pops | none |
| Offline | 5.12: the banner of a lost connection, or the expired-login dialog. Every mascot that shows a state, at once, since the page sees none of the agents (ADR-0047) | holds the plug that came out by its loose cord, eyes open on it, brows up, beside a solid `--muted` bubble with a struck-through plug | the plug comes out, drops a little and swings to rest, and the bubble pops | blinks, glances, looks at the plug, tries it in the air, shakes it, looks around, sighs, yawns; 4 to 8 s apart, never a hop |

- **Back from Offline** is an announcement: the plug clicks home, with a small hop and a blink, under 1 s. Then comes the state the history brings. It plays in Alive and States only, at every size, the roster's too. In Still the new pose comes with the crossfade.
- **The activity is always true.** It follows the tool the conversation names: a magnifier to search, paper and a pencil for the vault, a laptop for code, a calendar for the agenda, an envelope for email. A tool without its own object, and the model between tools, show thinking: bubbles over the head. Reading memory before a turn is the vault. While a tool runs, Working takes precedence over Typing.
- **Listening needs the bar.** The webchat's mascot listens while its bar shows (#140). The end of the wait brings it back to idle, unless typing or work has taken over.
- **Springs.** A state change moves the pose with `--spring-moment`, and the bubble pops with `--spring-pop`. Gestures use `--spring-fast`, `--spring-base` and `--spring-slow`.

**Hands and bubbles.**
- Floating plush mittens, a shade lighter than the body, with a soft shadow; no arms. They rest docked below the face, small, and appear where a pose or gesture puts them.
- At work, the task's object comes out of the body and the mittens use it.
- Waiting and error show a glossy 3D speech bubble beside the head, in `--warm` and `--danger` from the theme, with a glyph, so the state never rides on color alone. It pops out, floats, and pulses when the mascot calls the owner.
- Offline's bubble is the same, solid, in `--muted`, with a struck-through plug. It pops out and floats, and never pulses: nothing waits for the owner there.

**Sizes.**

| Where | Size | What changes |
|---|---|---|
| Roster | 36 px | no mouth or brows, eyes 15% larger, no mittens; a glossy badge with a `--surface` ring takes the bubble's place: `--warm` for waiting, `--danger` for error, `--accent` with the tool's icon for working, `--muted` for offline. One gesture at a time across the list, every 7 to 16 s, never a hop |
| Switcher list (5.21) | 36 px | the Idle pose, still, with no badge: the list is open for a moment and carries no state |
| Task card (5.5) | 20 px | the shape, the color and the eyes only: no head, accessory, mittens or badge; still, since the card already says the state. The engine draws a badge at every size up to 40 px today, so the board needs that changed |
| Conversation header | 48 px | its home. Everything happens inside its box; the box is kept before the figure arrives, so nothing moves when it does. Its pups stand in a row after the box, and the name slides to make room (5.6, ADR-0053) |
| Empty conversation, profile, the expired-login dialog (5.12) | 160 px | gestures a little more often |
| Pups (5.6) | 40% of the parent: 20 px in the conversation's header, 64 px on the profile | in the header, the shape, the head, the lighter color and dot eyes, breathing, blinking and announcing only, with 5.9's triangle above a failed one and no badge; on the profile, the full face of the 48 px row; left-aligned beside the parent, closing up as they come back; none while the page is Offline |
| Telegram bot photo | 800 px square, cropped round by Telegram | a still, and a loop Telegram plays (below) |

**Reduced motion and the pause.**
- **The pause** (WCAG 2.2.2) is a setting with three values: Alive, States only, Still. Before a mascot first moves, the webchat asks for it under the header, and the mascot stays still until the owner answers. The Display menu (5.22) keeps it, in the browser. The first run's comfort step and settings (5.17) will hold it too.
- **States only** plays the announcements and nothing else, and cuts each to end within 5 s of the state's start. The mascot doesn't breathe.
- **A change of setting** stops what the old one played, and keeps the pose. The activity's loop starts again only in Alive.
- **Still** shows the state's pose: no breathing, no announcement, no repertoire. A change is a 150 ms crossfade. The poses of listening, typing, working, approved, error and dozing keep their hands, the task's object stays in front of the mascot, and Offline keeps its plug in its mitten.
- **Reduced motion means Still.** Under `prefers-reduced-motion` or the less-motion switch, the setting can't pick Alive or States only, and the webchat doesn't ask.
- **Reading comes first.** While the owner types, the conversation's mascot only breathes and blinks.
- **Nothing moves off screen or in a hidden tab,** the activity's loop included. One shared timer, every 400 ms, schedules every mascot, and an `IntersectionObserver` stops those out of view.
- **The mascot makes no sound.**

**In Telegram** ([ADR-0046](adr/0046-telegram-bot-photo.md)). The agent's bot shows the mascot as its profile photo. Browser Run draws it with the webchat's own engine when the bot connects and when the mascot changes; a mascot already on that bot isn't drawn again.
- **The square** is 800 px on a flat, opaque `--bg` (light). The figure is centered by what it shows, from its ears or hat to its shadow, so nothing that matters falls in the corners Telegram crops.
- **The still** is the rest pose. It is the JPG, and the loop's first frame.
- **The loop** lasts one idle breath, 3.6 s at 30 fps, so it joins up: a blink at 0.7 s, a wave at 1.3 s, a blink at 3.0 s.
- **Telegram decides when the loop plays,** so the pause and reduced motion don't reach it. It is made safe on its own: one pass under 5 s, no flash, no zoom and no scaling of the whole figure.

### 5.20 The conversation

Frequent. The webchat's thread and composer (#140); the research is on #140.

- **Groups.** Consecutive messages from one sender, within 10 minutes and on the same day, form a group (Telegram).
  - Messages in a group sit `--space-1` apart, and groups `--space-3`.
  - Corners are one radius, `--r-bubble`, in a group too (decision 3, #378). There are no tails.
  - A hidden heading opens each group for screen readers: "You, 14:32", "Agenda, 14:33".
- **Bubbles.**
  - The owner's are `--accent` with `--on-accent`, on the right; the agent's are `--sunken`, on the left. A reply needs its bubble: 5.1's typing bubble becomes it.
  - A bubble is at most 29rem wide, and the conversation runs edge to edge, beside the sidebar on a wide screen (decision 9). Text runs with `unicode-bidi: plaintext`, and long words and links break anywhere.
  - Bubbles have no border in the dark theme (decision 17), and no avatar sits beside a reply: the mascot lives in the header (decision 18).
- **Times.**
  - A bubble's own time shows beside it on hover or a tap, in Geist Mono `--muted` with tabular figures, without moving the layout (decision 1, #378). There is no sideways drag, which would fight scrolling on a phone.
  - Times follow the browser's time zone.
- **Days.**
  - Each day opens with a label in sentence case: "Today", "Yesterday", a weekday within the week, then the date, with the year only for another year (decision 2).
  - It is an `h2` holding a `<time datetime>`, in a `--surface` pill.
  - It sticks to the top while scrolling, and a stuck label fades out (`--dur-fade`) 1 s after scrolling stops.
- **Under the owner's messages,** one quiet mark, strongest first. Marks only move forward: a replayed history never steps one back.
  - "Not sent" with the reason, beside a `--danger` icon in `--fg` text. The text goes back to the composer.
  - "Queued" with a clock, in a `--sunken` bubble (5.12).
  - "Sending", only after 300 ms. There is no clock, because the clock means held and queued.
  - "Held" with a clock, during the wait (5.1). It fades out when the turn starts reading.
- **Kelpie's notices** keep the agent's side. The notice of a turn no route answered carries a `--danger` icon, and a confirmation's is the card of 5.3.
- **A turn's steps.** 5.2's row sits above the typing bubble, in the agent's column, as a `--surface` pill with a `--line` border.
  - A pause in the middle of a turn ends the typing bubble in place with "Stopped by your pause", and the row with the same words and a neutral icon.
- **Code blocks.**
  - Lines wrap, and a block taller than 400px scrolls.
  - A real Copy button shows on hover and focus, and always on a touch screen. Its label says "Copied", or "Couldn't copy", in place for 1.5 s, with no toast.
  - There is no language label or line number.
- **Links** in a reply keep their text in `--fg` with a `--accent` underline, since §1's accent text misses AA on `--sunken`.
  - The host follows the text in Geist Mono `--muted`, so a label the model wrote can't hide where it goes.
  - A ↗ follows, with a hidden "(opens in a new tab)" for screen readers.
  - There is no confirmation dialog per link and no fetched page title.
- **The composer.**
  - One row, as the demo's: the text, then Pause and Send as round icon buttons that say their name in a tooltip (decision 4, #378). Pause keeps 12px from Send, so a tap meant for one never lands on the other.
  - Empty, Send waits in `--sunken` with a `--muted` arrow, `aria-disabled` but focusable, and its tooltip says why: "Write a message to send". The first character turns it ready, a color change in `--dur-fade` with no scale. It never becomes Stop and never shows a spinner: while an agent works, a message queues.
  - No keyboard hint shows on the screen. Screen readers keep it: the field is described by what Enter does, which a touch keyboard changes.
  - It grows with its text up to 160px, about six lines, through `field-sizing: content`, at once (rule 1).
  - Enter sends and Shift+Enter breaks the line. Nothing is sent while an input method composes (`isComposing` or keyCode 229). On a touch keyboard, Enter breaks the line and the button sends.
  - A printable key pressed anywhere focuses it, except in a field, a dialog or on a button, and "Skip to message" opens the tab order.
  - Pause stays a separate, smaller control. A single button that turned Send into Pause would pause on a second tap right after sending. Offline, Pause stays pressable and its toast says why it can't pause.
- **Paused.** A line on the composer's top edge, in `--muted`, says what resumes it: "Paused. Agenda answers after your next message." Nothing waits on the owner, so it isn't `--warm`, and writing is how they resume (#134).
- **The empty conversation** shows only once the history arrives with nothing in it: the 160px mascot, one sentence, "No messages with Agenda yet. Write below to start.", and the composer focused.
- **Announcements.**
  - The thread is a `role="log"` with `aria-live="off"`.
  - A separate polite region announces each new reply once, with its sender, and never the replayed history.
  - The header's status line names the turn's phase, never a ticking count.
- **Reduced motion:** messages fade in where they land, marks and labels fade, and the dots rest. The bar still drains.

### 5.21 Picking the agent

Frequent.

- **The header** holds the 48px mascot (5.19), the agent's name in Bricolage Grotesque at `--text-h3`, and the status line. Below the sidebar's width, the owner's avatar sits at its end (5.24).
- **While the agent's subagents work,** their pups stand in a row between the mascot and the name, and their count follows the status line on its row (5.6, [ADR-0053](adr/0053-pups-in-the-conversation-header.md)).
- **On a wide screen the sidebar's roster is the switcher** (5.24), and the name is only a heading.
- **The switcher.** Below the sidebar's width, with more than one agent, or with one the owner can edit there (5.25), the name is a button that opens the list. From a click it grows from the name as 5.8 does; from the keyboard it appears at once. On a phone the list is a sheet (5.15) that stops at 40% and 90%.
  - Each agent is a link to its conversation (`?agent=<id>`), with its still 36 px mascot in the Idle pose (5.19), its name followed by its specialty in `--muted` ("principal" for the main agent, 5.25), and its id in Geist Mono. Back and new tabs work.
  - The open agent's mascot carries 5.9's pencil at rest, with a 44 px target, since a phone has no pointer to rest on it. It closes the list and opens the editor (5.25): its sheet, on a phone.
  - The current one is marked with `aria-current`.
  - Arrows, Home and End move through the list, and Escape closes it.
- **The order** is the registry's and never changes with activity (5.9).
- **Without `?agent=`,** the webchat opens the main agent, and so does an id the list doesn't name.
- **The list comes from ingress.** It names only the agents that chat, each one only if the Directory admits this login to it, as it admits the agent's socket. It carries each agent's mascot, so the list and the sidebar draw them before any socket opens ([ADR-0052](adr/0052-webchat-presence-sockets.md) §7).
- **Reduced motion:** the list fades.

### 5.22 The Display menu

Frequent. One step away, from the owner's account: the sidebar's foot (5.24), or the header's avatar below the sidebar's width (decision 8, #378).

- **It grows from the account** as 5.8 does, from 0.97 and 6px, with `--spring-fast`: upward from the sidebar's foot, down from the header's avatar. From the keyboard it appears at once, with focus on the chosen theme, and Escape returns focus to the button that opened it.
- **It starts with the owner:** the name and the email from the Access login. The page shows them and never stores them.
- **The theme,** as icons: System, Light and Dark, each with its name for screen readers and in a tooltip.
  - The lab's segmented control: a `--sunken` track with its boundary in `--muted`, and a `--surface` chip under the chosen one. The chip slides with `--spring-fast` for the pointer and jumps for the arrows.
  - The theme applies at once, the page crossfades in `--dur-fade`, and the chosen icon turns into place with `--spring-base`: the screen settles, the sun turns a quarter, the moon tilts.
- **Less motion and More contrast,** as switches, each with its icon before its words: a circle with one trail, and a rounded square split on its diagonal, never the half-filled circle of working. They are the switch of rule 10 and the higher-contrast set of §1. The system's reduced motion can't be turned off here; the switch only adds to it.
- **The mascot's setting** joins them once the owner has answered its question (5.19). Each choice draws the mascot's own outline, with the main mascot's round ears (ADR-0049): mid-hop for Alive, with 5.19's badge for States only, standing on a line for Still. Under reduced motion it can't move, and says why.
- **The version** closes the menu, in Geist Mono `--muted` (decision 5). A press copies it, and "Copied" shows in its place for 1.5 s.
- **They are stored in this browser** until the comfort step of 5.17 exists.
- **They apply before the first paint.** A small script in the page's head sets them on `<html>`, so the page never flashes the wrong theme. The phone's browser bar takes the page's background.
- **Reduced motion:** the menu and the chip fade.

### 5.23 The logo

Frequent, and still: the logo never moves ([ADR-0049](adr/0049-logo-main-mascot-silhouette.md)). Kelpie's logo is the main agent's mascot as a flat silhouette, and it names the product.

- **The files.** `scripts/brand-icons.mjs` draws them all:
  - in `docs/brand/`, the mark (`kelpie-mark.svg`), its lockups for light and dark, the 16 px favicon master (`favicon-16.svg`) and the sources of the home-screen icons (`app-icon.svg`, `app-icon-rounded.svg` and `app-icon-maskable.svg`);
  - the webchat's icons, listed under the favicon below.
- **The mark** is the main mascot's `mark` shape with its round ears, in one color: no face, fur, accessory or shadow.
  - It comes from the engine's 120 grid: the shape at 24..96 × 36..108 with corners 36, 36, 36 and 11.5, and the ears, circles of 10.5 at (38, 42) and (82, 42).
  - If the main mascot's default changes, the mark changes with it, through a new ADR.
- **The lockup** sets the mark beside "Kelpie" in Bricolage Grotesque 680, tracking −0.03em, with the font's kerning:
  - the mark is 1.3 cap heights tall, centered on the cap band;
  - its right edge sits half a cap from the K's stem;
  - the webchat's sidebar sets the word at 17 px (5.24);
  - nothing else comes within half a cap of the lockup, or a quarter of the mark's height of the mark alone.
- **Color.** The mark and the word are `--accent`:
  - on `--bg`, `--surface` and `--sunken` they measure 4.80, 5.38 and 4.38 in light, and 8.51, 7.78 and 8.23 in dark;
  - a logo is exempt from WCAG 1.4.11, but the logo that links home still keeps 3:1, which every pair passes;
  - on anything else (a photo, another color), the mark goes in `--on-accent` on an `--accent` tile;
  - it is never `--warm`.
- **Small sizes have their own drawings.** At 32 px and below, the favicon's masters draw the mark with its body on whole pixels and the ears a little larger, so they survive.
- **The favicon is an opaque tile:** `--accent`, radius 22% of its side, with the mark in `--on-accent` (5.31:1 in light, 7.83:1 in dark).
  - Safari ignores the dark block inside an SVG favicon, so the light tile is the one every browser can show.
  - Chrome and Firefox take the dark tile on a dark system.
  - The webchat serves:
    - `icon.svg`, the 32 px master;
    - `favicon.ico`, with a 16 px layer from `docs/brand/favicon-16.svg` and a 32 px one from the 32 px master;
    - `apple-touch-icon.png`, 180 px and square, since iOS masks it, with the mark 62% of the tile tall;
    - `icon-192.png` and `icon-512.png` on a rounded tile;
    - `icon-maskable-512.png`, with the mark inside the 40% circle Android may crop to;
    - `icon-waiting.svg`, the 32 px master with 5.9's dot, which the page swaps in while an agent waits.
  - It asks for its manifest with the Access login's cookie, and the manifest opens the webchat as a browser tab.
- **The waiting dot** of 5.9 sits on the favicon, never on the logo:
  - a `--warm` circle of r 5 at (25, 25) on the 32 px tile. It takes the bottom-right corner, where the 36 px badge sits (5.19), so both ears stay clear;
  - a 2 px `--on-accent` ring around it, since `--warm` on `--accent` measures 1.04 in light and 1.12 in dark. On `--on-accent` it measures 5.53 and 8.80;
  - a static file, so the page's CSP admits it without `data:` images. It has no ICO twin: the browsers that change a favicon at runtime read the SVG.
- **It never stands in for an agent.** Every agent, the main one included, shows its own mascot (5.19). The logo carries no state, badge or glyph. The amber dot of 5.9 belongs to the tab's favicon, not to the logo.
- **Reduced motion:** nothing changes; it doesn't move.

### 5.24 The sidebar

Frequent. On a screen 56rem wide or more, the agents sit in a sidebar beside the conversation, which takes the rest of the width (the owner, #378).

- **296px on `--bg`,** with a `--line` border toward the conversation. From the top:
  - the lockup (5.23), linking home;
  - the strip's reserved slot (5.9);
  - the roster (5.9), whose rows never reorder;
  - the owner's account, at the foot.
- **The account** (the owner, 2026-10-16): a 24px avatar, the name, truncated when long, and a chevron. A press opens the Display menu (5.22).
  - The avatar shows the initials on `--accent` with `--on-accent`: the first and last words of the name, or of the email's name without one. A photo the login carries waits for a content policy that allows its host.
  - Without a login to read, the button reads "Display".
- **Below 56rem** the sidebar gives way: the header's name switches agents (5.21) and the header's avatar opens the menu. What waits for the owner still counts in the tab's title and on the favicon.
- **Reduced motion:** the strip and an opening request fade, and the rows' times count in minutes.

### 5.25 Editing an agent

Moment for its Save and its open; frequent for its sections and choices (#379, [ADR-0056](adr/0056-agent-editor-and-random-mascot.md)). The owner edits an agent from the pencil on its mascot (5.9, 5.21), never from a tap on the mascot, which pets it (5.19). The research and the reference projects' findings are on #379; the lab is "O editor do agente em movimento".

- **The container.**
  - On a wide screen, a non-modal panel beside the sidebar: 820 × 690 px at most, 8 px from it, on `--surface` with `--shadow-pop` and `--r-panel`. The conversation stays visible and live behind it.
  - Below the sidebar's width, the same panel over the conversation.
  - On the phone, 5.15's sheet at 90% over a `--scrim`, with a visible Close of 44 px. Back and Escape close it, and the page behind it is inert. It never stacks over the switcher, which closes first.
- **Opening.**
  - From a click, the panel grows from its row with `--spring-slow`: its box goes from the row's to its own, while its content, laid out at its final size, fades in from 6 px once the panel can hold it, `--stagger` apart. This is one of §4.4's contained sizes.
  - A copy of the row's mascot flies out and grows from 36 to 160 px into the preview, 5.14's shared element. The preview shows when it lands and looks at the owner.
  - From the keyboard, it appears at once, with focus on the open section's tab. On the phone, the sheet rises with `--spring-slow`.
  - It opens on Mascot.
- **Closing.** Close and Escape leave in `--dur-exit`, and focus goes back to the pencil, or to the switcher's name when the pencil is hidden by then.
- **The frame.**
  - On the left: the agent's mascot at 56 px, its name in Bricolage Grotesque, and its specialty. The name, the specialty and the mascot follow what the owner changes before saving.
  - Below them, the sections as APG tabs: Profile, Mascot, Soul, Rules, Memory and Skills, each an icon beside its name (5.26). ↑ and ↓ move and select, Home and End go to the ends.
  - The highlight slides with `--spring-fast`, and a new section's content rises with `--rise` and `--spring-base`. From the keyboard, both change at once.
  - On the phone, the agent sits in the sheet's head beside Close, and the sections are a row, each icon over its short name. An icon never replaces a label the owner hasn't learned (§8).
- **The mascot acts out the section,** with 5.19's poses: in Profile it looks at the owner, and while the owner types it only blinks. In Soul, Rules and Memory it writes on paper, and in Skills it holds the magnifier (#381).
- **A changed section** shows a 6 px `--accent` dot after its name, which enters from 0.6 with `--spring-fast`; its tab's name adds "changed". Nothing waits on the owner, so it isn't `--warm`.
- **Profile.** The name (80 characters), the specialty (40) and the short description (200), each one line, as the agent's settings take them.
  - Under the specialty and the description, what each is for, and its count, "15 of 40", in Geist Mono.
  - The main agent's specialty is a read-only field with a lock: "principal", and why.
  - A name that shows nothing can't be saved: the field turns its boundary `--danger`, says "Write a name", and Save waits. A specialty or a description that shows nothing is an empty one.
  - What a line can't hold leaves as it is pasted, as the agent's settings would refuse it (ADR-0056): tabs and breaks become spaces, control, format, private-use and unassigned characters go, and a run of variation selectors shrinks to one.
  - Inputs use 16 px text on the phone (5.15).
- **Mascot, the mascot lab's Construtor.**
  - The preview stands on a small stage, 160 px (120 on the phone), and stays pettable. Beside it, the summary line, which is also its text alternative ("Pebble · Fawn · Dots eyes with cheeks · floppy ears · a bow tie"), then Undo and Randomize all as icon buttons (5.26), then one line on what a tap does and when the look counts.
  - One tab per axis, Shape, Color, Eyes, Head and Accessory, as APG tabs in a segmented track. Each tab says how many options it has and offers "Randomize <axis>".
  - Each axis is a named radiogroup (APG radio): the arrows move and select, and wrap; Tab enters on the checked option. Each tile draws its option on this agent's mascot, Still, at 46 px, with its name under it.
  - Colors are named swatches, six to a row. A head or an accessory picks its type, then its variation in a second radiogroup, which follows the type. Cheeks is a switch beside the eyes.
  - There is no "Back to default": a new agent's look is already a random one (5.19).
- **On a change,** the preview crossfades from its old look in `--dur-fade`, and the part that changed moves:
  - a new shape squashes and settles with `--spring-pop`;
  - a new head or accessory drops in from 8 px with `--spring-moment-fast`;
  - new eyes, or cheeks, blink once;
  - a color only crossfades, with no overshoot (rule 3);
  - a new change starts from the figure as it is, without queueing.
- **Randomize.** The die turns 90° with `--spring-moment-fast`, and the mascot swaps its look and jumps, the engine's Excite: a 12 px hop and a blink. From the keyboard, the swap happens without the die's turn.
- **Undo.** ⌘Z, outside a text field, and the U-turn button undo every step since the panel opened. The tooltip names the step ("Undo color", "Undo randomize"), and says "Nothing to undo" when there is none. The option that came back takes `--accent` at 22%, fading over 400 ms (5.5); a color swatch, which can't show a tint, pops back from 1.25 with `--spring-pop`.
- **Save, once.** The preview changes live inside the editor, and nothing is saved until Save. It writes each changed section once, through its own route: the mascot whole, so the bot's photo is drawn once (ADR-0046), and the profile's changed fields.
  - The footer says what is unsaved, "1 unsaved change" with the count in Geist Mono, or "All saved". On Mascot, a line under it says the change applies everywhere and the bot's photo changes in a few minutes.
  - The button says what it does, keeping the letters its labels share (Family Values): Salv-ar, Salv-ando, Salv-o; Sav-e, Sav-ing, Sav-ed. The suffix rolls with `--spring-fast`, and a spinner joins after 200 ms (rule 8). ⌘S saves.
  - Success is 5.3 without its ring, which stays the owner's yes: `--ok` in `--dur-fade`, the check drawn in 280 ms, and a pop from 1.03 with `--spring-pop`. The changed dots leave, `--stagger` apart, and the mascots play Approved for 1.1 s. From the keyboard, the pop is skipped.
  - Then the panel closes, and a toast (5.13) says what saved, "Agenda: mascot saved", and that the bot's photo changes in a few minutes, with Undo for 10 s. Undo sends back what was saved before. Closing it sooner shows the toast at once.
  - A change made while it saves, or before it closes, keeps it open, still to save, and Save reads Save again. Closing while it saves closes it once the save ends, and opening another agent's editor waits for it.
- **The two ways a save can end early.** Each takes the footer's place, inside the panel; neither is a dialog over it.
  - Closing or Cancel with changes asks, on a 10% `--warm` tint: "Discard 3 changes?", what goes back, Keep editing, which takes focus, and Discard in `--danger`. Escape keeps editing. Back on the phone asks the same.
  - A save that fails in part names what didn't save and what did, on a 9% `--danger` tint: "The Profile wasn't saved. The Mascot is saved." The failed section's mark turns to `--danger`'s alert, its tab's name says "not saved", and the footer offers "Save the Profile". When every section fails, it says "Nothing was saved". An expired login also brings 5.12's dialog.
  - Opening another agent's editor over changes asks first, the same way.
- **The agent's own files** (#381, [ADR-0058](adr/0058-owner-edits-agent-files-from-the-webchat.md)): Soul (`SOUL.md`), Rules (`AGENTS.md`), Memory (`memories/MEMORY.md`) and Skills (`skills/<name>/SKILL.md`), only what belongs to that agent. The editor reads them once as it opens; until then each says so, and a vault that is off, or a read that failed, says that instead, with Try again.
- **Reading and editing a file** (frequent; the lab's interaction 4).
  - Soul, Rules and each skill's `SKILL.md` open formatted, through the replies' renderer (5.20) with headings, quotes and a skill's frontmatter added; nothing from the file is parsed as HTML. Beside the title, the file's path in Geist Mono, hidden on the phone.
  - **The switch:** a radiogroup of two icon segments, Visualizar (a book) and Editar (a pencil on its line), never one glyph that flips (Obsidian's, avoided). Each tooltip names it and shows ⌘E, or Ctrl+E off a Mac, in a `kbd`. The arrows move and select; ⌘E or Ctrl+E toggles it anywhere in the editor while a file shows. The indicator slides with `--spring-fast`. The page remembers the choice in this browser.
  - **Keeping the place** (VS Code, iA Writer): each formatted block carries its source lines; switching notes the first block in view and its offset and restores both before paint; Editar puts the caret on that line; a double-click on a formatted block edits at its line.
  - **The switch moves quietly:** up to 20 visible blocks slide to their new places, translate only, with `--spring-base`; the views crossfade in `--dur-fade`, the old one held where it was on screen; the Markdown's marks fade in 70 ms later; a 2 px `--accent` bar marks the line you were on, held, then faded over 1.1 s. From the keyboard the switch is instant, and the bar still shows. Under reduced motion, a crossfade.
  - **Editing stays plain text,** in Geist Mono at 13 px (16 on the phone): a real textarea over a copy of its lines, which puts the leading marks (`#`, `-`, `1.`, `>`, a fence) in `--muted` and marks the caret's line with `--accent` at 7% and a 2 px bar. The field grows with its text, so the panel scrolls, not the field. Under it, what the file is for and its count, "612 characters", in Geist Mono.
  - Unsaved edits stay when the view changes.
- **Rules with no file of their own:** the mascot taking notes, at 104 px, one line ("No rules just for Agenda: it follows the vault's shared rules"), and one action, Create its own rules, which opens the editor on a heading.
- **Memory,** in Hermes's format, which the agent reads in every conversation, as Hermes does (#437); the section says so, and that what Kelpie learns goes to the vault's notes.
  - One row per entry, each a field that grows with its text; × removes one, and New memory adds one, focused. Entries are kept as Hermes keeps them: trimmed, empty ones left out, joined by `\n§\n`.
  - **The budget,** above the entries: a 6 px bar, a `meter`, and "246 of 2,200 characters", whose digits roll (5.16), at most once a second. The bar fills by `scaleX`, with `--spring-base`. Past 80% it turns `--warm`; over the limit, `--danger`, and it says by how much: "64 over the limit: shorten before saving". Save waits while it is over, as it does for an entry with a `§` line of its own, which Hermes would split; that row's boundary turns `--danger`.
  - A save the vault refuses turns the budget `--danger` and says so, until the owner edits it.
- **Skills,** the agent's own, by name in Geist Mono and description, with where each came from on the right: "exemplo/skills · 3f2a91c", "created here", ".zip file", "pasted text", and "edited here" for an installed skill the owner changed.
  - A row opens its `SKILL.md` in the same switch, with Back; the header shows the skill's name. A skill installed from GitHub offers Look for an update.
  - **Create from scratch** opens a new `SKILL.md` with its frontmatter, to edit. Until it is saved, the skill takes the name its frontmatter gives it, once that is a name the specification takes.
  - **A pending skill,** new or installing, has × on its row, as a memory entry does, which drops the change before Save; focus moves to the next row. A pending install's row opens nothing until it is saved, and stays in the tab order.
  - **Removing a skill** (#438): a saved skill's row has × in the same slot, named "Remove brief" (5.26). The verb is Remove, never Uninstall or Delete: a skill created here was never installed, and Undo brings it back.
    - Pressed, the row stays in its place. Its name is struck through and, with its tile, turns `--muted`. Where it came from, it says "removes on Save" in words, since a strike alone isn't announced. It opens nothing until Save or Keep, and stays in the tab order. The section shows its dot, and the footer counts it.
    - The × becomes Keep in the same slot: the U-turn, "Keep brief". Focus stays where it was, so a second press undoes the first. Keep gives back an edit made before the removal. A polite live region outside the list says "brief removes on Save." or "brief stays."
    - Nothing asks first. The row is the pending state, Save is the owner's yes, and the toast's Undo brings the skill back whole (5.13). A dialog is only for what can't be undone.
    - The name and the tile fade to `--muted` as the strike fades in, in `--dur-fade`. Where it came from rolls (5.2), and the U-turn fades in. On Keep, the colors fade back, the note rolls back and the × fades in, while the strike goes at once. From the keyboard, it changes at once; under reduced motion, the roll is a fade.
    - A removal that conflicts, or that the vault refuses, shows the row's alert, and the footer says why. Keep clears it, and the row shows the vault's version, which × removes. When Keep gives back an edit, the conflict stays with the edit, which started from the same version.
  - The page checks a `SKILL.md` as the vault will (ADR-0058 §4): a name the specification takes, the folder's own for a saved skill, and a description of 1 to 1,024 characters. What fails says so under the file, and Save waits. YAML the page can't read for sure, as a folded description, is left to the vault.
- **Installing a skill** (moment; the lab's interaction 5), always reviewed. Its own view, "Install skill", with Back.
  - **Where from:** a radiogroup of three segments, From GitHub, .zip file and Paste the text, each an icon beside its name. A `.zip` or `.skill` dropped anywhere on the view installs from the file.
  - **Fetching:** the Fetch pill becomes its own ring, as the App Store's Get does: it turns while the fetch waits, at most 5 s (rule 8), and never fills as if it knew how far it was; it ends in a check on `--ok`. The phases are the real ones, rolled: "Fetching exemplo/skills", then "3 files checked, at 3f2a91c". The mascot holds the magnifier.
  - **The review card:** the field's place opens into it, its height on `--spring-moment`, its children rising 60 ms apart (`--stagger`). It shows the name, the description, the source, the commit, the count and the size in Geist Mono; every file, a script tagged "script: kept, not runnable in Kelpie" and a binary one "binary: kept as it is"; the hidden files left out; and the static scan's verdict by trust level, Clean in `--ok`, the count of warnings in `--warm`, or Blocked in `--danger`, with the findings by file and line. Blocked says why and offers no Install. See the SKILL.md shows it formatted, inside the card. A commit named in the address, which no branch or tag vouches for, says so under the source.
  - **An update, or a skill that replaces one:** the card says what it replaces, warns when the owner edited it ("installing replaces your changes"), lists each file new, changed or removed, and shows the `SKILL.md`'s difference, `+` lines in `--ok` and `-` lines in `--danger`.
  - **Install:** the same button goes Install, Adding, then a check and Added, on `--ok`, popping from 1.03 with `--spring-pop`. It adds a pending change that Save writes.
  - **The signature:** the card folds (scaleY 0.98, `--dur-exit-moment`, as 5.18); a chip with the skill's name travels on an arc to its row in the list (5.7's `--dur-travel` and `--ease-travel`); the list opens the gap with `--spring-base`, and the row pops from 1.03 with `--spring-pop`. The mascot plays Approved, and a polite live region says "pdf-forms added. Save to keep it." The row says "installs on Save".
  - **Errors stay in the card,** in `--danger`, and the input stays as it was: "There's no SKILL.md in the .zip."
  - From the keyboard, the row lands at once; under reduced motion, every step is a fade. Focus lands on the new row, and the live region sits outside the list, so redrawing it never cuts the announcement.
- **One Save for the files too.** It writes every changed file in one request, so one commit with `Kelpie-Via: webchat`, beside the profile's and the mascot's routes. Each changed file's section shows the dot, and the footer counts it.
  - **A conflict** (the file changed in the vault since it was read) keeps the owner's draft and says so on a 10% `--warm` tint, with See the vault's version, Keep mine, which saves over it next time, and Use the vault's. Saving again without Keep mine conflicts again: nothing is ever overwritten by surprise.
  - **A save that fails in part** names what didn't save and what did, as above, and why in one more sentence: "The Memory wasn't saved. The Mascot and the Soul are saved. The Memory is over Hermes's 2,200 characters."
  - **Undo** in the toast writes the files back as they were, from the versions this save wrote, in one more commit; a removed or replaced skill comes back whole.
- **What it never does:** a Save per section, a modal for unsaved changes, a dialog before removing a skill, blur in a crossfade, or the ring or confetti on Save.
- **Reduced motion and Still:** every change is a 150 ms crossfade, and the mascot is Still. The panel, the sheet and a section's content fade in place, and the highlight moves at once. The check, the colors, the dots and the count stay.

### 5.26 Icon buttons and tooltips

Frequent. An icon stands in for a word only where the owner knows the action; it always says its name.

- **The icons** are 16 px, with a 1.5 stroke and round caps, drawn by `icons.js`. Undo is a U-turn arrow, since a circle reads as refresh; Randomize is a die with three pips, since a shuffle means reorder. The editor's sections are an ID card, the mascot's own outline (5.22), a page with a heart, a list, two stacked notes and a puzzle piece. None is a lone diamond, a triangle, or a hollow or dashed circle: those are 5.9's glyphs.
- **An icon button** is 34 px with its boundary in `--muted`, or borderless for a small one inside a header, and 44 px on the phone. A disabled one stays focusable, `aria-disabled`, and its tooltip says why.
- **Its name** is its `aria-label`, and its tooltip shows the same words, verb first ("Randomize all"), or why it waits. Nothing uses `title` (WCAG 1.4.13).
- **The tooltip's timing:**
  - the first waits 400 ms, then rises from 4 px and 0.97 with `--spring-fast`;
  - another within 300 ms of one hiding shows at once, with no animation;
  - keyboard focus shows one at once, a click's focus none, and Escape hides it without moving focus;
  - it has no timer, and leaves in `--dur-exit`.
- **Near a top edge,** a tooltip opens below its button.
- **Reduced motion:** tooltips appear and leave with a fade.

## 6. Implementation notes

- **CSS first.** Tokens are custom properties. Springs are the `linear()` values above, supported in every current browser. Enter and exit use transitions with `@starting-style`. Choreographed sequences use the Web Animations API, which takes the same easings.
- **View Transitions** fit navigation between views. They never wrap a list that streams.
- **The Motion library** fits only where the owner drags something with velocity, such as reordering the board. It is loaded with the page that needs it.
- **An entrance plays once.** It is keyed to the element, so a streaming update never replays it. It never leaves content at opacity 0 if the animation doesn't run, which happens when a background tab pauses timelines. A list animates entries only up to 60 rows; past that, rows appear at once.
- **Heavy effects stay off the DOM's per-frame path.** No pattern uses an SVG filter now; a filter, a blur or anything heavier belongs in a shader scoped to its element, or nowhere. Full-screen WebGL stays out of the product.
- **The mascot engine is the one continuous loop.** A new surface that shows an agent reuses it (5.19): one shared timer, observers that stop figures out of view, and the plush painted once per size. Nothing draws an agent another way.
- **The stack is still open.** These choices guide whatever UI stack Kelpie picks; the [viability study](viability-study.md) lists it among its open questions.

## 7. Review checklist

A pull request that changes the interface answers yes to each line:

- [ ] Every color, size, radius, duration and easing comes from a token, unless a pattern in section 5 sets the number.
- [ ] Only `transform`, `opacity` and color animate, apart from the contained sizes in 5.1, 5.2, 5.3, 5.9, 5.17, 5.18 and 5.25 (the panel's grow, a skill's review card and a new skill's gap) and the mask reveal in 5.7; no `transition: all`.
- [ ] Keyboard-triggered actions don't animate their way in or out; progress and results still show.
- [ ] Loops stop within 5 s, apart from the mascot's life in place (5.19), and the steady state reads without motion.
- [ ] Exits are faster than entries, and staggers stop at 300 ms.
- [ ] Interrupting an animation leaves no element stuck halfway.
- [ ] Under reduced motion, every movement becomes a short fade, and no feedback disappears.
- [ ] New text meets the contrast in section 1, in both themes and in higher contrast, and controls draw their boundary in `--muted`.
- [ ] `--warm` appears only where the owner must act, and a toast only where 5.13 allows one.
- [ ] Copy follows the voice in section 2.
- [ ] Every place that shows an agent shows its mascot at a size from 5.19, never a photo, an initial or a generic icon.
- [ ] The logo appears only as the brand, drawn by `scripts/brand-icons.mjs` and sized as 5.23 says, and never in place of an agent's mascot.
- [ ] A mascot's pose, badge, glyph and label agree, and they show the agent's real state.
- [ ] A new mascot surface moves only as its size allows in 5.19, and the pause and reduced motion stop it.

## 8. Designing what isn't here yet

A component, screen, state or interaction this document doesn't define is designed from award-winning work, never from a library's default look (owner, 2026-10-15; ADR-0043 §7).

1. **Research first.** Find how award-winning UX and UI work solves the same problem, newest editions first:
   - the Apple Design Awards;
   - Awwwards, including its product sites;
   - the CSS Design Awards;
   - the Webby Awards;
   - the Red Dot and iF interface categories;
   - teams known for interaction craft.

   Read the product, its video or its write-up, not only the award's page. Check the reference projects in `CLAUDE.md` too.
2. **Look at two things.** How it moves in the interaction, with numbers where the source gives them, and how usable it is: speed, keyboard, errors, accessibility.
3. **Post the findings on the issue,** each as adopt, adapt or avoid, with a link and one line on why. If nothing relevant turns up, say so in one line.
4. **Design it in Kelpie's terms.**
   - Pick its grammar (frequent or moment), its springs and its tokens.
   - Check it against the ten rules.
   - Say what it becomes under reduced motion.
   - Give a moment its signature; keep a frequent pattern quick and quiet.
5. **Show it live when motion is the point.** A lab page lets the owner judge an animation before it is built.
6. **Add it to section 5** in the same pull request as the code, with its sources in section 9.

**Already rejected.** Research turned these down; a new design doesn't bring them back without a new decision:
- glass or blur over content;
- glows or ambient motion that loop, apart from the mascot's life in place under its guards (5.19);
- a character that wanders the screen: the mascot lives in its box, and the box moves only with its view (5.14);
- playful verbs in place of real phase names;
- a roster that regroups itself by state.

## 9. Sources

The rules above cite these. The first set was read on 2026-10-15; a source added later says when it was read.

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
  - [Linear's agent interaction guidelines](https://linear.app/developers/agent-interaction), the source of the activity states behind tool rows and presence.
- Design systems:
  - [Material 3's motion tokens](https://github.com/androidx/androidx/tree/androidx-main/compose/material3/material3/src/commonMain/kotlin/androidx/compose/material3/tokens), the source of six of the seven springs;
  - [IBM Carbon motion](https://carbondesignsystem.com/elements/motion/overview/), for productive versus expressive motion.
- Streaming: [Streamdown animation](https://streamdown.ai/docs/animation).
- The mascot ([ADR-0045](adr/0045-agent-mascot.md)), read on 2026-10-15; the findings are on #364:
  - [OpenAI's dots documentation](https://learn.chatgpt.com/docs/dots);
  - the Apple Design Awards [2024](https://www.apple.com/newsroom/2024/06/apple-announces-winners-of-the-2024-apple-design-awards/) and [2026](https://www.apple.com/newsroom/2026/06/apple-reveals-winners-of-the-2026-apple-design-awards/);
  - [Hermes Agent's StatusPulse](https://github.com/NousResearch/hermes-agent/blob/b51e8b850494e0a95a4b410c3d9b9a26df9ae261/apps/desktop/src/components/ui/status-pulse.tsx#L1-L130).
- The offline state ([ADR-0047](adr/0047-mascot-offline.md)), read on 2026-10-16; the findings are on #380:
  - [Chrome's offline dinosaur](https://blog.google/products/chrome/chrome-dino/), kept for offline only;
  - [Telegram's presence line](https://github.com/DrKLO/Telegram/blob/f32ffeec763f0bdbf4bec25b52d654f77bff733d/TMessagesProj/src/main/java/org/telegram/ui/Components/ChatAvatarContainer.java#L1582-L1620), replaced while it waits for the network;
  - [Slack's connection troubleshooting](https://slack.com/help/articles/205138367-Troubleshoot-connection-issues) and [Apple Watch's status icons](https://support.apple.com/en-us/108038).
- The bot's photo ([ADR-0046](adr/0046-telegram-bot-photo.md)), read on 2026-10-16; the findings are on #368:
  - Telegram's [profile videos](https://core.telegram.org/api/files) and [sticker rules](https://core.telegram.org/stickers);
  - Apple's [app icons](https://developer.apple.com/design/human-interface-guidelines/app-icons) and Android's [adaptive icons](https://developer.android.com/develop/ui/views/launch/icon_design_adaptive), on content in a round crop;
  - [Discord's reduced motion](https://support.discord.com/hc/en-us/articles/360040613412), which stills avatars outside the profile.
- The logo ([ADR-0049](adr/0049-logo-main-mascot-silhouette.md)), read on 2026-10-16; the findings and the reference-project check are on #385:
  - a mark that reduces the mascot, never replaced by it: [GitHub's logo](https://brand.github.com/foundations/logo) and [Mailchimp's brand assets](https://mailchimp.com/about/brand-assets/), with a reverse drawn for dark backgrounds;
  - small sizes: [Dropbox's logo](https://brand.dropbox.com/logo), a separate glyph at 32 px and below; [Discord's 2021 refresh](https://discord.com/blog/happy-blurpthday-to-discord-a-place-for-everything-you-can-imagine), blunt shapes for small surfaces; [Primer's icons](https://primer.style/foundations/icons), whole pixels and 1 px gaps;
  - [Copilot's Mico](https://thenextweb.com/news/microsoft-copilot-mico-retired-features-killed-app-merge), a mascot retired while the logo stayed;
  - favicons: [Safari 26's release notes](https://developer.apple.com/documentation/safari-release-notes/safari-26-release-notes), [WebKit bug 309949](https://bugs.webkit.org/show_bug.cgi?id=309949) and [Evil Martians' "How to Favicon in 2026"](https://evilmartians.com/chronicles/how-to-favicon-in-2021-six-files-that-fit-most-needs);
  - home-screen icons: [Apple's app icons](https://developer.apple.com/design/human-interface-guidelines/app-icons) and [web.dev on maskable icons](https://web.dev/articles/maskable-icon);
  - [invokta's favicon](https://github.com/vinilana/invokta/blob/f1e2f04f98c967ab4bb73bd02c3fa581f04ce0e5/apps/docs/public/favicon.svg#L1-L10), drawn apart from its mark, and [Hermes Agent's icon script](https://github.com/NousResearch/hermes-agent/blob/b65e078cdc77ebe83979a2d5355179535f340e89/scripts/generate_icons.py#L1-L90), every size from one master.
- The tab's count and the favicon's dot (5.9, 5.23), read on 2026-10-16; the findings and the reference-project check are on #389:
  - [Claude Code's agent view](https://code.claude.com/docs/en/agent-view), which counts the sessions awaiting input in the tab until each is answered;
  - [GitHub's pending favicon](https://github.githubassets.com/favicons/favicon-pending.svg), a static file with an amber dot in the bottom-right corner;
  - [Mattermost's title and favicons](https://github.com/mattermost/mattermost/blob/f5485a5c6e3c65542e35077cc6777ad197617709/webapp/channels/src/components/unreads_status_handler/unreads_status_handler.tsx#L102-L175), `(N) ` before the title and pre-made favicons swapped by `href`;
  - [Chromium's link element](https://github.com/chromium/chromium/blob/1ac7132d0190493dbeb52e8625ad8d3cfb25adca/third_party/blink/renderer/core/html/html_link_element.cc#L143-L151), which ignores setting the same `href` again;
  - [WebKit bug 266426](https://bugs.webkit.org/show_bug.cgi?id=266426), still open: Safari keeps the first favicon;
  - [Hermes Agent's session dot](https://github.com/NousResearch/hermes-agent/blob/848fc0ad8be766b9dc10fe42bd80b5fc2d45d95c/apps/desktop/src/app/chat/session-status-dot.tsx#L23-L37), one amber state for what needs the user, which never moves.
- The pups in the conversation's header ([ADR-0053](adr/0053-pups-in-the-conversation-header.md)), read on 2026-10-16; the findings and the reference-project check are on #403:
  - [Hermes Agent's subagent glyphs](https://github.com/NousResearch/hermes-agent/blob/848fc0ad8be766b9dc10fe42bd80b5fc2d45d95c/ui-tui/src/lib/subagentGlyph.ts#L16-L34), a shape for each status and never a success for an unknown ending;
  - figures kept apart while there is room: [Primer's avatar stack](https://primer.style/product/components/avatar-stack/) and [Fluent 2's avatar group](https://fluent2.microsoft.design/components/web/react/core/avatargroup/usage), which also asks for text beside a small badge;
  - closing a gap with transforms: [Motion's `popLayout`](https://motion.dev/docs/react-animate-presence) and [FLIP](https://aerotwist.com/blog/flip-your-animations/);
  - [WCAG 4.1.3 Status Messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html), for the polite count.
- The sidebar ([ADR-0052](adr/0052-webchat-presence-sockets.md), 5.9 and 5.24), read on 2026-10-16; the findings are on #378:
  - [Slack's notifications](https://slack.com/help/articles/360025446073), where only a mention gets a counted badge;
  - [Things 3](https://culturedcode.com/things/support/articles/2785159/) (Apple Design Award 2017), whose sidebar counts and never reorders;
  - [iOS 14's Messages](https://www.apple.com/newsroom/2020/06/apple-reimagines-the-iphone-experience-with-ios-14/), typing shown without moving the pinned contact;
  - [Linear's Inbox](https://linear.app/docs/inbox), its keys on the selected row, and [Linear's agent sessions](https://linear.app/developers/agent-interaction), where the server sets `awaitingInput`;
  - [Cursor's agents window](https://forum.cursor.com/t/agents-approval-window/170388) and [GitHub's agent sessions](https://github.blog/changelog/2026-03-26-agent-activity-in-github-issues-and-projects/);
  - [Hermes Agent's roster](https://github.com/NousResearch/hermes-agent/tree/848fc0ad8be766b9dc10fe42bd80b5fc2d45d95c/apps/desktop/src/plugins/hermes-bots): its still status mark and one place that settles states, adopted, and its polling and reordering, avoided.
- The agent's editor (5.25, 5.26, [ADR-0056](adr/0056-agent-editor-and-random-mascot.md)), read on 2026-10-16; the findings and the reference projects' check are on #379:
  - the trigger beside the figure: [ChatGPT's dots](https://help.openai.com/en/articles/20001530), [Duolingo's avatar creator](https://blog.duolingo.com/avatar-creator/) and [Memoji](https://support.apple.com/en-us/111115); [NN/g on contextual menus](https://www.nngroup.com/articles/contextual-menus-guidelines/), against a menu as the only way in;
  - the container: [Notion Faces](https://faces.notion.com), a grid next to a big preview, and [NN/g's bottom-sheet rules](https://www.nngroup.com/articles/bottom-sheet/);
  - a live preview: [Tolan](https://intercom.help/portola/en/articles/17508617-styling-your-tolan), [Apple Watch's face editor](https://support.apple.com/guide/watch/change-your-watch-face-apda6559ad78/11.0) and [Lily on Rive](https://rive.app/blog/duolingo-s-ai-powered-video-call-brings-lily-to-life); [ChatGPT pets](https://learn.chatgpt.com/docs/pets), a still frame under reduced motion;
  - the choices: the [APG radio group](https://www.w3.org/WAI/ARIA/apg/patterns/radio/) and [WCAG 2.5.8](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html);
  - saving: [Discord's unsaved-changes bar](https://support.discord.com/hc/vi/community/posts/4405364026903--Save-Changes-Hotkey-for-Server-Settings), made a quiet line, and [Benji Taylor's Family Values](https://benji.org/family-values);
  - tooltips: [Emil Kowalski's rules](https://github.com/emilkowalski/skills/blob/main/skills/emil-design-eng/SKILL.md), [Radix's Tooltip](https://www.radix-ui.com/primitives/docs/components/tooltip), [Primer's](https://primer.style/product/components/tooltip/), [Geist's](https://vercel.com/geist/tooltip), the HIG on [help](https://developer.apple.com/design/human-interface-guidelines/offering-help) and [undo](https://developer.apple.com/design/human-interface-guidelines/undo-and-redo), [WCAG 1.4.13](https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus.html), and [Linear's 2026 refresh](https://linear.app/now/behind-the-latest-design-refresh), against icons that replace labels;
  - [Hermes Agent's profile editor](https://github.com/NousResearch/hermes-agent/blob/9c002cb941de1e1708294d0cd58e060b6a417b5e/apps/desktop/src/plugins/hermes-bots/edit-profile-dialog.tsx): one Save and a dirty flag per section, adopted; its 64 px preview and its swatches named by their hex, avoided.
- The agent's own files (5.25, [ADR-0058](adr/0058-owner-edits-agent-files-from-the-webchat.md)), read on 2026-10-16 and checked again on 2026-10-17; the findings and the reference projects' check are on #381:
  - reading and editing: [VS Code's Markdown preview](https://code.visualstudio.com/docs/languages/markdown), synced by source line, and [iA Writer's preview](https://ia.net/writer/support/preview/modify-preview/modify-preview-windows) (ADA 2025 finalist), which keeps the place, adopted; [Obsidian's reading and editing views](https://obsidian.md/help/edit-and-read), its ⌘E and its icons, adapted, and its single glyph that flips, avoided; [Bear's hidden Markdown](https://community.bear.app/t/show-hide-markdown/49), avoided;
  - the memory: [Hermes Agent's memory store](https://github.com/NousResearch/hermes-agent/blob/4b1adbfe5d274c5dbfaa981fcc4dd68391867701/tools/memory_tool_store.py#L221-L254), its format, its 2,200 characters and its refusal past them;
  - installing: [Claude Code's plugins](https://code.claude.com/docs/en/discover-plugins) (Webby 2026), the details before the install; [Raycast's Store](https://manual.raycast.com/store); the App Store's Get, through [Flutter's recreation](https://docs.flutter.dev/cookbook/effects/download-button); [Hermes Agent's `skills_guard`](https://github.com/NousResearch/hermes-agent/blob/4b1adbfe5d274c5dbfaa981fcc4dd68391867701/tools/skills_guard.py#L150-L530), its categories as advice, and its one-click install that skips the review, avoided; [invokta's archive import](https://github.com/vinilana/invokta/blob/f1e2f04f98c967ab4bb73bd02c3fa581f04ce0e5/packages/create-invokta-engine/src/example.ts#L505-L549), fail closed;
  - saving: [ai-memory's conditional writes](https://github.com/akitaonrails/ai-memory/blob/52020da90131a5afea70a114a01e44a8e67b44f3/crates/ai-memory-mcp/src/server.rs#L7176-L7224) and its undo as a forward write, adopted; [Hermes Agent's blind `SOUL.md` write](https://github.com/NousResearch/hermes-agent/blob/4b1adbfe5d274c5dbfaa981fcc4dd68391867701/tui_gateway/methods_profiles.py#L386-L404), avoided.
- Removing a skill (5.25), read on 2026-10-18; the findings and the reference projects' check are on #438:
  - the verb: [Carbon's remove, distinct from delete](https://github.com/carbon-design-system/carbon-website/blob/5e9cd1da43c32d3d3b991dc947b427f674da61a8/src/pages/patterns/common-actions/index.mdx#L260-L264), adopted;
  - the pending state: [VS Code's Source Control](https://github.com/microsoft/vscode/blob/4a82da11e45fee7aa77017b2188b6a394f994074/extensions/git/src/repository.ts#L252-L263), a deleted file struck through among the staged changes, adopted with a note in words; [GitHub's web Delete file](https://docs.github.com/en/repositories/working-with-files/managing-files/deleting-files-in-a-repository), which goes straight to the commit, adopted; [Obsidian's plugin rows](https://obsidian.md/help/community-plugins), the control on the row, adapted without its confirmation;
  - undo over confirmation: [Apple's HIG on alerts](https://developer.apple.com/design/human-interface-guidelines/alerts), [NN/g on confirmation dialogs](https://www.nngroup.com/articles/confirmation-dialog/), [Primer's ConfirmationDialog](https://primer.style/product/components/confirmation-dialog/guidelines) and [WCAG 3.3.4](https://www.w3.org/WAI/WCAG22/Understanding/error-prevention-legal-financial-data.html);
  - [Hermes Agent's skill archive](https://github.com/NousResearch/hermes-agent/blob/a2ad0d5b639160fbb41b2bee8d1ca1e65e544c70/apps/desktop/src/app/learning/archive-skill-confirm-dialog.tsx#L56-L76): its reversible verb, adapted; its modal that Enter confirms and [its CLI's hard delete](https://github.com/NousResearch/hermes-agent/blob/a2ad0d5b639160fbb41b2bee8d1ca1e65e544c70/tools/skills_hub_install.py#L205-L224), avoided.
- Accessibility:
  - [WCAG 2.2.2 Pause, Stop, Hide](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html);
  - [WCAG 2.3.3 Animation from Interactions](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html);
  - [web.dev on prefers-reduced-motion](https://web.dev/articles/prefers-reduced-motion).
- The first review (ADR-0044), read on 2026-10-15; the findings and the reference-project check are on #358:
  - [the Webby Awards 2026 winners](https://www.webbyawards.com/press/press-releases/30th-annual-webby-awards-announce-2026-winners/), and [Claude Code's agent view](https://code.claude.com/docs/en/agent-view), the source of the state glyphs and of counting what waits in the tab title;
  - Apple Design Award winners: [Crouton](https://developer.apple.com/news/?id=9x75y43e), [Pine Hearts](https://developer.apple.com/news/?id=p9gxlwd0), [Guitar Wiz](https://developer.apple.com/news/?id=5zi5a25j), [grug](https://developer.apple.com/news/?id=ux44ymcr), [Tide Guide](https://developer.apple.com/news/?id=4r9b23wx);
  - [iA Writer's Authorship](https://ia.net/writer/support/editor/authorship), [Moonlock at Red Dot 2026](https://macpaw.com/news/moonlock-wins-red-dot-award-2026), [Google at Fast Company 2026](https://fastcompanybrasil.com/design/google-adidas-e-nordeste-vencem-premio-de-design-da-fast-company/);
  - craft: [Primer on loading](https://primer.style/product/ui-patterns/loading) and [degraded experiences](https://primer.style/product/ui-patterns/degraded-experiences), [Sonner](https://emilkowal.ski/ui/building-a-toast-component), [Vaul](https://emilkowal.ski/ui/building-a-drawer-component), [Atlassian on drag and drop](https://atlassian.design/components/pragmatic-drag-and-drop/design-guidelines), [MUI X Chat on scrolling](https://mui.com/x/react-chat/behavior/scrolling), [NumberFlow](https://number-flow.barvian.me), [Chrome on View Transitions](https://developer.chrome.com/docs/web-platform/view-transitions/same-document).
- The webchat's redesign (#140), read on 2026-10-15; the findings are on #140:
  - [Telegram Web A](https://github.com/Ajaxy/telegram-tt/tree/090e38f1dffec3e0a9aefbec8159a9931fbeec8f), the source of groups, day labels, the composer's limits and links that show where they go;
  - [Claude Code's accessibility](https://code.claude.com/docs/en/accessibility) and [interactive mode](https://code.claude.com/docs/en/interactive-mode), for the spoken labels and the queued messages;
  - [Apple Messages' delivery states](https://support.apple.com/guide/messages/ichtee6857f6/mac), [Streamdown's code blocks](https://streamdown.ai/docs/code-blocks), [Chromium's URL display guidelines](https://chromium.googlesource.com/chromium/src/+/main/docs/security/url_display_guidelines/url_display_guidelines.md) and [Geist's theme switcher](https://vercel.com/geist/theme-switcher);
  - [Cloudflare Access's session management](https://developers.cloudflare.com/cloudflare-one/identity/users/session-management/) and [WCAG 2.2.5 Re-authenticating](https://www.w3.org/WAI/WCAG22/Understanding/re-authenticating), for the expired login;
  - [Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/acc3cada0da86c81efc8aa6c5a291989549ca900), for the input-method guard, the phone's keyboard and the restored draft.
