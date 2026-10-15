# ADR-0043: Kelpie's interface follows one design system: the Mistura identity, with motion chosen by how often an interaction happens

- Status: Accepted
- Date: 2026-10-15
- Issue: [#356](https://github.com/guedesdiogo/kelpie/issues/356)
- Decided by the owner on 2026-10-15, after comparing three directions and a mix in a live motion lab: «podemos seguir 100% com o que definiu para mistura»

## Context

**Kelpie is about to grow an interface, and nothing ties its pages together.** Phase 3 brings the management UI (Epic 5), and the webchat waits for a redesign (#140). Today each page has its own look:
- the webchat uses the system font and a blue accent (`apps/ingress/public/webchat/style.css`);
- the secure forms use near-black buttons on near-white (`apps/admin-api/src/forms.ts`);
- the viability study leaves the stack of the management UI open.

**The owner asked for style and motion first, learned from award-winning work.** Motion in interactions is what he cares about most. Research on 2026-10-15 found:
- **Award-winning websites reward spectacle.** Awwwards' sites of the year 2023 to 2025 and the CSS Design Awards' run on full-screen WebGL, smooth-scroll hijacking and slow transitions. In all seven winners analyzed, usability was the lowest sub-score, and accessibility scored 6.6 to 7.6. The exception, Dropbox Brand (CSS Design Awards and Webby, 2025), layers motion that explains cause and effect over a calm base.
- **Apple's Interaction awards (2024 to 2026) go to interfaces that keep attention on the task.** Apple keeps delight in a separate category.
- **Teams known for craft publish rules.** Linear, Raycast and Emil Kowalski, Family, Vercel and Rauno Freiberg all tie motion to how often something happens. In their rules:
  - keyboard actions don't animate;
  - exits are faster than entries;
  - everything can be interrupted;
  - one element carries its states.
- **Mature design systems split motion in two and publish numbers.** Material 3 separates standard and expressive springs, and spatial and effect springs. IBM Carbon separates productive and expressive motion.

**Three directions and a mix were built as a live lab.** All of them ran the same eight Kelpie interactions:
- **Correnteza:** fluid, with springs that pass their target.
- **Pastoreio:** precise, with no bounce.
- **Bruma:** calm, with blur.
- **Mistura:** Correnteza's identity with Pastoreio's discipline, keeping Correnteza's springs for moments.

The owner chose Mistura.

**The reference projects agree on the rules and leave the moments to Kelpie.** Findings, with links pinned to commits, are on the issue.
- Hermes Agent's desktop app keeps a design document with tokens and "motion follows state; it never delays state".
- Its springs all sit near or above critical damping, so nothing there passes its target.
- It reserves amber for what needs the owner, and gives saving to memory a color of its own.
- Two things it does, Kelpie avoids:
  - it loops a working arc for a whole turn;
  - it animates its palette when opened with a key.
- ai-memory's viewer and invokta's devtools add an accessible approve pattern and a rule against coloring text with the accent.
- None of them paces replies or has a moment grammar.

## Decision

### 1. One design system, kept in `docs/design-system.md`

- **Its tokens and patterns are binding** for every page Kelpie serves.
- **A value is changed in that document,** in the same pull request as the code that uses it: a color, a size, a spring or a duration.
- **A principle takes a new ADR:** the two grammars, the ten rules or the reduced-motion policy.

### 2. The identity

- **Kelp colors.** The accent is a kelp green (`#0A7469` light, `#3BC3AE` dark), and attention a tan amber (`#915708`, `#EEAE4A`), on blue-green neutrals.
- **Every color is a token with a light and a dark value.** Its text contrast is measured and recorded, and it meets WCAG AA.
- **Type.** Bricolage Grotesque for display, Geist for text and Geist Mono for code, times and counts.
- **Fonts are self-hosted.** All three are under the SIL Open Font License, and they are served from Kelpie's own origin, which the webchat's content policy requires.

### 3. Motion follows how often an interaction happens

- **Two grammars.**
  - **Frequent** covers messages, streaming, tool rows, the board, lists, menus and the palette. It uses springs with a damping ratio of 0.9 (Material 3's standard values) and small distances.
  - **Moment** covers approving, turning on something that costs, delegating to subagents, saving to memory and agent presence. It uses springs with ratios from 0.8 down to 0.55, which pass their target a little, and gives each moment one signature effect.
- **Keyboard-triggered actions never animate.**
- **Ten rules apply to every animation** (`docs/design-system.md` §4.4). Among them:
  - a loop stops within 5 s and the state then reads without motion;
  - exits are faster than entries;
  - everything can be interrupted.
- **Reduced motion replaces, it doesn't erase.** Movement becomes a fade of at most 150 ms, and colors, focus, confirmations and progress stay.

### 4. How it's built, without choosing the stack

- **CSS first.** Tokens are custom properties, springs are `linear()` easings, and sequences use the Web Animations API.
- **View Transitions** handle navigation between views.
- **The Motion library** handles only what the owner drags with velocity.

These choices hold for whichever stack the management UI picks. This ADR doesn't pick it.

### 5. Open: how an agent looks

The presence states of an agent are decided (`docs/design-system.md` §5.9): working, waiting for the owner, idle and error.

The figure is not. On 2026-10-15 the owner asked for a customizable mascot instead of a photo in a circle, with its shape, color and eyes to choose. It would live in the conversation window, blinking, moving and hopping in place. Its concept is being designed for his approval and lands as an amendment to this ADR.

A mascot's idle life is ambient motion, so rule 8 (loops stop within 5 s) applies to it until that amendment says how it meets WCAG 2.2.2: a way to pause it, and a still mascot under reduced motion.

## Consequences

- **New pages build on the tokens.** The webchat redesign (#140) and the management UI start from them. The current webchat, forms and pairing pages keep their styles until a story moves them.
- **Self-hosted fonts add a few font files** to the Worker that serves the interface. They cost nothing beyond the Workers Paid plan.
- **Pull requests that change the interface answer the review checklist** in `docs/design-system.md` §7.
- **Award-site traits stay out of the product:** scroll hijacking, full-screen WebGL and slow in-and-out easing. A future landing page may use them.
- **The spring values come from a simulation.** Changing one means simulating it again and updating its stiffness, ratio, `linear()` and duration together.

## Alternatives considered

- **Correnteza alone.** It is the most memorable direction, but its overshoot on everything wears thin in a tool used all day.
- **Pastoreio alone.** It is fast and calm, but approving a cost or delegating to subagents would feel like any other click, and it loses the water spirit of the brand.
- **Bruma.** It is the quietest direction, but the moments that matter lose their weight, and blur costs on weak devices.
- **An award-winning website's language.** The research showed these sites score lowest on usability.
- **A stock design system** such as Material or shadcn/ui's defaults. It would not carry the brand. Material 3's spring values are adopted; its look is not.

## References

- [`docs/design-system.md`](../design-system.md): tokens, measured contrast, springs, patterns and the review checklist.
- Decisions the patterns build on:
  - [ADR-0011](0011-agent-task-board.md): the board;
  - [ADR-0024](0024-fixed-wait-end-of-turn.md): the wait before a reply;
  - [ADR-0026](0026-confirmation-by-owner-act.md): the owner's act as a yes;
  - [ADR-0036](0036-agent-roles-models-and-subagents.md): subagents;
  - [ADR-0039](0039-routines-as-vault-files.md): routines.
- #140, the webchat redesign.
- Research sources are listed in `docs/design-system.md` §8.
