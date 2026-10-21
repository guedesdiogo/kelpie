# ADR-0064: What shows beside the mascot floats over a margin its host keeps

- Status: Accepted
- Date: 2026-10-21
- Issue: [#481](https://github.com/guedesdiogo/kelpie/issues/481)
- On the lab, the owner chose: «Escolho (b) para todos os efeitos, com a margem que o host guarda.»
- Amends [ADR-0063](0063-mascot-frame-holds-every-hop.md): what shows beside the figure, which it left out, gets a rule of its own.
- Amends [ADR-0045](0045-agent-mascot.md):
  - §4, the box: what shows beside the figure may draw past it, into room its host keeps;
  - §10, the speech bubble: it floats beside the figure and never hops with it.

## Context

**ADR-0063 frames the figure and cuts every hop to the room above it.** It named what it didn't cover: the speech bubble of Waiting, Error, No response and Offline, the 36 px badge, Approved's sparks, the thinking bubbles and dozing's "z".

**Headless Chrome measured them on #481.** It ran the shipped engine at 36, 48 and 160 px, over the 12 shapes with no head and four heads and hats, and the frog eyes, which push the bubble right.
- **The bubble and the badge don't hop.** They sit outside the hop. The sparks, the thinking bubbles and the "z" hop with the figure.
- **At 48 px, at rest:**
  - the bubble leaves the frame on all 12 shapes, by 1.5 px on the right, 3.2 px with frog eyes;
  - the thinking bubbles leave it on 9 of the 12, by 7.9 px above `drop`;
  - the sparks leave it only on `drop`;
  - the "z" stays inside everywhere.
- **In motion, at 48 px:**
  - the bubble's pulse reaches 7.3 px above the box;
  - Approved's jump takes the sparks 6.8 px above it;
  - a jump while thinking takes the thinking bubbles 15.2 px above it.
- **At 160 px those are 19.2, 22.8 and 50.6 px.** No margin a host could keep bounds effects that hop.
- **The 36 px badge's ring** pulses 4.2 px right of the box and 4.6 px below it.

**The research on #481** read Hermes Agent, blobatar, Fluent 2, Material 3, Telegram, lottie-web, Rive and OpenAI's Codex pets.
- **Everywhere, the figure's own motion stays in its frame.** ADR-0063 already does that.
- **What talks is a layer of its own, over room its host keeps:** Hermes's speech bubble, hearts and corner badge, Fluent's ring, Material's badge, Telegram's one-off effect. None of them puts a bubble or a burst inside the character's frame.

**A lab compared two ways at true size, in the hosts' real spacing:**
- **(a) Inside the frame.** Each effect moves in until it fits, and every hop is cut to the room above it too.
  - Approved's jump drops from 51% to 29% of its height for Master, and 45 of 192 figures don't jump at all.
  - Hops while thinking stop on 160 of 192 figures.
  - At 48 px, Master's bubble moves 3.9 px left, over its ear.
  - The badge's ring can grow only to 1.2 times its size, so it barely shows.
- **(b) Beside the figure, over a margin its host keeps.** Each effect keeps its place and stops hopping. The hosts keep a few pixels around the box.

## Decision

### 1. What shows beside the figure floats beside it

- **It isn't part of the figure.** That covers the speech bubble, the badge, the thinking bubbles, the sparks and the "z"s. ADR-0063's frame and cuts hold the figure alone.
- **The thinking bubbles, the sparks and the "z"s draw in a layer of their own, beside the figure.**
  - It takes the state's pose, with its tilt and its squash, so they keep their place by the head.
  - It doesn't take the figure's hops, its breath or its gestures. So the figure jumps between Approved's sparks and under its thinking bubbles.
- **The bubble and the badge already sat outside the hop,** and stay there.
- **The sweat drop sits on the face, and moves with it.**
- **Each effect's own motion plays as before:**
  - the bubble's pop, bob and pulse;
  - the badge's pop and ring;
  - the thinking bubbles' rise;
  - the sparks' pop;
  - the "z"s drifting in.

### 2. Each host keeps a margin for what it shows

- **The margin is `MARGIN` in `mascot-art.js`,** in grid units past each side of the frame, per size:

  | Size | Above | Right | Below |
  |---|---|---|---|
  | 36 px, the roster | 17 (5.5 px) | 13.5 (4.3 px) | 14.5 (4.7 px) |
  | 48 px, the header | 17 (7.3 px) | 13.5 (5.8 px) | 0 |
  | 160 px, a profile | 17 (24.3 px) | 10.5 (15 px) | 0 |

  Nothing reaches past the frame's left side.
- **It is the most any effect reaches, to the next half unit.** That counts every shape and eye, at rest and through the effect's own motion. A part counts while it is at least 25% opaque, as #474 read the fur.
  - Above, the thinking bubbles over `drop` set it at every size. At 48 px, the bubble's pulse over `drop` reaches as high.
  - On the right, the badge's ring sets it at 36 px, and the bubble's pop with frog eyes at 48 and 160.
  - Below, the badge's ring sets it at 36 px.
- **Each host keeps the room for what it can show.** Today's hosts already do:

  | Host | Size | Shows | Needs | Keeps |
  |---|---|---|---|---|
  | The header | 48 px | every effect | 7.3 px above, 5.8 px right | 12 px above, 12 px before the name |
  | A roster row | 36 px | the badge, the sparks, the thinking bubbles | 5.5 px above, 4.3 px right, 4.7 px below | 7 px above and below in its row, 12 px before the name |
  | The empty conversation | 160 px | the sparks, the "z" | 6.8 px above | 32 px above |
  | The expired-login dialog | 160 px | Offline's bubble | 13.3 px above, 13.6 px right | 24 px of padding, the box centered in it |
  | The editor's stage | 160 px | the sparks, the "z" | 6.8 px above | 18 px above, in a panel that clips |
  | The editor's 56 px mascot | 56 px | the sparks | 2.4 px above | 12 px |
  | A confirmation card | 40 px | the badge, still | 0.4 px right, 0.8 px below | 8 px of padding |

- **A new host keeps the margin of its size for what it shows, or shows less.**

### 3. Nothing else moves

- **The figure, its frame and its cuts are ADR-0063's.**
- **Under Still and reduced motion,** the effects' layer takes the state's pose at once, as the figure does.
- **The Telegram photo draws the rest pose of Idle,** which shows no effect.
- **A page test enforces §1 and §2,** like ADR-0063's.
  - It records each Web Animation the engine starts, and follows every effect through its keyframes and easings, and those of the groups that hold it.
  - What a state change starts plays on one clock. A later motion, such as the bubble's pulse, plays at every phase of the loops already running.
  - On every shape, every eye that moves the bubble and each size, every effect stays inside its frame plus `MARGIN`, and `MARGIN` is what they need.
  - The effects' layer sits outside the figure's hop and takes the state's pose.

## Consequences

- **A hop no longer carries what shows beside the figure.** The figure jumps alone.
- **The hosts own the room around the mascot's box.** A host that clips or crowds it hides part of the state, so a new host reserves it.
- **The thinking bubbles stay high on tall shapes:** 7.2 px above the 48 px box on `drop`, inside the header's 12 px.
- **Nothing is cut from the figure:** Approved's jump, the hops while thinking and the badge's ring keep what ADR-0063 left them.

## Alternatives considered

- **(a) Inside the frame.** Nothing past the box, but the cost falls on the figure and on the call for attention:
  - Approved's jump drops to about a third;
  - hops while thinking stop;
  - the bubble covers Master's ear at 48 px;
  - the badge loses its ring.
- **Today's placement, with a margin.** The effects keep hopping, and would need 15 px above the 48 px box and 50 px above the 160 px one.
- **A rule per effect.** The lab offered one, with the "z" inside the frame. The "z" never leaves the frame at rest, so one rule keeps the engine simpler at no cost.

## References

- Issue [#481](https://github.com/guedesdiogo/kelpie/issues/481): the research as adopt, adapt and avoid, the browser's measurement, the lab and the owner's pick.
- [The lab](https://claude.ai/artifact/LCEWjVvSJ5hUpkCVhGJLg6), private and the owner's.
- **ADRs:**
  - [ADR-0063](0063-mascot-frame-holds-every-hop.md), the frame and its cuts;
  - [ADR-0045](0045-agent-mascot.md) §4, §9 and §10, the box, the badge and the bubble;
  - [ADR-0047](0047-mascot-offline.md), Offline's bubble and the expired-login dialog.
- [`docs/design-system.md`](../design-system.md) §5.19.
