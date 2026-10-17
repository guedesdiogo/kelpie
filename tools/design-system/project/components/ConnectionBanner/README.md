# ConnectionBanner

A lost connection waits 2 s before it says anything, then names what happened and when the next try is; every mascot shows Offline, and what the owner sends meanwhile queues (5.12, frequent grammar; ADR-0047).

- **The first 2 s show no banner.**
- **The banner.** Then a banner enters at the top (from 8px above, `spring-base`): a dark pill (`fg` with `bg` text) with the no-Wi-Fi icon, what happened, when the next try is ("No connection. Trying again in 8 s", digits in Geist Mono), and "Try now" (#378, decision 14).
- **Every mascot that shows a state shows Offline when the banner enters.** It says what the page knows, that the connection is gone, and nothing about the turn it no longer sees (rule 7). Every agent in the roster reads "no connection" with the same glyph (see Presence). The switcher and the task card show no state, so they don't change.
- **Queued messages.** What the owner sends meanwhile shows in `sunken` with its text in `muted`, and a clock and "queued" under it. It goes out in order when the connection is back.
- **Back,** the banner turns `ok` with `surface` text, "Back. 1 message sent.", for 2.6 s, then leaves, and every Offline mascot's plug clicks home. A new connection starts from the history, and a mascot takes Waiting again if a confirmation is still open. A confirmation still open after its turn settled isn't in the history: the conversation lists it, and its card draws again at the thread's end with the time it was asked (ADR-0052 §4). A Sidebar row whose own socket came through reads its state again, and the others try at once. Alerts stay quiet for the first 4 s after reconnecting, so a backlog doesn't arrive as a burst.
- **An expired login** opens a centered dialog and keeps the draft. The dialog shows the conversation's mascot at 160 px in Offline, holding its plug, and behind it every mascot that shows a state is Offline too.
  - The page tells it from a lost connection by asking ingress with `X-Requested-With`, which Access answers with 401 once the session expired.
  - Under Access, signing in is a full page of its own, so the dialog says what happened and holds one button, "Sign in again". The page keeps the draft and the messages not yet accepted in the tab's storage, signs in again through a reload, and restores them with "Restored your unsent message".
  - A message not yet accepted goes out again by itself only within 10 minutes. An older one comes back into the composer as a draft, so nothing old is sent without the owner.
- **One state for both causes:** no internet, no server and an expired login show the same Offline state and glyph; the banner and the dialog say which it is.
- **The consumer provides** the connection state, the retry time and the queue.
- **Reduced motion:** the banner fades, and the mascots are Still, holding their plugs. Under the less-motion switch the banner says "Trying again shortly" without a counting number.
