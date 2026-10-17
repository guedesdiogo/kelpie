# Sidebar

On a screen 56rem wide or more, the agents sit in a sidebar beside the conversation, which takes the rest of the width: the lockup, the strip's slot, the roster and the owner's account (5.24, frequent grammar; the owner, #378).

- **296px on `bg`,** with a `line` border toward the conversation. From the top:
  - the lockup (Logo), linking home, with the word at 17px;
  - the strip's reserved slot (Presence): a bell in `warm` and "1 agent waiting for you" on a 14% `warm` tint, its count in Geist Mono. The slot is kept, so the rows never move when it appears;
  - the roster (Presence), in the Registry's order, which never reorders;
  - the owner's account, at the foot.
- **A row** (decision 15): the agent's 36px mascot with only its badge, and no ring around it; its name, 14px at 600; a line with the glyph, then "state · what it does" in `muted`; and the time on the right in Geist Mono with tabular figures, `m:ss` while it works and "3 min ago" while it waits. The open conversation's row stands on `surface` and carries `aria-current`.
- **The pencil** opens the agent's editor (AgentEditor): a 24px badge on the mascot's top right, `surface` with a `muted` ring.
  - It shows while the pointer rests on the mascot, fading in and scaling from 0.9 with `spring-fast`. The row's link still takes a press on the mascot.
  - It is a real button, "Edit Research", in the tab order right after the row that holds the list's tab stop, and it shows while it has focus.
  - Where nothing hovers, it rests on every mascot. A row that draws no mascot has none, and a press on the mascot itself never opens the editor.
- **A row opens its agent's conversation.** A waiting row's state, "waiting for you", is a disclosure (`aria-expanded`): pressing it grows the request under the row (height, `spring-moment`) with the ConfirmCard, on `surface`. From the keyboard it appears at once. Once the card folds, its receipt shows 1.6 s and the request closes. For the conversation that is open, the disclosure moves focus to its card in the thread instead.
- **The keyboard.** The list is one tab stop, with roving focus and `aria-current` on the open agent. ↑, ↓, Home and End move, with no animation, and Enter opens a row. → opens a waiting row's request, and ← or Escape closes it.
- **Each row follows its own agent** (ADR-0052).
  - The open conversation's row reads that conversation's own socket. Every other row, up to 16 in the Registry's order, reads a presence socket of its own. Past 16, a row shows its mascot and name with no state, and the list says once that it follows the first 16.
  - A row shows no state until its first frame arrives; it is never Idle by default. A row whose socket has been closed 2 s shows Offline, alone.
  - A request expires on the page's clock too, so a row stops waiting when its last request does.
- **The account** (the owner, 2026-10-16): a 24px avatar, the name, truncated when long, and a chevron that points up. A press opens the DisplayMenu upward.
  - The avatar shows the initials on `accent` with `on-accent`: the first and last words of the name, or of the email's name without one. A photo the login carries waits for a content policy that allows its host.
  - Without a login to read, the button reads "Display".
- **Below 56rem** the sidebar gives way: the header's name switches agents and the header's avatar opens the menu (AgentHeader). What waits for the owner still counts in the tab's title, "(1) Agenda · Kelpie", and on the favicon.
- **Research (§8),** read on 2026-10-16, with the findings on #378: adopt Things 3's sidebar, which counts and never reorders, and Hermes Agent's still status mark with one place that settles states; avoid its polling and reordering, and a counted badge on anything but what waits for the owner (Slack's notifications).
- **The consumer provides** the agents (id, name, mascot, state, what it does, since), the open agent, the open requests and the owner's login.
- **Reduced motion:** the strip and an opening request fade, the pencil only fades, and the rows' times count in minutes.
