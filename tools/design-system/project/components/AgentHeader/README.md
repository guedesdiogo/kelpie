# AgentHeader

The conversation's header: the agent's 48 px mascot, its name and the status line; below the Sidebar's width, the name opens the switcher and the owner's avatar sits at its end (5.21, frequent grammar).

- **The header** holds the 48 px mascot, the agent's name in Bricolage Grotesque at `text-h3`, and the status line. The status line names the turn's phase ("Reading people/ana-souza.md"), never a ticking count.
- **While the agent's subagents work,** a row of 20 px pups stands between the mascot and the name, and a count of its own follows the status line on its row, such as "1 failed · 2 subagents at work". The Subagents card shows how they leave, come back and close up (5.6, ADR-0053).
- **On a wide screen the Sidebar's roster is the switcher,** and the name is only a heading.
- **Below the Sidebar's width,** the owner's avatar sits at the header's end: 32 px initials in a 44 px target, named in its tooltip, which opens below it. It opens the DisplayMenu downward.
- **The switcher.** Below the Sidebar's width, with more than one agent, or with one the owner can edit there (AgentEditor), the name is a button that opens the list. From a click it grows from the name as the CommandPalette does (`scale-in` and 6px above, to 1, with `spring-fast`); from the keyboard it appears at once. On a phone the list is a sheet that stops at 40% and 90%.
  - Each agent is a link to its conversation (`?agent=<id>`), with its still 36 px mascot in the Idle pose, its name followed by its specialty in `muted` ("main" for the main agent), and its id in Geist Mono. Back and new tabs work.
  - The open agent's mascot carries the Sidebar's pencil at rest, with a 44 px target, since a phone has no pointer to rest on it. It closes the list and opens the AgentEditor: its sheet, on a phone.
  - The current one is marked with `aria-current`.
  - Arrows, Home and End move through the list, and Escape closes it.
- **The order** is the registry's and never changes with activity.
- **Without `?agent=`,** the webchat opens the main agent, and so does an id the list doesn't name.
- **The list comes from ingress.** It names only the agents that chat, each one only if the Directory admits this login to it. It carries each agent's mascot, so the list and the Sidebar draw them before any socket opens (ADR-0052 §7).
- **The consumer provides** the agents (id, name, specialty, mascot), the current id, the status line and the owner's login.
- **Reduced motion:** the list fades.
