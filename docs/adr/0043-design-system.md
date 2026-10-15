# ADR-0043: Kelpie's interface follows one design system: the Mistura identity, with motion chosen by how often an interaction happens

- Status: Accepted
- Date: 2026-10-15
- Issue: [#356](https://github.com/guedesdiogo/kelpie/issues/356)
- Decided by the owner on 2026-10-15, after comparing three directions and a mix in a live motion lab: «podemos seguir 100% com o que definiu para mistura»
- Amends: [ADR-0024](0024-fixed-wait-end-of-turn.md), the wait before a reply shows where the interface knows its deadline (§5)
- Amended by: [ADR-0044](0044-design-system-review.md), the first review adds patterns and a fifth presence state, "no response"
- Amended by: [ADR-0045](0045-agent-mascot.md), each agent is a plush mascot (§6), with an exception to rule 8 for its life in place

## Context

**Kelpie is about to grow an interface, and nothing ties its pages together.** Phase 3 brings the management UI (Epic 5), and the webchat waits for a redesign (#140). Today each page has its own look:
- the webchat uses the system font and a blue accent (`apps/ingress/public/webchat/style.css`);
- the secure forms use near-black buttons on near-white (`apps/admin-api/src/forms.ts`);
- the viability study leaves the stack of the management UI open.

**The owner asked for style and motion first, learned from award-winning work.** Motion in interactions is what he cares about most. Research on 2026-10-15 found:
- **Award-winning websites reward spectacle.**
  - The Awwwards sites of the year we looked at ([Lusion, 2023](https://www.awwwards.com/annual-awards/hall-of-fame/2023); [Igloo Inc, 2024](https://www.awwwards.com/annual-awards/hall-of-fame/2024); [Lando Norris, 2025](https://www.awwwards.com/annual-awards/winners)) run on full-screen WebGL, smooth-scroll hijacking or slow transitions.
  - In the winner we read closely, usability came lowest among the jury's scores: Lando Norris, site of the year 2025, scored [7.9 for usability](https://www.awwwards.com/sites/lando-norris), below design, creativity and content, and 7.00 for accessibility.
  - The exception was Dropbox Brand, the [CSS Design Awards' website of the year](https://www.cssdesignawards.com/blog/2025-website-of-the-year-winners/430/) and the [Webby for best user experience](https://winners.webbyawards.com/winners/websites-and-mobile-sites/features-design/best-user-experience) in 2025. It layers motion that explains cause and effect over a calm base.
- **Apple's Interaction awards (2024 to 2026) go to interfaces that keep attention on the task.** Apple keeps delight in a separate category.
- **Practitioners tie motion to how often something happens.**
  - Emil Kowalski's rules remove animation from what is used a hundred times a day and from anything triggered by the keyboard.
  - Benji Taylor's essay on Family says delight grows as frequency falls, and that one element should carry its states.
  - Rauno Freiberg asks that everything be interruptible.
  - Vercel's guidelines limit animation to `transform` and `opacity`, and time spinners.
  - Linear's agent guidelines model an agent's work as activities, the source of Kelpie's tool rows and presence states.
- **Mature design systems split motion in two and publish numbers.** Material 3 separates standard and expressive springs, and spatial and effect springs. IBM Carbon separates productive and expressive motion.

**Three directions and a mix were built as a live lab.** All of them ran the same eight Kelpie interactions:
- **Correnteza** ("current"): fluid, with springs that pass their target.
- **Pastoreio** ("herding"): precise, with no bounce.
- **Bruma** ("mist"): calm, with blur.
- **Mistura** ("mix"): Correnteza's identity with Pastoreio's discipline, keeping Correnteza's springs for moments.

The owner chose Mistura.

**The reference projects agree on the rules and leave the moments to Kelpie.** Findings, with links pinned to commits, are on the issue.
- Hermes Agent's desktop app keeps a design document with tokens and "motion follows state; it never delays state".
- Its springs all sit near or above critical damping, so nothing there passes its target.
- It reserves amber for what needs the owner, and gives saving to memory a color of its own.
- Two things it does, Kelpie avoids:
  - it loops a working arc for a whole turn;
  - it animates its palette when opened with a key.
- ai-memory's viewer adds an accessible pattern for approvals: buttons disable while posting, and a live region announces the result.
- invokta's documentation site forbids coloring text with its accent. Kelpie allows accent text only where it passes AA.
- None of them paces replies or has a moment grammar.

## Decision

### 1. One design system, kept in `docs/design-system.md`

- **Its tokens and patterns are binding** for every new or redesigned page Kelpie serves.
- **A value is changed in that document,** in the same pull request as the code that uses it: a color, a size, a spring or a duration.
- **A principle takes a new ADR:** the two grammars, the ten rules or the reduced-motion policy.

### 2. The identity

- **Kelp colors.** The accent is a kelp green (`#0A7469` light, `#3BC3AE` dark), and attention a tan amber (`#915708`, `#EEAE4A`), on blue-green neutrals. Amber means one thing: the owner needs to act.
- **Every color is a token with a light and a dark value.** Text contrast is measured and recorded, and every text pair the document allows meets WCAG AA.
- **Type.** Bricolage Grotesque for display, Geist for text and Geist Mono for code, times and counts.
- **Fonts are self-hosted.** All three are under the SIL Open Font License, and each page serves them from its own origin.

### 3. Motion follows how often an interaction happens

- **Two grammars.**
  - **Frequent** covers messages, streaming, tool rows, the board, lists, menus and the palette. It uses Material 3's standard springs (damping ratio 0.9) and small distances.
  - **Moment** covers confirming an action, turning on something that costs, delegating to subagents, saving to memory and agent presence. It uses springs with ratios from 0.8 down to 0.55, which pass their target a little, and larger distances.
- **From the keyboard, nothing animates its way in or out.** Progress and results still show.
- **Ten rules apply to every animation** (`docs/design-system.md` §4.4). Among them:
  - a loop stops within 5 s and the state then reads without motion;
  - exits are faster than entries;
  - everything can be interrupted.
- **Reduced motion replaces, it doesn't erase.** Movement becomes a fade of at most 150 ms, and colors, focus, confirmations and progress stay. Each pattern says what it becomes.

### 4. How it's built, without choosing the stack

- **CSS first.** Tokens are custom properties, springs are `linear()` easings, and sequences use the Web Animations API.
- **View Transitions** handle navigation between views.
- **The Motion library** handles only what the owner drags with velocity.

These choices hold for whichever stack the management UI picks. This ADR doesn't pick it.

### 5. The wait before a reply shows (amends ADR-0024)

ADR-0024 says nothing shows during the wait. The owner approved the lab's version instead: a thin bar that drains until Kelpie answers.
- **Where it shows.** Wherever the interface knows the buffer's deadline: the webchat and the management UI.
- **What it follows.** The real deadline: `quietMs` after the latest message, capped by `maxWaitMs` from the first.
- **During the webchat's typing hold**, the bar stays full until the owner stops typing, or drains toward the `maxWaitMs` deadline once that comes first.
- **With `quietMs: 0`**, there is no bar.

The rest of ADR-0024 stands: nothing starts before the wait ends, and "typing" appears when the model starts answering.

### 6. Open: how an agent looks

The presence states of an agent are decided (`docs/design-system.md` §5.9): working, waiting for the owner, idle and error.

The figure is not. On 2026-10-15 the owner asked for a customizable mascot instead of a photo in a circle, with its shape, color and eyes to choose. It would live in the conversation window, blinking, moving and hopping in place. Its concept is being designed for his approval and lands as an amendment to this ADR.

A mascot's idle life is ambient motion, so rule 8 (loops stop within 5 s) applies to it until that amendment says how it meets two rules:
- **WCAG 2.2.2:** a way to pause, stop or hide anything that moves for more than 5 s;
- **rule 10:** a still mascot under reduced motion, whose state still reads.

### 7. What isn't defined yet starts from award-winning work

The owner, on 2026-10-15: «sempre que for criar algo novo fazer essa pesquisa sobre plataformas premiadas em UX/UI para definir como vamos criar nosso componente, sempre buscando animações, motions nas iterações além de buscar a melhor usabilidade. Não quero nada do padrão que todo mundo usa».

- **When it applies.** A component, screen, state or interaction that `docs/design-system.md` doesn't define.
- **What comes first.** Research into award-winning UX and UI work, for motion in interactions and for usability.
- **Where the findings go.** On the issue, as adopt, adapt or avoid.
- **Where the result goes.** Into the design system, in the same pull request.
- **What it never settles for.** A library's default look.

The steps are in `docs/design-system.md` §8, and the rule is in `CLAUDE.md`.

## Consequences

- **New pages build on the tokens.** The webchat redesign (#140) and the management UI start from them. The current webchat, forms and pairing pages keep their styles until a story moves them.
- **Each origin that adopts the system serves the font files and allows them.**
  - The webchat's policy, `default-src 'self'`, already does.
  - The secure forms' policy starts from `default-src 'none'` and needs `font-src 'self'`.
  - The files cost nothing beyond the Workers Paid plan.
- **Showing the wait needs its deadline on the webchat's socket.**
  - The conversation sends the buffer's deadline to the page in one new server-to-client message.
  - The webchat redesign (#140) includes that message, which amends #140's constraint that the socket protocol stays the same.
  - Until that ships, nothing shows during the wait, as before.
- **Pull requests that change the interface answer the review checklist** in `docs/design-system.md` §7.
- **Award-site traits stay out of the product:** scroll hijacking, full-screen WebGL and slow in-and-out easing. A future landing page may use them.
- **The spring values come from a simulation** (`docs/design-system.md` §4.2). Changing one means simulating it again the same way and updating its row, its `linear()` and its duration together.

## Alternatives considered

- **Correnteza alone.** It is the most memorable direction, but its overshoot on everything wears thin in a tool used all day.
- **Pastoreio alone.** It is fast and calm, but approving a cost or delegating to subagents would feel like any other click, and it loses the water spirit of the brand.
- **Bruma.** It is the quietest direction, but the moments that matter lose their weight, and blurring every entrance costs on weak devices. Mistura blurs one layer, during a moment.
- **An award-winning website's language.** In the research, these sites scored lowest on usability.
- **A stock design system** such as Material or shadcn/ui's defaults. It would not carry the brand. Material 3's spring values are adopted; its look is not.

## References

- [`docs/design-system.md`](../design-system.md): tokens, measured contrast, springs, patterns and the review checklist.
- Decisions the patterns build on:
  - [ADR-0011](0011-agent-task-board.md): the board;
  - [ADR-0024](0024-fixed-wait-end-of-turn.md): the wait before a reply, amended in §5;
  - [ADR-0026](0026-confirmation-by-owner-act.md): the owner's act as a yes;
  - [ADR-0036](0036-agent-roles-models-and-subagents.md): subagents;
  - [ADR-0039](0039-routines-as-vault-files.md): routines.
- #140, the webchat redesign.
- Research sources are listed in `docs/design-system.md` §9.
