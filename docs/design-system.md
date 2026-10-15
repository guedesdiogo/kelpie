# Design system

Kelpie's interface follows one visual identity and one motion system, decided in [ADR-0043](adr/0043-design-system.md) and extended by its first review in [ADR-0044](adr/0044-design-system-review.md). This document holds the values. A page, component or animation takes its colors, type, spacing, radii and motion from the tokens below. A literal number is allowed only where a pattern in section 5 sets it.

The direction is called **Mistura** ("mix"): the identity of the water spirit (kelp colors, shapes that change) with the discipline of the herding dog (Pastoreio, "herding": fast, grouped, no bounce). What the owner does a hundred times a day moves quickly and plainly. The moments that matter (approving, spending, delegating, remembering) get the expressive motion.

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
| `--line` | `#C2D2CE` | `#21403B` | Borders and dividers. Decorative: a control's boundary uses `--muted` |
| `--accent` | `#0A7469` | `#3BC3AE` | Kelp: primary actions, the owner's bubbles, focus, links, progress |
| `--on-accent` | `#F0FAF8` | `#03201B` | Text and icons on `--accent` |
| `--warm` | `#915708` | `#EEAE4A` | Attention: the owner needs to act (an agent is waiting, a free tier is near its end). Nothing else uses it |
| `--ok` | `#1B7C45` | `#55C585` | Done, approved, turned on |
| `--danger` | `#BA3A27` | `#F07461` | Errors, refusals that need action |

- **Text on `--ok`** uses `--surface`, so it inverts with the theme.
- **Text on a tint** (a highlight, a hold fill) is `--fg`. Text on a solid fill uses that fill's own text color: `--on-accent` on `--accent`, `--surface` on `--ok`.
- **Tints** come from `color-mix()` with a token, never from a new literal: a focus halo is `--accent` at 18%, a hold-to-confirm fill `--accent` at 28%, a card that just landed `--accent` at 22%, a text highlight `--accent` at 24%, a receipt icon well `--ok` at 16%, a scrim `--fg` at 16%.
- **Shadows** are black at low alpha in both themes: `--shadow` is `0 1px 2px rgb(0 0 0 / .06), 0 14px 30px -18px rgb(0 0 0 / .38)`, and `--shadow-pop` (palettes, menus) is `0 18px 40px -16px rgb(0 0 0 / .5)`.

### Higher contrast

With `prefers-contrast: more`, or Kelpie's own contrast setting (5.17), two tokens change, and tints give way to solid fills and borders:

| Token | Light | Dark | Measured |
|---|---|---|---|
| `--line` | `#6B8480` | `#557570` | 3.41 / 3.82 / 3.11 in light, 3.69 / 3.37 / 3.57 in dark, on `--bg` / `--surface` / `--sunken` |
| `--muted` | `#344B48` | `#A5BEB9` | 7.94 / 8.90 / 7.25 in light, 9.45 / 8.64 / 9.14 in dark |

