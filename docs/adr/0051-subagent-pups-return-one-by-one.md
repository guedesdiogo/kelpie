# ADR-0051: Subagents leave and come back as pups beside their parent, one by one, with no link

- Status: Accepted
- Date: 2026-10-16
- Issue: [#399](https://github.com/guedesdiogo/kelpie/issues/399)
- The owner asked on 2026-10-16, reviewing the design system: «Subagents: na sessão de definição do mascote tem uma animação que gostei mais, onde não tem as linhas e no exemplo mostram 3 subagents e depois pega cada um de volta quando cada um termina sua tarefa.»
- Amends: [ADR-0045](0045-agent-mascot.md) §7, which applied the goo drop and the link of `docs/design-system.md` §5.6

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
- **Where they play.** Pups are drawn only where the parent's mascot shows at 120 px or more. Each one follows the mascot's row for its rendered size.
  - Smaller views draw no pups.
  - There, the parent's own state says it is delegating.
- **Leaving.**
  - Each pup comes out of the parent's middle at a scale of 0.3, with `--spring-moment`, `--stagger-moment` apart.
  - The parent pulses as each one leaves.
- **Coming back** depends on how the task ended:
  - **success:** the pup smiles and hops, then goes back into the parent in `--dur-exit-moment` with `--ease-exit` (rule 9), and the parent swallows it;
  - **failure:** it takes Error and stays 30 s, as §5.9's failures do, then goes back with no smile;
  - **waiting for an answer:** it takes Waiting until the answer comes.
- **Counting.** A polite status line counts them back and names a failure.
- **The parent's state** comes from §5.9 and §5.19 as for any agent. The hop and smile greet the reply that relays the result (§5.1).
- **Unchanged from ADR-0045 §7:** what a pup looks like (the same shape and head, a lighter color, dot eyes, no accessory, 40% of the size), and at most three, since ADR-0036 caps a creator at three live subagents.

## Consequences

- **`docs/design-system.md` changes in the same pull request:**
  - §5.6, rewritten;
  - §5.19's sizes table gains a row for pups;
  - §4.1, where the moment's signature names a parent's pups;
  - §4.2, where `--spring-moment-slow` is now used by no pattern;
  - §6, where no pattern uses an SVG filter any more.
- **Reduced motion:** pups fade in and out in `--dur-fade` (rule 10), at their places as ADR-0045 §6 says, and the mascots are Still.
- **No code changes:** nothing draws subagents yet. The design system's published reference already plays this version.

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
