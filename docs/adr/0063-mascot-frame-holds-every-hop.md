# ADR-0063: The mascot's frame holds every figure and every hop

- Status: Accepted
- Date: 2026-10-21
- Issue: [#474](https://github.com/guedesdiogo/kelpie/issues/474)
- On 2026-10-20 the owner looked at the design system and said the space above the mascot was too short: «devemos estar quebrando alguma regra de margem».
- On the frame's lab, the owner chose: «Escolho A + C com o enquadramento 4 2 112 112.»
- Amends [ADR-0045](0045-agent-mascot.md):
  - §4, the box: the frame it draws in, and what keeps every motion inside it;
  - §8, technique: the fur is painted at the frame's scale.
- Amends [ADR-0046](0046-telegram-bot-photo.md): the photo draws the larger frame, at the scale the figure had.

## Context

**ADR-0045 §4 says the mascot's box is its home:** "Everything happens inside its box, and nothing in the layout moves." The engine frames every figure with `viewBox="10 14 100 100"` on its 120 grid, and the SVG lets what leaves that frame show.

**The frame was sized for the round ear at rest.** [ADR-0062](0062-logo-takes-the-kelpie-ear.md) gave Master the kelpie's pointed ear. That ear nearly fills the frame. The hops then carry it out.

**Headless Chrome measured it on #474.** A page ran the shipped engine on every shape and head: 324 combinations of shape, head and hat, at 36, 48 and 160 px. It read the painted fur pixel by pixel, at rest and at the top of every hop.
- **Master at rest:** 1.9 px above its ears at 48 px, and 5.8 px at 160.
- **On Approved,** its ears left the box by 9.6 px at 48 px and 32.5 px at 160.
  - The 15-unit lift was only part of it.
  - The squash and stretch, `scale(.95, 1.07)` about the feet, adds about 6 units.
  - Approved's pose and the breath add the rest.
- **Before ADR-0062:** the round ear left the box too, by 3.1 px at 48.
- **Over all 324:** 33 left the box at rest, the kelp leaf and the tallest horns and hats. 292 left it in some hop.

**The research on #474** found that every reference frames the motion's envelope, not the pose at rest, and clips at it or forbids leaving it:
- Hermes Agent's pets;
- OpenAI's Codex pets and dots;
- Material's loading indicator;
- Rive and Lottie;
- Telegram's stickers.

Kelpie's frame did the opposite.

**A lab compared four ways out, and one combination.** Each ran today's engine at true size, with a table of what it costs:
- **A:** one taller frame for every mascot.
- **B:** a frame fitted to each mascot.
- **C:** hops cut to the room above each figure.
- **D:** boxes that keep room above the figure.
- **A + C:** both A and C.

No single option kept every figure inside without a large cost:
- **A at `4 2 112 112`** still let 190 of 324 leave in a hop.
- **B** drew tall heads at down to 65% of their box.
- **C in today's frame** left Master no room to hop.
- **D** needed 26 px above the 48 px box to hold every head.

## Decision

### 1. Every mascot draws in the frame `4 2 112 112`

- **The frame is 12% wider and taller than before,** with the same ground and middle: it still ends at y 114 and centers on x 60. The figure is 89% of the size it had in its box, and the body fills about 64% of the box instead of 72%.
- **Master gets visible headroom:** 6.4 px above its ears at 48 px and 21 px at 160, against 1.9 and 5.8 before.
- **Every box keeps its size:** 36 px in the roster, 48 px in the header and 160 px on a profile. Only the figure inside them shrinks.

### 2. Every motion that lifts the figure is cut to the room above it

- **The room** runs from the figure's top up to 1 grid unit below the frame's top.
  - **The engine finds the figure's top** in what it draws: the body, the head and what the figure wears.
  - **A soft part counts its fur:** 2.5 units past its outline, which is how far headless Chrome saw the painted pixels reach.
  - **The state's pose and the breath** count at their deepest, and so does the pose's tilt about the feet, such as listening's 9°.
  - **A motion that lifts the figure stops the gestures that tilt it,** since both play on the same group. So only the pose's tilt counts.
- **The motions are the hop, the stretch, the yawn, waking up, the editor's drop-in of a head or an accessory, and a new shape's rebound.**
  - Each is scaled so its highest point stays in the room.
  - A hop's lift, squash and shadow scale together, so a smaller hop still reads as a hop.
  - A motion that fits plays in full, as before.
- **What it costs Master, in the header,** where none of these motions tilts it:

  | Motion | Share of today's height |
  |---|---|
  | Approved | 51% |
  | Waiting | 54% |
  | Excite | 69% |
  | A reply lands | 77% |
  | Back online | 88% |
  | The idle hop | 94% |
  | The stretch | 100% |

  The lab, from the browser's measured tops, showed 57% for Approved; the engine counts the fur's reach on the safe side.
- **Figures without a tall head** play every motion in full, `mark` with no head and Agenda among them. Pesquisa keeps 73% of Approved, and Código 91%.

### 3. A figure that doesn't fit even at rest gets its own taller frame

- **This happens when the figure would reach above the frame's top less 1 unit at rest.** That counts its pose and breath at their deepest, and the gestures' tilts, up to 9° either way.
  - The kelp leaf on most shapes does.
  - So do the tallest heads on `drop`: one horn, the antennae, the hair and the leaves.
  - That is 16 of the 324 combinations the browser measured.
- **Its frame is as much taller as it needs,** on the same ground and middle. That figure draws smaller: the kelp leaf on `drop`, the tallest, at 75% of its old size.
- **Its motions are cut to almost nothing.** Its frame leaves room only for its pose and breath.

### 4. Nothing else moves

- **The logo is unchanged.** `pointedEarOutlines` works on the 120 grid, whatever the frame. `scripts/brand-icons.mjs` writes the same 14 files, byte for byte.
- **The Telegram photo draws the figure at the scale it had** (ADR-0046, ADR-0054).
  - That scale is 5.6 px a grid unit, so the figure's box grows to 627 px.
  - Master's photo is unchanged.
  - A tall head above y 14, which the old frame cut off in the photo, now shows whole.
- **The AgentEditor's stage** keeps its 168 px box around the 160 px figure. Every motion now stays inside the 160 px.
- **The pups and the task card's 20 px figure** are 89% of their box, like every mascot.
- **A test enforces §2 and §3.** It covers every shape, head and hat, and the frog's eyes. In every state, the figure may not rise above its frame at rest, tilted either way, or at the top of any hop, stretch, drop-in or rebound the engine plays.

## Consequences

- **Every mascot is 11% smaller in its box.** The research's references sit at 70% to 86% occupancy, and the body now fills about 64%.
- **Tall heads hop lower than short ones.** The tallest barely hop.
- **The fur is painted at the frame's scale,** `px / 112`, so it keeps the density it had on screen.
- **What shows beside the figure isn't covered:** the speech bubble, the badge, the sparks, the thinking bubbles and the "z"s.
  - They hop with it, and on tall shapes some still leave the frame. The thinking bubbles reach y −9.6 on `drop`, against the frame's y 2. The speech bubble reaches x 117.6 on `mark` at 48 px, against the frame's right edge at x 116.
  - A follow-up decides whether they move inside or keep floating beside the figure.
- **A new head is covered automatically.** The engine reads its height from what it draws, and the test covers it.

## Alternatives considered

- **A alone, one taller frame.** It keeps everyone one size, but the hops still leave it: 190 of 324 at `4 2 112 112`, and still 50 with a frame sized to Master's highest hop, 83% of today.
- **B, a frame per mascot.** Nothing leaves its frame, but figures draw from 65% to 100% of their box. Only 23 of 324 keep their size, and Master would be 83%.
- **C alone, hops cut in today's frame.** Every figure keeps its size, but Master can't hop at all, and 33 combinations still leave the box at rest.
- **D, boxes with room above.** The figure keeps its size, but the header's box would grow 10 px for Master and 26 px for every head, and the profile's 34 px and 85 px.
- **A + C at `2 −2 116 116`.** Master's Approved keeps 76% of its height, but every figure is 86% of its old size. The owner chose 112.

## References

- Issue [#474](https://github.com/guedesdiogo/kelpie/issues/474): the measurement, the research as adopt, adapt and avoid, and the owner's pick.
- [The frame's lab](https://claude.ai/artifact/4xhaBHLT9uTPpxnNCWurpP), private and the owner's.
- **ADRs:**
  - [ADR-0045](0045-agent-mascot.md) §4 and §8;
  - [ADR-0046](0046-telegram-bot-photo.md) and [ADR-0054](0054-bot-photo-follows-default-mascot.md), the photo;
  - [ADR-0062](0062-logo-takes-the-kelpie-ear.md), the pointed ear and the logo.
- [`docs/design-system.md`](../design-system.md) §5.19.