Every boundary then reaches 3:1, and secondary text 7:1. `--accent`, `--warm`, `--ok` and `--danger` keep their AA values (section 1's table), so text in those colors stays at 4.5:1, not 7:1.

With `prefers-reduced-transparency: reduce`, scrims and tints become solid fills. In `forced-colors` mode the system's colors replace the tokens, and the state glyphs of 5.9 carry the meaning that color would.

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

Four pairs miss AA in light, so text never uses them: `--accent`, `--ok` and `--danger` on `--sunken`, and `--ok` on `--bg`. There, the text is `--fg`, and the color moves to an underline or an icon (icons need 3:1, which all four pass).

`--line` on `--surface` is 1.49 in light and 1.51 in dark, below the 3:1 a control's boundary needs (WCAG 1.4.11). Inputs, checkboxes and the hold button draw their boundary in `--muted` (5.90 and 6.30 on `--surface`), and a selected item also changes its fill.

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

### Voice

Kelpie writes the way a capable colleague talks.
- **Say what happened, then what to do.** "No connection. Trying again in 8 s." Not "Oops! Something went wrong."
- **Name things by what the owner knows.** A routine, a task, the vault. Never a table, a Durable Object or a queue.
- **No apologies, no exclamation marks, no whimsical verbs.** A phase says what is being done: "Reading people/ana-souza.md".
- **Empty states explain in one sentence why they are empty**, and offer the one action that fills them.
- **Receipts say who did what and when,** in the owner's time zone.

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
| **Moment** | Confirming an action, turning on something that costs, delegating to subagents, saving to memory, agent presence changes | Springs that pass their target a little, larger distances, and a signature: the drop of a subagent, the ring of a confirmation, the arc into the vault |

**From the keyboard**, anything opened, moved or navigated appears at once. What shows progress or a result still shows: a hold fill grows while the key is held, and a confirmation still turns `--ok` and shows its check, without the grow, the pop or the ring.

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
| `--spring-slow` | 300 / 0.9 | 31.2 | 197 ms | 394 ms | 0.1% | Large surfaces, drawers |
| `--spring-moment-fast` | 800 / 0.6 | 33.9 | 83 ms | 393 ms | 9.2% | A released hold, small moment feedback |
| `--spring-moment` | 380 / 0.8 | 31.2 | 153 ms | 457 ms | 1.4% | Moment layout: a button that grows, a card that collapses |
| `--spring-moment-slow` | 200 / 0.8 | 22.6 | 211 ms | 611 ms | 1.4% | Travel: subagents leaving their parent, links drawing |
| `--spring-pop` | 800 / 0.55 | 31.1 | 79 ms | 471 ms | 12.3% | Confirmations: a check, a vault that receives, an avatar that changes state |

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
5. **Things come from where they start.** A popover grows from its trigger, a task comes out of its routine, a note leaves the sentence and enters the vault. A dialog stays centered.
6. **One element carries the states.** The same button goes from "Confirm" to "Creating" to a receipt; the same bubble goes from typing to the reply. Nothing is swapped for a different element in another place.
7. **Streaming is calm.** Only new words appear, with opacity alone, in `--dur-word`. Nothing animates layout per token, and the word wrappers are removed when the stream ends. Phases have their real names, the elapsed time appears after 3 s, and progress is never faked.
8. **Motion announces a change; a state stays still.**
   - A loop stops within 5 s. From then on, a state shows through color, shape and text.
   - The one exception is the mascot's idle life, under its own guards (ADR-0045 §6).
   - An elapsed time shows that an agent is still working. It updates once a second, or once a minute under the less-motion switch: that is the control WCAG 2.2.2 asks of information that updates by itself.
   - A spinner appears only after 150 to 300 ms of waiting and stays at least 300 ms.
9. **Leaving is faster than arriving.** Entries use springs; exits use `--dur-exit` or `--dur-exit-moment` with `--ease-exit`.
10. **Reduced motion replaces, it doesn't erase.**
    - The trigger is `prefers-reduced-motion: reduce`, or Kelpie's own switch for less motion, for people who don't want to change their system.
    - Movement and scale become opacity, in at most `--dur-fade`. Colors, focus, confirmations and progress stay. Loops are still.
    - This also meets WCAG 2.3.3 (level AAA): motion from interactions can be turned off.

Two engineering rules come with them:
- in anything that runs daily, animate only `transform`, `opacity` and color. The exceptions are the contained size changes in 5.1, 5.2, 5.3, 5.9, 5.17 and 5.18, and the one mask reveal in 5.7;
- never write `transition: all`.

### 4.5 Sound

Sound is opt-in and off by default ([ADR-0044](adr/0044-design-system-review.md) §4).
- **Only three sounds:** an action was confirmed, something was saved to memory, an agent needs the owner. Each lasts under 300 ms.
- **They have a setting of their own,** separate from the less-motion switch.
- **A frequent action never makes a sound.**
- **Browser notifications** are opt-in the same way. Only "an agent needs you" raises one, and only while Kelpie's tab is hidden.
- **No vibration.**

## 5. Patterns

Each pattern names its grammar, its numbers and what it becomes under reduced motion. "Exit" means the grammar's exit duration and curve.

### 5.1 Paced replies

Frequent. Kelpie waits `quietMs` after the owner's latest message before answering ([ADR-0024](adr/0024-fixed-wait-end-of-turn.md)).

- **The owner's message.** It enters from below the composer (`--rise`, `--scale-in`, `--spring-base`, origin at the bottom right), and the bubbles above slide up with it (FLIP, `--spring-base`).
- **Held messages.** While the buffer holds them, each of the owner's messages carries a small clock in `--muted` under it, "held". The bubble itself doesn't change, so its text keeps its contrast. The mark fades out (`--dur-fade`) when the turn starts reading them.
- **The wait.** A 3px bar under the thread shows it, wherever the interface knows the buffer's deadline. The webchat learns it from one new socket message, added with its redesign (#140). ADR-0043 amends ADR-0024 for this; before, nothing showed during the wait.
  - The bar follows the buffer's real deadline: `quietMs` after the latest message, capped by `maxWaitMs` from the first.
  - A new message refills it in the first 7% of the time, then it drains linearly.
  - While the webchat holds the answer because the owner is still typing, the bar stays full. It drains toward the `maxWaitMs` deadline once that comes first.
  - With `quietMs: 0` there is no wait and no bar.
- **Typing.** When the wait ends, a typing bubble appears. Its dots blink in steps, 0.8 s per cycle, for five cycles. Then they rest at 60% opacity until the reply comes.
- **The reply.** It takes the typing bubble's place in the same element: its width and height go to the reply's size (`--spring-base`), and the text fades in after 70 ms.
- **Reduced motion:**
  - bubbles fade in where they land;
  - the bar still drains, since it is progress;
  - the dots rest at 60% from the start.

### 5.2 Tool calls and streaming

Frequent.

- **The row.** It appears when a call starts, with the call's real name. A call that changes something carries a "changes" tag beside its name; a call that only reads carries none.
- **Each new action** replaces the label above it: the old label leaves upward (exit, 75% of its height), and the new one rises with `--spring-fast`.
- **The spinner** follows rule 8, and turns for at most 5 s. After that, a still ring and the elapsed time (shown from 3 s) say the call is running.
- **Done**, the row becomes a one-line summary ("3 steps · 2.6 s") with a check. A click opens it: height with `--spring-base`, rows entering with `--stagger`.
- **Typed results.** A result with a known type (an event, a file, a table, a link) shows as a card of that type, not as running text. The card enters with `--rise` and `--spring-base`, or with a fade under reduced motion.
- **Streamed text** follows rule 7.
- **Reduced motion:**
  - labels swap with a fade;
  - the spinner is a still ring;
  - the summary opens at once.

### 5.3 Confirm an action

Moment. The owner's press is the yes ([ADR-0026](adr/0026-confirmation-by-owner-act.md)). A confirmation nobody answers expires after its 10 minutes (ADR-0026 §3), and its card collapses into an "expired" receipt with a neutral icon.

- **Decide in place.** The card names the agent that asks by its id, and its task by number ("`agenda` asks, on task #123"). A task's title, written by the agent, may follow only as quoted data. It carries what the owner needs to decide without leaving it: the event, the diff, the cost. For a write to memory, that is the operation, the note's path, its text, and a warning when it replaces an existing note.
- **Three answers** ([ADR-0044](adr/0044-design-system-review.md)):
  - **Confirm**, the primary button;
  - **Deny this call**, beside it. It closes the confirmation, and the agent goes on without that change;
  - **Hold to pause this conversation**, a smaller control under them. It uses the hold of 5.4 and runs the existing pause (#134): the next answer waits for the owner's next message, and background tasks keep running.
- **What the card shows is bounded** (ADR-0044 §1). The agent is named by its id. The evidence comes from the tool call's typed fields, appears as quoted data marked as written by the agent, and never carries a link or a control.
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
- **Reduced motion:** the grow, the pop and the ring go. The color change, the check and the receipt stay, each with a fade.

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
- **An agent takes the task.** Its avatar enters on the card (`--scale-in`, `--spring-fast`), and the card travels to the next column (FLIP, `--spring-base`). A progress bar fills only from real progress.
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

Moment. Subagents are temporary and never exceed their creator ([ADR-0036](adr/0036-agent-roles-models-and-subagents.md)).

- **The parent pulses** (`scale` 0.9 to 1, `--spring-pop`).
- **Each subagent leaves the parent as a drop**, under an SVG "goo" filter on one layer (Gaussian blur 7, alpha matrix 20 / −9). It travels to its place with `--spring-moment-slow`, `--stagger-moment` apart.
- **A link draws** from the parent (stroke offset, `--spring-moment-slow`, 60 ms later), and the label enters 8px from the left, 140 ms later.
- **When it is done**, it travels back and fades into the parent. The link retracts, and the parent swallows it (`scale` 1.12 to 1, `--spring-pop`, at 55% of the return).
- **Reduced motion:** subagents and links fade in and out at their places, without the goo.

### 5.7 Saved to memory

Moment.

- **The highlight.** The learned phrase gets a highlight that grows from its start (`--accent` at 24%, `--spring-moment`). It is not `--warm`: remembering asks nothing of the owner.
- **The chip.** A chip with the real file path, such as `people/ana-souza.md`, lifts from the phrase (`--rise-moment`, `--scale-in-moment`). It travels in `--dur-travel` (`--ease-travel`) along an arc 60px above the straight line to the vault, shrinking to 0.35 and fading over the last 18%.
- **The vault** pops (`scale` 1.14 to 1, `--spring-pop`), and its count rolls.
- **The toast** (5.13) says where the note went, from which conversation, when and by which agent: "Saved to `people/ana-souza.md` · From this conversation, today at 14:32 · by Kelpie". It offers Open and Undo for 10 s. Undo sends the chip back along the same arc and takes the highlight away. In the vault, Undo writes a new version that removes the note; history keeps both.
- **Each note keeps its origin.** The vault shows who wrote each passage, from a write log rather than markers in the file: the owner, an agent or an import.
- **Off the record.** A conversation can be marked so nothing from it enters the vault.
- **A new note appears as ink.** Its text reveals left to right under a mask, over `--dur-travel`. Only a new note does this; chat keeps rule 7.
- **Reduced motion:** the highlight fades in, the chip fades out where it is, the count changes with a fade, and a new note appears whole.

### 5.8 Command palette

Frequent, and the clearest case of rule 1.

- **Opened by a click**, it grows from its trigger: `scale` 0.97 and 6px above, to 1, with `--spring-fast`. The scrim fades in `--dur-fade`.
- **Opened with ⌘K or Ctrl K**, it appears at once. Arrow keys, filtering, Enter and Escape are instant too.
- **Only the pointer animates.** Hovering moves the highlight with `--spring-fast`. A pointer that hasn't moved since the palette opened doesn't move the highlight.
- **Closed by a click**, it leaves in `--dur-exit`.
- **Reduced motion:** a click opens and closes it with a fade, and the highlight jumps.

### 5.9 Agent presence

Moment grammar: the roster is where Kelpie spends its novelty.

| State | Shows | Motion |
|---|---|---|
| Working | `--accent` ring, elapsed time `m:ss` | The ring turns three times, 1.4 s each, then stops |
| Waiting for the owner | `--warm` ring, "waiting for you", time since | A halo pulses three times, 1.6 s each, then stops |
| Idle | Avatar at 45% opacity, grayscale; a mascot keeps its color and dozes after 45 s (ADR-0045) | None for the avatar; a mascot breathes and draws idle gestures (ADR-0045 §6) |
| Error | `--danger` ring, what failed | One shake, 380 ms |
| No response | Dashed `--muted` ring, "no response for 1 min" | None |

- **Each state has a glyph** beside its label, so it reads without color or motion: a half-filled circle for working, a diamond for waiting, a hollow circle for idle, a dashed circle for no response, a triangle for error. The glyphs are drawn as SVG, since Geist has no such characters, and are hidden from screen readers, which read the label.
- **No response** is a working agent from which nothing has arrived for 60 s: no streamed token, and no tool call starting or ending. A tool call still within its time bound counts as activity.
- **On a change**, the avatar pops (`scale` 0.86 to 1, `--spring-pop`), and the status line rolls.
- **What waits for the owner is counted, not moved.**
  - A strip above the roster counts the agents waiting, in `--warm`. Its count rolls. It enters with `--rise`, and leaves when nothing waits. Its slot above the roster is reserved, so the rows never move when it appears.
  - The browser tab's title starts with the count, "(2) Kelpie", and the favicon gets a `--warm` dot.
  - A free tier past 90% joins the count (5.16).
- **A row opens in place.** Pressing a waiting agent's row grows its request under the row (height, `--spring-moment`), with the card of 5.3. From the keyboard it appears at once.
- **Finished work leaves; failures stay.** A subagent or task that succeeded leaves a list at once. One that failed stays 30 s with its `--danger` ring, and can be dismissed.
- **An agent is compared with itself.** Its numbers sit against its own last 30 days, never in a ranking of agents.
- **The roster never reorders** when a state changes: a list that jumps under the pointer costs a misclick.
- **How the agent itself looks:** a plush mascot the owner customizes (ADR-0045). Its section lands with its code; until then, agents keep the avatar.
- **Reduced motion:** rings and halos are still; color, shape and the status text carry the state. The elapsed time shows minutes only ("2 min") and updates once a minute. The strip and an opening row appear with a fade, and counts change with a fade.

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

- **The first 2 s change nothing.**
- **The banner.** Then a banner enters at the top (from 8px above, `--spring-base`): what happened, when the next try is ("No connection. Trying again in 8 s", digits in Geist Mono), and "Try now".
- **Queued messages.** What the owner sends meanwhile shows in `--sunken` with a clock and "queued". It goes out in order when the connection is back.
- **Back,** the banner turns `--ok`, "Back. 1 message sent.", for 2.6 s, then leaves. Alerts stay quiet for the first 4 s after reconnecting, so a backlog doesn't arrive as a burst.
- **An expired login** opens a centered dialog to sign in again, and keeps the draft.
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

- **From a list to a detail,** the agent's avatar and name travel to their new place with a View Transition (`--spring-base`), and the rest crossfades.
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

- **Comfort comes first.** Before anything else, one step sets motion (full or less), text size and contrast. That is where the less-motion switch of rule 10 lives. The step can be reopened in settings.
- **The first agent.**
  - Until it exists, the empty state says in one sentence why the roster is empty, and offers one button.
  - When it is created, its avatar enters its slot with `--spring-pop`, and the empty block collapses with `--spring-moment`.
- **Channels and secrets** are asked at the step that needs them, not up front.
- **Reduced motion:** fades.

### 5.18 Finished work folds into its receipt

Moment.

- **When a conversation or task finishes,** its detail folds into a summary in one movement: height, and a vertical scale to 0.98, with `--spring-moment`.
- **The summary** lists the real vault paths the work used, as links.
- **Reduced motion:** a fade.

## 6. Implementation notes

- **CSS first.** Tokens are custom properties. Springs are the `linear()` values above, supported in every current browser. Enter and exit use transitions with `@starting-style`. Choreographed sequences use the Web Animations API, which takes the same easings.
- **View Transitions** fit navigation between views. They never wrap a list that streams.
- **The Motion library** fits only where the owner drags something with velocity, such as reordering the board. It is loaded with the page that needs it.
- **An entrance plays once.** It is keyed to the element, so a streaming update never replays it. It never leaves content at opacity 0 if the animation doesn't run, which happens when a background tab pauses timelines. A list animates entries only up to 60 rows; past that, rows appear at once.
- **Heavy effects stay off the DOM's per-frame path.** The goo is one SVG filter on one layer, during a moment. Anything heavier belongs in a shader scoped to its element, or nowhere. Full-screen WebGL stays out of the product.
- **The stack is still open.** These choices guide whatever UI stack Kelpie picks; the [viability study](viability-study.md) lists it among its open questions.

## 7. Review checklist

A pull request that changes the interface answers yes to each line:

- [ ] Every color, size, radius, duration and easing comes from a token, unless a pattern in section 5 sets the number.
- [ ] Only `transform`, `opacity` and color animate, apart from the contained sizes in 5.1, 5.2, 5.3, 5.9, 5.17 and 5.18 and the mask reveal in 5.7; no `transition: all`.
- [ ] Keyboard-triggered actions don't animate their way in or out; progress and results still show.
- [ ] Loops stop within 5 s, and the steady state reads without motion.
- [ ] Exits are faster than entries, and staggers stop at 300 ms.
- [ ] Interrupting an animation leaves no element stuck halfway.
- [ ] Under reduced motion, every movement becomes a short fade, and no feedback disappears.
- [ ] New text meets the contrast in section 1, in both themes and in higher contrast, and controls draw their boundary in `--muted`.
- [ ] `--warm` appears only where the owner must act, and a toast only where 5.13 allows one.
- [ ] Copy follows the voice in section 2.

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
- glows or ambient motion that loop;
- a character that wanders the screen;
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
- Accessibility:
  - [WCAG 2.2.2 Pause, Stop, Hide](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html);
  - [WCAG 2.3.3 Animation from Interactions](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html);
  - [web.dev on prefers-reduced-motion](https://web.dev/articles/prefers-reduced-motion).
- The first review (ADR-0044), read on 2026-10-15; the findings and the reference-project check are on #358:
  - [the Webby Awards 2026 winners](https://www.webbyawards.com/press/press-releases/30th-annual-webby-awards-announce-2026-winners/), and [Claude Code's agent view](https://code.claude.com/docs/en/agent-view), the source of the state glyphs and of counting what waits in the tab title;
  - Apple Design Award winners: [Crouton](https://developer.apple.com/news/?id=9x75y43e), [Pine Hearts](https://developer.apple.com/news/?id=p9gxlwd0), [Guitar Wiz](https://developer.apple.com/news/?id=5zi5a25j), [grug](https://developer.apple.com/news/?id=ux44ymcr), [Tide Guide](https://developer.apple.com/news/?id=4r9b23wx);
  - [iA Writer's Authorship](https://ia.net/writer/support/editor/authorship), [Moonlock at Red Dot 2026](https://macpaw.com/news/moonlock-wins-red-dot-award-2026), [Google at Fast Company 2026](https://fastcompanybrasil.com/design/google-adidas-e-nordeste-vencem-premio-de-design-da-fast-company/);
  - craft: [Primer on loading](https://primer.style/product/ui-patterns/loading) and [degraded experiences](https://primer.style/product/ui-patterns/degraded-experiences), [Sonner](https://emilkowal.ski/ui/building-a-toast-component), [Vaul](https://emilkowal.ski/ui/building-a-drawer-component), [Atlassian on drag and drop](https://atlassian.design/components/pragmatic-drag-and-drop/design-guidelines), [MUI X Chat on scrolling](https://mui.com/x/react-chat/behavior/scrolling), [NumberFlow](https://number-flow.barvian.me), [Chrome on View Transitions](https://developer.chrome.com/docs/web-platform/view-transitions/same-document).
