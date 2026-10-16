# ADR-0051: Subagents leave and come back as pups beside their parent, one by one, with no link

- Status: Accepted
- Date: 2026-10-16
- Issue: [#399](https://github.com/guedesdiogo/kelpie/issues/399)
- The owner, reviewing the design system on 2026-10-16: «Subagents: na sessão de definição do mascote tem uma animação que gostei mais, onde não tem as linhas e no exemplo mostram 3 subagents e depois pega cada um de volta quando cada um termina sua tarefa.»
- Amends: [ADR-0045](0045-agent-mascot.md) §7, which applied the goo drop and the link of `docs/design-system.md` §5.6

## Context

**§5.6 had subagents leave as drops and stay tied to their parent.**
- Each pup left the parent's body as a drop under an SVG "goo" filter.
- A link drew from the parent to each pup.
- When the work was done, the pups came back together.

ADR-0045 §7 made the goo drop and the link apply to the mascot's pups.

**The mascot's concept page (#364) played a quieter version.**
- Three pups leave the parent and stand beside it, on its ground, with no link.
- Each one comes back when its own task ends, and the parent swallows it.
- A line counts them back.

The owner prefers it.

## Decision

**Pups stand beside the parent with no link and no goo, and each one comes back on its own.**
- **Leaving.**
  - Each pup leaves from the parent's middle, at a scale of 0.3, to its place beside it, with `--spring-moment`, 110 ms apart.
  - The parent pulses as each one leaves.
- **Coming back.** Each pup comes back when its own task ends, in the order they finish:
  - it smiles and hops;
  - it travels back into the parent's middle in 200 ms with `--ease-exit`, faster than it left (rule 9);
  - the parent swallows it (`scale` 1.12 to 1, `--spring-pop`).
- **Counting.** A polite status line counts them back.
- **Unchanged from ADR-0045 §7:**
  - what a pup looks like: the same shape and head, a lighter color, dot eyes, no accessory, 40% of the size;
  - all of them show, since ADR-0036 caps a creator at three live subagents.

## Consequences

- **`docs/design-system.md` changes in the same pull request:**
  - §5.6, rewritten;
  - §4.1, where the moment's signature names the pups;
  - §4.2, where `--spring-moment-slow` no longer names subagents and links;
  - §6, where the goo goes, since nothing uses it any more.
- **Reduced motion:** pups fade in and out at their places in 150 ms, as ADR-0045 §6 already says, and the mascots are Still.
- **No code changes:** nothing draws subagents yet. The design-system artifact already plays this version.

## Alternatives considered

- **Keep the drop and the link.**
  - The link adds lines the owner didn't want.
  - All pups returning at once hides which task finished first.
- **Keep the goo without the link.**
  - The concept page the owner chose has no goo.
  - Its pups leave and return from the parent's middle, which already reads as coming out of the body.

## References

- [ADR-0045](0045-agent-mascot.md) §7, the pups; [ADR-0036](0036-agent-roles-models-and-subagents.md), subagents.
- The mascot's concept page, section "Filhotes que voltam para casa", and its research on [#364](https://github.com/guedesdiogo/kelpie/issues/364).
- [`docs/design-system.md`](../design-system.md) §5.6.
