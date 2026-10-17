# PacedReply

Kelpie waits for the owner to finish, shows the wait as a draining bar, then answers in parts: the typing bubble becomes the reply (5.1, frequent grammar; ADR-0024, amended by ADR-0043).

- **The owner's message** enters from below the composer (`rise`, `scale-in`, `spring-base`, origin at the bottom right), and the bubbles above slide up with it (FLIP, `spring-base`).
- **Held messages.** While the buffer holds them, each of the owner's messages carries a small clock in `muted` under it, "held". The bubble itself doesn't change. The mark fades out (`dur-fade`) when the turn starts reading them.
- **The wait.** A 64px track over the composer, 3px tall, `accent` on `line`, with "Waiting for you to finish" beside it, then "Kelpie is writing" once the turn reads (#378, decision 10). It shows wherever the interface knows the buffer's deadline.
  - The webchat learns the deadline from one socket message, `wait`: how long is left and how long the wait is, in ms, and whether the owner's typing holds it. `deadline: null` when the turn starts reading or a pause cancels the wait.
  - The bar follows the buffer's real deadline: `quietMs` after the latest message, capped by `maxWaitMs` from the first.
  - A new message refills it in the first 7% of the time, then it drains linearly.
  - While the owner is still typing, the bar stays full. It drains toward the `maxWaitMs` deadline once that comes first.
  - With `quietMs: 0` there is no wait and no bar.
- **Typing.** When the wait ends, a typing bubble appears. Its dots blink in steps, 0.8 s per cycle, for five cycles. Then they rest at 60% opacity until the reply comes. Past 3 s the bubble names the phase and the elapsed time, "Thinking · 6 s" (rule 7; decision 12).
- **The reply** takes the typing bubble's place in the same element: its width and height go to the reply's size (`spring-base`), and the text fades in after 70 ms.
- **The header's mascot follows the turn.** It listens while the bar shows, takes Typing with the typing bubble, and greets a reply with Idle's hop and smile. While the owner types, it only breathes and blinks.
- **The composer** is the Composer card's: one row, with Pause and Send as round icons inside it.
- **The consumer provides** the wait's deadline from the socket, the owner's messages and the reply.
- **Reduced motion:** bubbles fade in where they land; the bar still drains, since it is progress; the dots rest at 60% from the start; the mascot is Still.
