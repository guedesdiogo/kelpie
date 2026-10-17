# DisplayMenu

The owner's account opens the Display menu, from the Sidebar's foot or, below the sidebar's width, from the header's avatar: the name and email, the theme as three icons, less motion and more contrast as switches, the mascot's pause as its own outline, and the version (5.22, frequent grammar; #378, decisions 5 and 8).

- **The account row:** a 24 px avatar with the initials on `accent` with `on-accent` (the first and last words of the name, or of the email's name without one), the name truncated when long, and a chevron that points up. A photo the login carries waits for a content policy that allows its host. Without a login to read, the button reads "Display".
- **The menu** grows from the account as the CommandPalette does, from `scale-in` and 6px, with `spring-fast`: upward from the Sidebar's foot, down from the header's avatar. From the keyboard it appears at once, with focus on the chosen theme, and Escape returns focus to the button that opened it. It starts with the name and the email from the Access login, in Geist; the page shows them and never stores them.
- **Theme:** a segmented control of three icons, System (a monitor), Light (a sun with eight rays) and Dark (a crescent), each named in its tooltip and to screen readers. It is never a half-filled circle, which is the working glyph of Presence.
  - The choice applies at once, and the page crossfades in `dur-fade`.
  - The indicator slides with `spring-fast` for the pointer and jumps for the arrows; the chosen icon turns into place with `spring-base`: the sun a quarter turn, the moon a tilt.
- **Less motion** and **More contrast** are switches, each with its icon before its words: a circle with one trail, and a square split on its diagonal (never the half-filled circle of working). Less motion adds to the system's reduced motion and can't turn it off.
- **Mascot:** the pause (Alive, States only, Still) as the mascot's own outline: mid-hop over its shadow with two motion ticks for Alive, with 5.19's badge for States only, standing on a line for Still. Under reduced motion or less motion, Alive and States only show disabled, and the menu says why.
- **The segmented control** is a `sunken` track with its boundary in `muted`; the chosen option sits on `surface`. A switch is on in `accent`.
- **Every icon names itself** in a tooltip: the first waits 400 ms, its neighbors within 300 ms show at once, keyboard focus shows one at once, Escape hides it without moving focus, and nothing uses `title`. On touch, an icon is never the only label.
- **The version** closes the menu, in Geist Mono `muted` (decision 5), and copies on a press ("Copied" in place for 1.5 s).
- **The choices are stored in this browser** until the comfort step of FirstRun exists, and apply before the first paint: a small script in the page's head sets them on `<html>`.
- **The consumer provides** the account (name and email), the current choices and where to store them.
- **Reduced motion:** the menu and the chip fade.
