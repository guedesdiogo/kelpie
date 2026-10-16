# ADR-0053: Pups show in the conversation's header too, and close up as they come back

- Status: Accepted
- Date: 2026-10-16
- Issue: [#403](https://github.com/guedesdiogo/kelpie/issues/403)
- The owner asked on 2026-10-16, reviewing the design system: «os filhotes devem aparecer na janela da conversa com o agente, no topo do chat, quando ele estiver usando subagents e deve jogar a quantidade de subagents que ele estiver usando, matendo eles enquanto eles estiverem trabalhando, apenas retorna quando tiverem terminado suas respecitivas tarefas, cada um no seu tempo, pode ir reorganizando eles sempre alinhados a esquerda próximo do "pai" na medida que forem se recolhendo»
- Amends: [ADR-0051](0051-subagent-pups-return-one-by-one.md), which drew pups only on the agent's profile, in slots kept beside the parent

## Context

**ADR-0051 drew pups in one place.**
- Pups stood beside the parent only on the agent's profile, where its mascot shows at 160 px.
- The conversation's header and the roster drew none.
- Three slots beside the parent were kept, so nothing moved when a pup arrived or left.

The owner works in the conversation, where no pup showed, and asked for them at its top, beside the parent, closing up toward it as they come back.

**The header is small.** It holds the 48 px mascot, then the agent's name and its status line (`docs/design-system.md` §5.21). At ADR-0045 §7's 40%, a pup there is about 20 px. That is the task card's size, where 5.19 draws no mouth, brows or mittens.

## Decision

**Pups show in the conversation's header too, one per subagent at work, and on both surfaces they close up toward the parent as they come back.** `docs/design-system.md` §5.6 and §5.19 hold the numbers.

- **Where.**
  - The conversation's header and the agent's profile draw pups.
  - The roster, the switcher's list, task cards, the empty conversation's 160 px figure and the Telegram photo draw none. The empty conversation's header still draws them.
  - No pups show while the page is Offline, as ADR-0051 says.
- **In the header,** pups stand in a row between the mascot's box and the name, on the parent's ground.
  - The row starts `--space-1` from the mascot's box, and pups stand `--space-1` apart.
  - The name and the status line keep `--space-3` after the row.
- **A header pup is 20 px,** 40% of the 48 px parent, with the roster's detail (5.19):
  - the shape, the head, the lighter color and dot eyes;
  - no mouth, brows, mittens or task's object;
  - its life in place is the roster's.
  - Only Error shows a badge, the roster's `--danger` one. A working pup carries none: being out already says it works.
- **Closing up.**
  - Pups stand left-aligned next to the parent, in the order they left.
  - When one goes back, the pups after it slide toward the parent with `--spring-moment`.
  - A pup that leaves later takes the first free place after the others.
  - This replaces ADR-0051's kept slots on the profile too.
- **The name doesn't jump.**
  - When the header's row needs more room, the name and the status line slide to their new place with `--spring-moment`, animated as a `transform` from where they were.
  - While any pup is out, the row keeps its width, so the name moves only when the row grows and when the last pup is back.
- **The header's status line counts them.** While pups are out, it adds the count after a middle dot:
  - "3 subagents at work", or "1 subagent at work";
  - then §5.6's count: "1 of 3 back", "1 failed", "1 waiting on Kelpie".
  - Once all are back, "All 3 are back" stays until the status line next changes.
  - The status line is already a polite live region, so screen readers hear the count, and a failed pup's badge comes with words. These are fixed texts (ADR-0027).
- **Leaving and coming back** follow §5.6 on both surfaces:
  - each pup leaves the parent's middle at 0.3 with `--spring-moment`, `--stagger-moment` apart, and the parent pulses;
  - a task that succeeded: the pup hops and goes back in `--dur-exit-moment` with `--ease-exit`, and the parent swallows it. In the header it has no mouth to smile with;
  - a task that failed: the pup takes Error and stays 30 s, then goes back with no hop;
  - a task cancelled or lost: back with no hop, and it isn't counted as failed;
  - a task that waits on its creator: the pup stays out with no badge and no amber.
- **Unchanged from ADR-0051:**
  - a pup follows its subagent's tasks;
  - at most three show;
  - the parent's state comes from §5.9 and §5.19;
  - the look of a pup, from ADR-0045 §7.

## Consequences

- **`docs/design-system.md` changes in the same pull request:**
  - §5.6: where pups play, the header's row, closing up, and the header's status line;
  - §5.19's sizes table: the header's row and the pups' row.
- **#378 lays out the webchat's header** (§5.21). The pups' row sits inside `.agent`, between the mascot's box and the name, and its rules stay in §5.6.
- **The header's status line can hold two clauses.** On a phone it ends in an ellipsis, so the pups' count is the first thing cut. The pups still show.
- **Reduced motion:**
  - pups fade in and out at their places in `--dur-fade`;
  - the pups after a returning one, and the name, take their new places at once;
  - the mascots are Still.
- **No code changes:** nothing draws subagents yet.

## Alternatives considered

- **Keep pups only on the profile (ADR-0051).** The owner is in the conversation and would never see them.
- **The name follows the row on every return.** That moves text the owner reads each time a pup comes back. Keeping the row's width limits it to the row growing and emptying.
- **Pups overlap, as an avatar stack.** Overlapping hides their faces, and a pup is a character, not an avatar.
- **Pups under the header, at the top of the thread.** They would push the thread down or cover messages.
- **The roster's working badge on every pup.** At 20 px it repeats on each pup and says nothing new.
- **Larger header pups, such as 24 px.** That breaks ADR-0045 §7's 40%.

## References

- [ADR-0051](0051-subagent-pups-return-one-by-one.md), the pups and their returns.
- [ADR-0045](0045-agent-mascot.md) §7, what a pup looks like.
- [ADR-0036](0036-agent-roles-models-and-subagents.md), subagents and their tasks.
- [ADR-0027](0027-fixed-texts-in-three-languages.md), fixed texts.
- [ADR-0047](0047-mascot-offline.md), Offline.
- [`docs/design-system.md`](../design-system.md) §5.6, §5.19 and §5.21, and the research on [#403](https://github.com/guedesdiogo/kelpie/issues/403).
