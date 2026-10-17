# Subagents

A subagent at work is a pup of its parent's mascot: it leaves the parent's body when its task starts, works beside it, and comes back when that task ends, one by one, with no link, in the conversation's header and on the agent's profile (5.6, moment grammar; ADR-0036, ADR-0051, ADR-0053).

This follows the pups demo the owner preferred on the mascot's concept page, and the owner's ask to see it at the top of the conversation.

- **Each subagent at work is a pup** of the parent's mascot (ADR-0045 §7): the same shape and head, a lighter color, dot eyes, no accessory, and 40% of the size.
- **A pup follows its subagent's tasks.** It leaves when its subagent starts a task and comes back when that task ends; a subagent with no task shows no pup. At most three pups show, since a creator has at most three live subagents.
- **Where pups play:** beside the parent, on its ground, with no link: in the conversation's header at 20 px, and on the agent's profile at 64 px, with the full face of the 48 px row. The roster, the switcher's list, task cards, the empty conversation's 160 px figure and the Telegram photo draw none. None show while the page is Offline: pups out fade out, and when it is back, the pups of tasks still running reappear at their places.
- **The header's row** (AgentHeader):
  - Pups stand between the 48 px mascot's box and the name, on the box's bottom edge, `space-1` from the box and `space-1` apart, with `space-3` before the name.
  - A header pup has the shape, the head, the lighter color and dot eyes, with no mouth, brows, mittens or object; if the engine's head doesn't read at 20 px, it is dropped as on a task card. It breathes, blinks and plays its announcements, such as a success's hop, with no gestures and no dozing.
  - A failed pup shows Presence's triangle glyph above its head, bare, 10 px in `danger`: on the header's background, where `danger` passes 3:1 in every theme, and on no body, where it wouldn't. It is SVG and hidden from screen readers; no pup there has the engine's round badge. A waiting pup looks at the parent.
  - Header pups aren't interactive: 20 px is below the 24 px target size.
  - For screen readers, the row is a list named "Research's subagents", and each pup an item named by its task and state, such as "read the reviews, failed".
- **Pups close up toward the parent.** They stand left-aligned next to it, in the order they left; when one goes back, the pups after it slide toward the parent with `spring-moment`, as a `transform`; a pup that leaves later takes the first free place.
- **The header's name moves as little as it can.** When the row needs more room, the name and status line slide with `spring-moment`, as a `transform`, and never stretch. The row keeps the width of the most pups out since it last emptied, and empties 1 s after the last pup is back, so the name moves when the row grows and when it empties.
- **The parent's state** comes from Presence and the Mascot card as for any agent; delegating is not a state of its own.
- **Leaving.** Each pup comes out of the parent's middle at a scale of 0.3 and goes to its place with `spring-moment`, `stagger-moment` apart. As each one leaves, the parent pulses (`scale` 0.9 to 1, `spring-pop`); on the profile the pup takes Working with its task's object.
- **Coming back, in the order the tasks end:**
  - a task that succeeded: the pup hops, and on the profile smiles too, then 520 ms later travels back into the parent's middle, shrinking to 0.3 and fading, in `dur-exit-moment` with `ease-exit` (rule 9), and the parent swallows it (`scale` 1.12 to 1, `spring-pop`);
  - a task that failed: on the profile the pup takes Error, in the header it shows its triangle; it stays 30 s, as Presence's failures do, then goes back with no smile or hop. Dismissing the failure where Presence lists it sends the pup back at once, and a task the creator sends back to To do sends its pup out again;
  - a task cancelled by the owner's stop or by its agent, or lost with its subagent: it goes back with no smile or hop and doesn't count as failed; an ending the page can't tell is never shown as a success, and the pause cancels nothing;
  - a task that waits for an answer: the question goes to the creator, not to the owner, so the pup stays out with no amber, looking at the parent, and the strip doesn't count it; on the profile it holds its object at rest.
- **On the profile, a status line counts them back** in a polite live region: "1 of 3 back", counting subagents, not departures: 3 is the subagents that went out since none was out, and one that leaves again counts as out until it is back; "All 3 are back", or "It's back" for one; "1 failed"; and "1 waiting on <creator's name>", such as "1 waiting on Kelpie".
- **In the conversation, the header's count** is its own polite live region, on the status line's row, so a change of phase doesn't repeat it; a middle dot separates them only when both show.
  - Its parts, in order: "1 failed", "1 waiting on <creator's name>", then "2 subagents at work" (or "1 subagent at work"). When the last pup is back it reads "All subagents are back" for 5 s, then empties.
  - On a narrow header the phase ends in an ellipsis first, then the count hides its parts whole, from the last; screen readers read it whole.
  - Offline empties it; while paused it stays.
- **The parent's mascot** greets the reply that relays the result, as PacedReply shows.
- **The consumer provides** the parent's mascot and name and, per subagent, its task, its creator, when the task ends and how.
- **Reduced motion:** pups fade in and out at their places in `dur-fade`; the pups after a returning one, and the header's name, take their new places at once; the mascots are Still.
