# ADR-0051: Subagents leave and come back as pups beside their parent, one by one, with no link

- Status: Accepted
- Date: 2026-10-16
- Issue: [#399](https://github.com/guedesdiogo/kelpie/issues/399)
- The owner asked on 2026-10-16, reviewing the design system: «Subagents: na sessão de definição do mascote tem uma animação que gostei mais, onde não tem as linhas e no exemplo mostram 3 subagents e depois pega cada um de volta quando cada um termina sua tarefa.»
- Amends: [ADR-0045](0045-agent-mascot.md) §7, which applied the goo drop and the link of `docs/design-system.md` §5.6
- Amended by: [ADR-0053](0053-pups-in-the-conversation-header.md), pups show in the conversation's header too, and close up toward the parent as they come back instead of keeping their slots

## Context

**§5.6 had each pup leave as a drop and stay tied to its parent.**
- A pup left the parent's body as a drop under an SVG "goo" filter.
- A link drew from the parent to each pup.
- A pup that was done travelled back, and the link retracted.

ADR-0045 §7 made the goo drop and the link apply to the mascot's pups.

**The mascot's [concept page](https://claude.ai/artifact/WgwiUFBHttLJcJ7cUbbzJK) (#364) played a quieter version** in its section "Filhotes que voltam para casa".
- Three pups leave the parent and stand beside it, on its ground, with no link and no goo.
- Each one comes back when its own task ends, and the parent swallows it.
- A line counts them back.

The owner prefers it.

## Decision

**Pups stand beside the parent with no link and no goo, and each one comes back when its own task ends.** `docs/design-system.md` §5.6 holds the numbers.
- **A pup follows its subagent's tasks.** It leaves when its subagent starts a task and comes back when that task ends. A subagent with no task shows no pup.
- **Where they play.** Pups are drawn only on the agent's profile, where the parent's mascot shows at 160 px, so a pup keeps the full face of the 48 px row.
  - The empty conversation and the Telegram photo draw none.
  - Their slots beside the parent are kept.
  - The conversation's header and the roster draw no pups.
  - No pups show while the page is Offline.
- **The parent's state** comes from §5.9 and §5.19 as for any agent. Delegating is not a state of its own.
- **Leaving.**
  - Each pup comes out of the parent's middle at a scale of 0.3, with `--spring-moment`, `--stagger-moment` apart.
  - The parent pulses as each one leaves.
- **Coming back** depends on how the task ended:
  - **success:** the pup smiles and hops, then goes back into the parent in `--dur-exit-moment` with `--ease-exit` (rule 9), and the parent swallows it;
  - **failure:** it takes Error and stays 30 s, as §5.9's failures do, then goes back with no smile, or at once when dismissed; a task the creator sends back to To do sends its pup out again;
  - **cancelled** by the owner's stop or by its agent, **or lost:** it goes back with no smile and isn't counted as failed; the pause cancels nothing;
  - **waiting for an answer:** the question goes to the creator, not the owner (ADR-0036), so the pup waits with its object at rest, looking at the parent, with no amber, and isn't counted in §5.9's strip. If the creator then asks the owner, the parent's state follows §5.9 and §5.19.
- **Counting.** A polite status line counts them back and names a failure.
- **Unchanged from ADR-0045 §7:**
  - what a pup looks like: the same shape and head, a lighter color, dot eyes, no accessory, 40% of the size;
  - at most three, since ADR-0036 caps a creator at three live subagents.

## Consequences

- **`docs/design-system.md` changes in the same pull request:**
  - §5.6, rewritten;
  - §5.19's sizes table gains a row for pups;
  - §4.1, where the moment's signature names a parent's pups;
  - §4.2, where `--spring-moment-slow` is now used by no pattern;
  - §6, where no pattern uses an SVG filter any more.
- **ADR-0045 §7 changes beyond the goo and the link:** pups show only while a task runs, and only on the agent's profile.
- **Pups show in few places.** Where the owner usually is, in the conversation and the roster, no pup shows. A later design can add a cue there, such as "2 subagents at work" in a row's label, with the owner's approval.
- **Reduced motion:** pups fade in and out in `--dur-fade` (rule 10), at their places as ADR-0045 §6 says, and the mascots are Still.
- **No code changes:** nothing draws subagents yet.

## Alternatives considered

- **Keep the drop and the link.** The link adds lines the owner didn't want.
- **Keep the goo without the link.**
  - The concept page the owner chose has no goo.
  - Its pups leave and return from the parent's middle, which already reads as coming out of the body.
  - Dropping the goo also leaves no SVG filter in any pattern.
- **Every pup smiles on its way back.** A failed task would look like a success; rule 7 and ADR-0045 show only what is true.

## References

- [ADR-0045](0045-agent-mascot.md) §7, the pups.
- [ADR-0036](0036-agent-roles-models-and-subagents.md), subagents and their tasks.
- The mascot's concept page, https://claude.ai/artifact/WgwiUFBHttLJcJ7cUbbzJK, section "Filhotes que voltam para casa", and its research on [#364](https://github.com/guedesdiogo/kelpie/issues/364).
- [`docs/design-system.md`](../design-system.md) §5.6 and §5.19.
