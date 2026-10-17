# Presence

The roster: each agent as its 36 px mascot, its state in a glyph and a label beside it, and a strip that counts what waits for the owner (5.9, moment grammar).

| State | The mascot at 48 px and up | At 36 px | Glyph and label | Motion |
|---|---|---|---|---|
| Working | the task's object in its mittens, or thinking bubbles | an `accent` badge with the tool's icon | a half-filled circle, "working", the elapsed time `m:ss` | the object pops out, or at 36 px the badge pops; in Alive, the activity's loop |
| Waiting for the owner | its eyes on the owner, brows up, the amber bubble `?` | a `warm` badge | a diamond, "waiting for you", the time since | a hop, and the bubble or badge pulses three times |
| Idle | eyes open, in its own color; dozing after 45 s | no badge | a hollow circle, "idle" | in Alive, it breathes and draws idle gestures |
| Error | worried brows, the red bubble `!` | a `danger` badge | a triangle, what failed | one shake, and the bubble or badge pops |
| No response | the working pose without its activity, beside a still, dashed `muted` bubble `…` | the working badge; the glyph and the label carry the state | a dashed circle, "no response for 1 min" | the bubble pops, then nothing |
| Offline | the plug that came out, held by its cord, beside a solid `muted` bubble with a struck-through plug | a `muted` badge | a struck-through circle, "no connection", no time | the plug drops and swings and the bubble pops, or at 36 px the badge pops; in Alive, a calm repertoire |

- **The glyph and the label carry the state on their own.** At 36 px the badge has no glyph of its own. The glyphs are drawn as SVG, since Geist has no such characters, and are hidden from screen readers, which read the label. In higher contrast, in forced colors and wherever a figure can't be drawn, they are what shows the state.
- **Offline** is the page's state, not an agent's (ADR-0047). When the connection is lost (see ConnectionBanner), every agent in the roster reads "no connection" with the same glyph at once, since the page sees none of them. Coming back, each takes the state its history brings, and the plug clicks home with a small hop and a blink. A Sidebar row whose own socket has been closed 2 s shows Offline alone (ADR-0052).
- **No response** is a working agent from which nothing has arrived for 60 s: no streamed token, and no tool call starting or ending. The webchat can't tell it apart, and doesn't show it.
- **On a change,** the mascot plays its new state's announcement, and the status line rolls (`spring-fast`).
- **A roster stays calm.** At 36 px its repertoire plays one gesture at a time across the whole list, every 7 to 16 s, and never a hop; a state's announcement still plays. Pressing a row does what the roster defines, never a clap.
- **What waits for the owner is counted, not moved.** A strip above the roster counts the agents waiting: a bell in `warm`, "1 agent waiting for you" in `fg` on `warm` at 14% (#378, decision 15); its count, in Geist Mono, rolls; it enters with `rise` and `spring-fast`, and leaves when nothing waits. Its slot is reserved, so the rows never move when it appears. The tab's title starts with the count, "(2) Kelpie", and the favicon gets a `warm` dot. The count is the strip's: a confirmation answered or expired leaves it, and neither writing nor looking at the tab does. Safari keeps the favicon the page loaded with, so the title carries the count there. A free tier past 90% joins the count (see Metric).
- **A row** (decision 15): the 36 px mascot with only its badge and no ring, the name, a line with the glyph and "state · what it does", and the time on the right in Geist Mono, `m:ss` while it works and "3 min ago" while it waits. A row opens its agent's conversation; a waiting row's state is a disclosure that grows the request under the row (height, `spring-moment`) with the ConfirmCard, at once from the keyboard. The Sidebar card has the row, its pencil, the keyboard and how each row follows its own agent (ADR-0052).
- **Finished work leaves; failures stay.** A subagent or task that succeeded leaves a list at once. One that failed stays 30 s with its triangle and what failed, and can be dismissed.
- **An agent is compared with itself,** never in a ranking. **The roster never reorders** when a state changes.
- **The consumer provides** each agent's id, name, mascot, state, activity, detail and since-time.
- **Reduced motion:** mascots are Still, with a 150 ms crossfade on a change. The elapsed time shows minutes only ("2 min") and updates once a minute. The strip appears with a fade, and counts change with a fade.
