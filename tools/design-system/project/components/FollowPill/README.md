# FollowPill

The thread follows new content only near its end; below that, a pill counts what is new and brings the reader back (5.10, frequent grammar).

- **It follows the end only near it.** The thread follows new content while the reader is within 150px of its end. Scrolling up, by wheel, touch or key, stops the follow.
- **New messages below** show a pill at the bottom, "↓ 3 new". It enters with `rise` and `spring-fast`, and its count rolls. A press scrolls to the end with `spring-base`; End jumps at once; reaching the end by hand removes the pill (exit).
- **When an approval waits below,** the pill reads "↓ Approval waiting" instead, with a `warm` boundary.
- **Selecting text** pauses the follow until the selection ends.
- **Sending a message** always returns to the end.
- **An approval never forces a scroll.** It counts in the pill and in the Presence strip.
- **The pill** is a `surface` chip with a `muted` boundary and `shadow-pop`.
- **The consumer provides** the scrolling thread and what arrives in it.
- **Reduced motion:** the scroll jumps, and the pill fades.
