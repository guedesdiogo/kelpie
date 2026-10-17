# ToolRow

One row per tool call, with the call's real name: the label rolls as actions replace each other, and the row folds into a one-line summary when done (5.2, frequent grammar).

- **The row.** It appears when a call starts, with the call's real name, as a `surface` pill with a `line` border in the agent's column, above the typing bubble. A call that changes something carries a "changes" tag beside its name; a call that only reads carries none.
- **The mascot follows the same call.** While a row runs, the header's mascot holds that tool's object when it has one (a magnifier to search, paper and a pencil for the vault, a laptop for code, a calendar for the agenda, an envelope for email), and thinks otherwise. Between calls, it thinks or types the reply.
- **Each new action** replaces the label above it: the old label leaves upward (exit, 75% of its height), and the new one rises with `spring-fast`.
- **The spinner** follows rule 8 and turns for at most 5 s. After that, a still ring and the elapsed time say the call is running.
- **The time sits on the right,** from 3 s, in Geist Mono with tabular figures, counting whole seconds and then `m:ss` (#378, decision 11).
- **Done**, the label says what was done, with a check ("Checked the calendar and the vault"; decision 11). Until the runtime names what a call did, the webchat writes a one-line summary instead ("4 steps · 5 s"). A click opens the row: height with `spring-base`, rows entering with `stagger`.
- **Typed results.** A result with a known type (an event, a file, a table, a link) shows as a card of that type, not as running text. The card enters with `rise` and `spring-base`, or with a fade under reduced motion.
- **Streamed text:** only new words appear, with opacity alone, in `dur-word`; nothing animates layout per token, and the word wrappers are removed when the stream ends (rule 7).
- **A pause** in the middle of a turn ends the row with "Stopped by your pause" and a neutral icon.
- **The consumer provides** each call's name, whether it changes something, its steps and its typed result.
- **Reduced motion:** labels swap with a fade; the spinner is a still ring; the summary opens at once; the mascot is Still.
