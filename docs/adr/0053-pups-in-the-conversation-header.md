# ADR-0053: Pups show in the conversation's header too, and close up as they come back

- Status: Accepted
- Date: 2026-10-16
- Issue: [#403](https://github.com/guedesdiogo/kelpie/issues/403)
- The owner asked on 2026-10-16, reviewing the design system: «os filhotes devem aparecer na janela da conversa com o agente, no topo do chat, quando ele estiver usando subagents e deve jogar a quantidade de subagents que ele estiver usando, matendo eles enquanto eles estiverem trabalhando, apenas retorna quando tiverem terminado suas respecitivas tarefas, cada um no seu tempo, pode ir reorganizando eles sempre alinhados a esquerda próximo do "pai" na medida que forem se recolhendo»
- Amends: [ADR-0051](0051-subagent-pups-return-one-by-one.md), which drew pups only on the agent's profile, in slots kept beside the parent
- Amends: [ADR-0045](0045-agent-mascot.md) §4, where nothing in the header's layout moves, and §7, where pups leave and come back

## Context

**ADR-0051 drew pups in one place.**
- Pups stood beside the parent only on the agent's profile, where its mascot shows at 160 px.
- The conversation's header and the roster drew none.
- Three slots beside the parent were kept, so nothing moved when a pup arrived or left.

The owner works in the conversation, where no pup showed, and asked for them at its top, beside the parent, closing up toward it as they come back.

**The header is small.**
- It holds the 48 px mascot, then the agent's name and its status line (`docs/design-system.md` §5.21), and the Display menu's button on the right (§5.22).
- At ADR-0045 §7's 40%, a pup there is 19.2 px, rounded to 20 px.
- At 20 px a task card draws only the shape, the color and the eyes (§5.19).
- ADR-0045 §4 keeps the header's layout still: everything happens inside the mascot's box.

## Decision

**Pups show in the conversation's header too, one per subagent at work, and on both surfaces they close up toward the parent as they come back.** `docs/design-system.md` §5.6 and §5.19 hold the numbers.

### Where

- The conversation's header and the agent's profile draw pups.
- None show in these places:
  - the roster;
  - the switcher's list;
  - task cards;
  - the empty conversation's 160 px figure;
  - the Telegram photo.
- The empty conversation's header still draws them.
- No pups show while the page is Offline, as ADR-0051 says.

### The header's pups

- **The row.**
  - Pups stand in a row between the mascot's box and the name.
  - The row is as tall as the box, and pups stand on its bottom edge, the parent's ground.
  - The row starts `--space-1` from the box, and pups stand `--space-1` apart. The name keeps `--space-3` after the row.
- **What a pup shows.** It is 20 px, with the shape, the head, the lighter color and dot eyes.
  - The head stays, though a task card drops it. It is what makes a pup its parent's (ADR-0045 §7). If the engine's head doesn't read at 20 px, it is dropped as on a task card.
  - It has no mouth, brows, mittens or task's object.
  - It breathes and blinks, and plays its announcements, such as the hop of a task that succeeded. It has no gestures and doesn't doze.
- **A failed pup** shows §5.9's triangle glyph above its head, bare, 10 px in `--danger`.
  - It sits on the header's background, inside the row's height and the pup's width, so it covers neither the pup nor its neighbor.
  - On the background `--danger` passes 3:1 (WCAG 1.4.11) in every theme; on the mascots' bodies it wouldn't.
  - The glyph is drawn in SVG, so it shows in forced colors and higher contrast.
  - It is hidden from screen readers, which read the pup's name.
  - The engine's round badge, which carries no glyph, isn't drawn on header pups.
- **A working or waiting pup** carries no mark. A waiting pup looks at the parent, and the count and its name say it waits.
- **Header pups aren't interactive.**
  - At 20 px they are below the 24 px target size (WCAG 2.5.8).
  - A failure is dismissed where §5.9 lists it, and its pup then goes back at once.
- **For screen readers,** the row is a list named for the parent's subagents, such as "Research's subagents".
  - Each pup is an item named by its task and state, such as "read the reviews, failed".
  - The figures are hidden.

### Closing up

- Pups stand left-aligned next to the parent, in the order they left.
- When one goes back, the pups after it slide toward the parent with `--spring-moment`, as a `transform` from where they were.
- A pup that leaves later takes the first free place after the others.
- This replaces ADR-0051's kept slots on the profile too.

### The name moves as little as it can

- When the row needs more room, the name and the status line slide to their new place with `--spring-moment`, as a `transform` from where they were. They never stretch.
- The row keeps the width of the most pups out since it last emptied.
- When the last pup is back, the row empties 1 s later. A subagent that starts its next task at once doesn't move the name.
- So the name moves when the row grows and when it empties, not on each return.
- The name ends in an ellipsis when it doesn't fit. On a 320 px screen with three pups out, beside today's Display button, which has a label, it keeps about 70 px.

### The header's count

- The count is its own polite live region, on the status line's row. A middle dot separates it from the phase only when both show.
- It isn't the status line, so a change of phase doesn't repeat it, and the status line still names only the turn's phase (§5.20).
- It changes only when a pup leaves, fails, waits or comes back.
- **Its parts, joined by middle dots,** come in this order:
  1. "1 failed", while a failed pup is out;
  2. "1 waiting on <creator's name>", such as "1 waiting on Kelpie";
  3. "2 subagents at work", or "1 subagent at work", counting the pups out that work.
- When the last pup is back, the count reads "All subagents are back" for 5 s, so screen readers hear the end, then empties.
- **On a narrow header,** such as a phone's:
  - the phase ends in an ellipsis first;
  - then the count hides its parts whole, from the last, so a failure stays in sight;
  - screen readers still read the whole count.
- These are fixed texts (ADR-0027).
- **Offline** empties it with the pups. **While paused** it stays, since the pause cancels no task (§5.3).

### Leaving and coming back

They follow §5.6 on both surfaces:
- each pup leaves the parent's middle at 0.3 with `--spring-moment`, `--stagger-moment` apart, and the parent pulses;
- **a task that succeeded:** the pup hops and goes back in `--dur-exit-moment` with `--ease-exit`, and the parent swallows it. In the header it has no mouth to smile with;
- **a task that failed:** the pup shows its failure and stays 30 s, then goes back with no hop;
- **a task cancelled or lost:** back with no hop, and it isn't counted as failed. An ending the page can't tell is never shown as a success;
- **a task that waits on its creator:** the pup stays out with no amber;
- **a task the creator sends back to To do:** its pup leaves again when the task runs.

### The profile's count

The profile's line, "1 of 3 back", counts subagents, not departures. Its total is the subagents that went out since none was out, at most three (ADR-0036), and a subagent that leaves again counts as out until it is back.

### Unchanged

From ADR-0051:
- a pup follows its subagent's tasks;
- at most three show;
- the parent's state comes from §5.9 and §5.19.

From ADR-0045 §7: the look of a pup.

## Consequences

- **`docs/design-system.md` changes in the same pull request:**
  - §5.6, rewritten;
  - §5.19's sizes table: the header's row and the pups' row;
  - §5.21: one bullet that points to the pups' row;
  - §9: the sources read on #403;
  - the introduction, which lists the ADRs.
- **#378 lays out the webchat's header** (§5.21). The pups' row and the count sit inside its `.agent`, and their rules stay in §5.6.
- **The engine draws a round badge at every size up to 40 px.** Header pups need it off, with the triangle glyph above them instead.
- **Reduced motion:**
  - pups fade in and out at their places in `--dur-fade`;
  - the pups after a returning one, and the name, take their new places at once;
  - the mascots are Still.
- **No code changes:** nothing draws subagents yet.

## Alternatives considered

- **Keep pups only on the profile (ADR-0051).** The owner is in the conversation and would never see them.
- **Keep three slots in the header, as ADR-0051 did on the profile.** About 72 px of every header would stay empty while no subagent works, and the name would sit far from its mascot.
- **The name follows the row on every return.** That moves text the owner reads each time a pup comes back. Keeping the row's width limits it to the row growing and emptying.
- **Pups overlap, as an avatar stack.** With at most three, there is room to keep them apart. Overlapping would hide their faces.
- **Pups under the header, at the top of the thread.** They would push the thread down or cover messages.
- **The roster's badge on every pup.** At 20 px it carries no glyph, so a failure would ride on color alone. A working badge would repeat on every pup and say nothing new.
- **Larger header pups, such as 24 px.** That breaks ADR-0045 §7's 40%.
- **The count in the status line itself.** The status line is one atomic live region, so every phase change would read the count again.

## References

- [ADR-0051](0051-subagent-pups-return-one-by-one.md), the pups and their returns.
- [ADR-0045](0045-agent-mascot.md) §4 and §7, where the mascot lives and what a pup looks like.
- [ADR-0036](0036-agent-roles-models-and-subagents.md), subagents and their tasks.
- [ADR-0027](0027-fixed-texts-in-three-languages.md), fixed texts.
- [ADR-0047](0047-mascot-offline.md), Offline.
- [`docs/design-system.md`](../design-system.md) §5.6, §5.9, §5.19, §5.20 and §5.21.
- **The research on [#403](https://github.com/guedesdiogo/kelpie/issues/403):**
  - Hermes Agent gives each subagent status its own glyph and never shows an unknown ending as a success ([`subagentGlyph.ts`](https://github.com/NousResearch/hermes-agent/blob/848fc0ad8be766b9dc10fe42bd80b5fc2d45d95c/ui-tui/src/lib/subagentGlyph.ts#L16-L34), [`subagents.ts`](https://github.com/NousResearch/hermes-agent/blob/848fc0ad8be766b9dc10fe42bd80b5fc2d45d95c/apps/desktop/src/store/subagents.ts#L90-L112)).
  - [Primer](https://primer.style/product/components/avatar-stack/) and [Fluent 2](https://fluent2.microsoft.design/components/web/react/core/avatargroup/usage) keep up to four figures apart. Fluent asks for a text representation beside a small badge.
  - [Motion's `popLayout`](https://motion.dev/docs/react-animate-presence) and [FLIP](https://aerotwist.com/blog/flip-your-animations/) close a gap with transforms.
  - [WCAG 4.1.3](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html) covers the polite count.
