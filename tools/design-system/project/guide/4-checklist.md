# Review checklist

A pull request that changes the interface answers yes to each line:

- [ ] Every color, size, radius, duration and easing comes from a token, unless a pattern in section 5 sets the number.
- [ ] Only `transform`, `opacity` and color animate, apart from the contained sizes in 5.1, 5.2, 5.3, 5.9, 5.17, 5.18 and 5.25 and the mask reveal in 5.7; no `transition: all`.
- [ ] Keyboard-triggered actions don't animate their way in or out; progress and results still show.
- [ ] Loops stop within 5 s, apart from the mascot's life in place (5.19), and the steady state reads without motion.
- [ ] Exits are faster than entries, and staggers stop at 300 ms.
- [ ] Interrupting an animation leaves no element stuck halfway.
- [ ] Under reduced motion, every movement becomes a short fade, and no feedback disappears.
- [ ] New text meets the contrast in section 1, in both themes and in higher contrast, and controls draw their boundary in `--muted`.
- [ ] `--warm` appears only where the owner must act, and a toast only where 5.13 allows one.
- [ ] Copy follows the voice in section 2.
- [ ] Every place that shows an agent shows its mascot at a size from 5.19, never a photo, an initial or a generic icon.
- [ ] The logo appears only as the brand, drawn by `scripts/brand-icons.mjs` and sized as 5.23 says, and never in place of an agent's mascot.
- [ ] A mascot's pose, badge, glyph and label agree, and they show the agent's real state.
- [ ] A new mascot surface moves only as its size allows in 5.19, and the pause and reduced motion stop it.
