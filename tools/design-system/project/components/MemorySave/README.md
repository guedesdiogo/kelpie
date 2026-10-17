# MemorySave

Saving to memory: the learned phrase is highlighted, a chip with the real file path leaves it on an arc into the vault, and a toast offers Undo (5.7, moment grammar).

- **The highlight.** The learned phrase gets a highlight that grows from its start (`accent` at 24%, the `--highlight` tint, `spring-moment`). It is not `warm`: remembering asks nothing of the owner. Its text stays `fg`.
- **The chip.** A chip with the real file path, such as `people/ana-souza.md`, lifts from the phrase (`rise-moment`, `scale-in-moment`). It travels in `dur-travel` (`ease-travel`) along an arc 60px above the straight line to the vault, shrinking to 0.35 and fading over the last 18%.
- **The vault** pops (`scale` 1.14 to 1, `spring-pop`), and its count rolls. While the agent writes to the vault, its mascot holds the paper and pencil.
- **The toast** (see Toast) says where the note went, from which conversation, when and by which agent: "Saved to `people/ana-souza.md` · From this conversation, today at 14:32 · by Kelpie". It offers Open and Undo for 10 s. Undo sends the chip back along the same arc and takes the highlight away. In the vault, Undo writes a new version that removes the note; history keeps both.
- **Each note keeps its origin.** The vault shows who wrote each passage, from a write log rather than markers in the file: the owner, an agent or an import (#363).
- **Off the record.** A conversation can be marked so nothing from it enters the vault (#363).
- **A new note appears as ink.** Its text reveals left to right under a mask, over `dur-travel`. Only a new note does this; chat keeps rule 7.
- **The consumer provides** the phrase, the note's path, the conversation and the undo handler.
- **Reduced motion:** the highlight fades in, the chip fades out where it is, the count changes with a fade, a new note appears whole, and the mascot is Still.
