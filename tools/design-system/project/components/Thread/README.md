# Thread

The conversation's thread: messages grouped by sender, a label per day, quiet marks under the owner's messages, and Kelpie's notices on the agent's side (5.20, frequent grammar).

- **Groups.** Consecutive messages from one sender, within 10 minutes and on the same day, form a group. Messages in a group sit `space-1` apart, and groups `space-3`. Every corner is `r-bubble`: one radius, with no grouped corners (#378, decision 3). There are no tails, and no avatar beside a reply: the mascot lives in the header (decision 18). A hidden heading opens each group for screen readers: "You, 14:32", "Agenda, 14:33".
- **Bubbles.** The owner's are `accent` with `on-accent`, on the right; the agent's are `sunken`, on the left, with no border in either theme (decision 17). A bubble is at most 29rem wide, and the conversation runs edge to edge, beside the Sidebar on a wide screen (decision 9). Text runs with `unicode-bidi: plaintext`, and long words and links break anywhere.
- **Times.** A bubble's own time shows beside it on hover or a tap (#378, decision 1), in Geist Mono `muted` with tabular figures, without moving the layout. There is no sideways drag, which would fight scrolling on a phone. Times follow the browser's time zone.
- **Days.** Each day opens with a label, in sentence case (decision 2): "Today", "Yesterday", a weekday within the week, then the date, with the year only for another year. It is an `h2` holding a `<time datetime>`, in Geist `text-sm` in a `surface` pill. It sticks to the top while scrolling, and a stuck label fades out (`dur-fade`) 1 s after scrolling stops.
- **Under the owner's messages,** one quiet mark, strongest first; marks only move forward, and a replayed history never steps one back:
  - "Not sent" with the reason, beside a `danger` icon, in `fg` text. The text goes back to the composer;
  - "Queued" with a clock, in a `sunken` bubble (see ConnectionBanner);
  - "Sending", only after 300 ms, with no clock;
  - "Held" with a clock, during the wait (see PacedReply). It fades out when the turn starts reading.
- **Kelpie's notices** keep the agent's side. The notice of a turn no route answered carries a `danger` icon; a confirmation's is the ConfirmCard.
- **Links** in a reply keep their text in `fg` with an `accent` underline (accent text misses AA on `sunken`). The host follows in Geist Mono `muted`, so a label the model wrote can't hide where it goes; a ↗ follows, with a hidden "(opens in a new tab)". No confirmation dialog per link, no fetched page title.
- **Announcements.** The thread is a `role="log"` with `aria-live="off"`. A separate polite region announces each new reply once, with its sender, and never the replayed history.
- **The consumer provides** the messages (sender, text, time, mark) and the notices.
- **Reduced motion:** messages fade in where they land, marks and labels fade.
