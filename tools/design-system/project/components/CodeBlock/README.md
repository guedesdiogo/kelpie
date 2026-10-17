# CodeBlock

A code block in a reply: lines wrap, a tall block scrolls, and a real Copy button says what happened in place (5.20, frequent grammar).

- **Lines wrap,** and a block taller than 400px scrolls. Geist Mono at `text-sm`, on `surface` with a `line` border inside the agent's `sunken` bubble.
- **Copy** is a real button that shows on hover and focus, and always on a touch screen. Its label says "Copied", or "Couldn't copy", in place for 1.5 s, with no toast. Its boundary is `muted`.
- **There is no language label or line number.**
- **Inline code** sits on `surface` inside the agent's bubble, with `r-sm` corners.
- **The consumer provides** the code text.
- **Reduced motion:** the button fades in; nothing moves.
