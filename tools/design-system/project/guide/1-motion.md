# Motion

Section 4 of `docs/design-system.md`. Token names here carry their CSS `--` prefix.

## 4.1 Two grammars

Motion depends on how often an interaction happens, not on which screen it is in.

| Grammar | Applies to | Character |
|---|---|---|
| **Frequent** | Messages, streaming, tool rows, the task board, lists, menus, the palette, navigation | Fast, no visible overshoot, small distances, tight stagger |
| **Moment** | Confirming an action, turning on something that costs, delegating to subagents, saving to memory, agent presence changes | Springs that pass their target a little, larger distances, and a signature: a parent's pups, the ring of a confirmation, the arc into the vault, a mascot's announcement |

**The mascot's life in place** (breathing, blinking, its repertoire) is not UI motion in either grammar. It uses the frequent springs, runs under its own guards, and is the one exception to rule 8 (5.19, ADR-0045 §6).

**From the keyboard**, anything opened, moved or navigated appears at once. What shows progress or a result still shows: a hold fill grows while the key is held, and a confirmation still turns `--ok` and shows its check, without the grow, the pop or the ring. A mascot whose state a keyboard action changes takes the new pose without its announcement.

## 4.2 Springs

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

## 4.3 Durations, curves and distances

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

## 4.4 Rules

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

## 4.5 Sound

Sound is opt-in and off by default ([ADR-0044](https://github.com/guedesdiogo/kelpie/blob/main/docs/adr/0044-design-system-review.md) §4).
- **Only three sounds:** an action was confirmed, something was saved to memory, an agent needs the owner. Each lasts under 300 ms.
- **They have a setting of their own,** separate from the less-motion switch.
- **A frequent action never makes a sound.**
- **Browser notifications** are opt-in the same way. Only "an agent needs you" raises one, and only while Kelpie's tab is hidden.
- **The mascot makes no sound.** Its snores and sighs are drawn (ADR-0045 §6).
- **No vibration.**

## 5.14 Moving between views

Frequent.

- **From a list to a detail,** the agent's mascot, in its box, and its name travel to their new place with a View Transition (`--spring-base`), and the rest crossfades.
- **Back** reverses the direction.
- **From the keyboard,** and in a browser without View Transitions, the view changes at once.
- **A streaming chat** is never part of the transition.
- **Reduced motion:** a crossfade only.
