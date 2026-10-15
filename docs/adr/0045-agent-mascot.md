# ADR-0045: Each agent is a customizable plush mascot that stays alive in place

- Status: Accepted
- Date: 2026-10-15
- Issue: [#364](https://github.com/guedesdiogo/kelpie/issues/364)
- Decided by the owner on 2026-10-15, after seven rounds on a live concept page: «Ficou bom. Aprovo as dez decisões do conceito de mascote.»
- Amends: [ADR-0043](0043-design-system.md), how an agent looks (§6) and an exception to motion rule 8 for the mascot; and `docs/design-system.md` §5.9, how an idle agent looks in the roster

## Context

**ADR-0043 left the figure open.** The presence states were decided, but not how an agent looks. On 2026-10-15 the owner asked for something like the mascots of OpenAI's dots instead of a photo in a circle:

> «Gosto bastante da ideia dos mascotes do openai dots. Quero algo nesse sentido do que mostrar um circulo com foto do agente apenas. A ideia é que tenhamos como escolher alguns ajustes pequenos em mascotes, como formato, cor, olho. E esse mascote fica na janela da conversa se movimentando, sem sair do lugar, mas piscando os olhos, mexendo, dando uns pulinhos, algo do tipo.»

**The dots,** from the research on #364:
- the owner names a dot and picks its shape, color, eyes, glasses and accessories, and can change them at any time;
- they are 3D plush characters: three.js, a rigged glTF model per character, and fur from a shader;
- their idle clip is a continuous 6 s loop. Under reduced motion, a still poster shows.

**Two of ADR-0043's rules stood in the way.**
- **Rule 8:** loops stop within 5 s. A mascot that blinks and hops in place is ambient motion that never stops.
- **Rule 10 and WCAG 2.2.2:**
  - reduced motion swaps motion for a still state that still reads;
  - anything that moves for more than 5 s needs a way to pause, stop or hide it.

**The concept went through seven rounds with the owner** on a live page. He asked, among other things:
- that the mascot never stand still or repeat one animation;
- that the texture come close to the dots';
- that hands appear wherever they fit.

## Decision

### 1. Each agent is a plush water creature

- **It replaces the photo in a circle** in the roster, the conversation header and the agent's profile.
- **It is a soft, furry drop of water** whose shape the owner picks. The kelpie of legend is a water spirit that changes shape.

### 2. Five axes: a type, and for some types a variation

| Axis | Options |
|---|---|
| Shape | 12: Mark (the brand's sign), Bubble, Drop, Pebble, Buoy, Jellyfish, Cloud, Dune, Star, Heart, Bean, Block |
| Color | 12 mid tones that work in both themes unchanged: Kelp, Lagoon, Tide, Sky, Indigo, Anemone, Pink, Fawn, Cocoa, Moss, Lime, Slate |
| Eyes | 10: Dots, Pills, Shine, Marbles, Cyclops, Half-moon, Frog, Stars, Big, Buttons; rosy cheeks on or off |
| Head | 13 in 5 types: nothing; ears (pointed, floppy, round); horns (two, one, antennae); hair (three strands, curl, mohawk); leaves (one, two, kelp) |
| Accessory | 10 in 5 types: none; glasses (round, dark); bow (bow tie, on the head); hat (beret, top hat, beanie); belt (belt, collar) |

- **374,400 combinations.**
- **No body color is amber.** ADR-0043 keeps amber for "the owner needs to act". The body is identity, and state never rides on color alone.
- **A hat hides what sits in the middle of the head.**
- **The owner can change a mascot at any time.** A change plays a jump, like the dots' "Excite".
- **The four agents start as follows:**

| Agent | Shape | Color | Eyes | Head | Accessory |
|---|---|---|---|---|---|
| Kelpie | Mark | Kelp | Shine | pointed ears | collar |
| Agenda | Pebble | Fawn | Dots, with cheeks | floppy ears | bow tie |
| Pesquisa | Bubble | Anemone | Marbles | three strands of hair | round glasses |
| Código | Block | Slate | Cyclops | antennae | none |

### 3. The texture is plush, and the hard parts shine

- **The fur is painted strand by strand.**
  - The shape is shaded as a volume, lit from the top left.
  - Tens of thousands of short, fine strands cover it, growing out from the middle.
  - The strands look the same in the center and at the edge. Where they leave the silhouette, they form a lighter fuzz.
- **Soft parts are painted the same way:** ears, hands, hair, leaves, and felt or knit hats.
- **Hard parts are crisp vectors with volume, gloss and a soft shadow on the fur.**
  - The eyes are glass beads and eyeballs, with a crease of shadow where they sit.
  - The same goes for the glasses, the bow tie, the horns, the antennae, the collar's tag and the belt's buckle.

### 4. Where it lives

- **The conversation header, at 48 px, is its home.** Everything happens inside its box, and nothing in the layout moves.
- **In the roster, at 36 px:**
  - no mouth or brows, and eyes 15% larger;
  - one gesture at a time across the list, less often, and never a hop.
- **The empty conversation and the profile show it at 160 px.**

### 5. Listening joins the wait bar

- **During ADR-0024's wait, the mascot listens.** ADR-0043 §5 shows that wait as a draining bar. The mascot tilts its head and cups a hand to its ear.
- **The bar stays the source of truth** for the deadline.

### 6. Always alive, with a pause: an exception to rule 8

- **Each state has three layers:**
  - a pose that reads when still, which is what reduced motion keeps;
  - a short announcement when the state starts;
  - a repertoire, while the state lasts.
- **In "Alive", the mascot never stands still.**
  - It breathes all the time, with a period and depth per state.
  - It draws gestures from its state's repertoire at random, never one of the last two. Hand gestures are in §10.
- **An idle mascot dozes after 45 s** with nothing happening in the conversation.
  - Asleep, it snores and stirs.
  - Now and then it wakes, bored, looks around and dozes off again.
- **Three guards make this the only exception to rule 8.**
  - **A pause, for WCAG 2.2.2.** A preference has three settings:
    - Alive;
    - States only: announcements only, each ending within 5 s;
    - Still.

    The setup agent asks for it in the owner's first conversation, and it stays in the preferences.
  - **Reduced motion starts at Still.** The mascot shows the state's pose and doesn't breathe. A change is a 150 ms crossfade (rule 10).
  - **Reading comes first.** While the owner types, the conversation's mascot only breathes and blinks.
- **Everything stops off screen and in a hidden tab.** One shared timer schedules every mascot.
- **The springs follow the Mistura's grammar.** Moments (waiting, approved, error) use Correnteza's springs; the rest uses Pastoreio's.

| State | Pose | Repertoire |
|---|---|---|
| Idle | eyes open | blinks, glances, looks around, stretches, yawns, scratches its head, hops; waves when the pointer arrives |
| Dozing | eyes closed, a hand as a pillow | snores, stirs; wakes bored, rubs its eyes, yawns, rests its chin on a hand, dozes again |
| Listening | head tilted, hand cupped at the ear | twitches an ear, tilts the other way, nods |
| Typing | mouth open, hands typing | talks, blinks |
| Working | the task's object and the hands (§10) | the activity's loop, blinks, nods |
| Waiting for the owner | big eyes on the owner, brows up, the amber bubble | waves, points at the card, drums on its chin, pulses the bubble |
| Approved | arched eyes, a smile, two thumbs up | a happy jump; it soon turns to working |
| Error | worried brows, hands on its cheeks, the red bubble | wipes its brow, pleads, waves for help, sighs |

### 7. Pups for temporary subagents

- **A pup looks like the agent that delegated.** It has the same shape and head, a lighter color, dot eyes, no accessory and 40% of the size.
- **Pups leave its body and come back to it,** faster than they left (rule 9). The goo drop and the link of `docs/design-system.md` §5.6 apply.
- **At most three are in view.** More show as "+N".

### 8. Technique

- **SVG and the Web Animations API, with no library.** The Mistura's springs run as CSS `linear()`.
- **The plush is painted once per piece and size.** It is painted on a canvas and kept as an image. Motion only moves finished images and vectors, so breathing never repaints the fur.
- **Shapes, colors, eyes, heads and accessories are data.** One animation code serves every combination.
- **The concept's engine weighs 20.4 KB gzip,** counting its JavaScript, CSS and shared gradients.
- **No paid tool or service is involved.** The alternatives were measured gzipped on the jsDelivr files and set aside:

| Alternative | Size, gzipped |
|---|---|
| Rive | 424 to 974 KB, with its WASM |
| dotLottie | 529 KB |
| 3D | three.js 0.170 at 171 KB, plus about 415 KB per model |

### 9. An idle agent keeps its color in the roster (amends design system §5.9)

- **§5.9 dims an idle avatar** to 45% opacity, in grayscale. An idle mascot keeps its color, breathes and dozes after 45 s.
- **The roster's glyphs and labels stay** as §5.9 and ADR-0044 set them.
- **The 36 px mascot adds a small glossy badge:**
  - amber for waiting;
  - red for error;
  - kelp, with the tool's icon, for working.

### 10. Hands and speech bubbles

- **Floating plush mittens appear where they fit.**
  - There are no arms, so the silhouette stays simple at small sizes.
  - The mittens are a shade lighter than the body, with a soft shadow.
- **At work, the task's object comes out of the body, and the mittens use it:**
  - a magnifier to search the web;
  - paper and a pencil to write in the vault;
  - a laptop for code;
  - a calendar for the agenda;
  - an envelope for email;
  - bubbles to think.
- **The activity follows the tool the agent is calling,** through ADR-0025's tool loop. When no tool is known, or several are running, it changes every 5 to 8 s, never repeating.
- **In other states, the mittens gesture** as §6's table lists. A pet makes the mascot clap.
- **In the poses for listening, typing, approved, error and dozing, the hands stay under reduced motion,** so the pose still reads.
- **Waiting and error show a glossy 3D speech bubble beside the head:**
  - amber with `?` for waiting;
  - red with `!` for error.

  It uses ADR-0043's `--warm` and `--danger` tokens in both themes. It pops out of the head, floats, and pulses when the mascot calls the owner. At 36 px, the badge of §9 takes its place.

## Consequences

- **The implementation is a story of its own.** It covers the webchat header and the roster. The design system gains its mascot section in the same pull request as the code (`docs/design-system.md` §8). Until it ships, agents keep the avatar.
- **The mascot is an agent setting.** Like the other agent settings, it is set through the configuration commands (ADR-0013) and the management UI.
- **The fifth presence state came after the concept.** ADR-0044 added "no response". The story proposes its pose to the owner. Until then, the mascot keeps the working pose without the activity's loop, and the label's dashed-circle glyph carries the state.
- **Performance is measured only in headless Chrome so far,** without a GPU, at a device pixel ratio of 2:
  - 383 to 444 fur pieces painted in 1.2 to 2.7 s;
  - 52 to 60 frames a second with nine mascots alive.

  The story measures on a real phone. Until the painting finishes, a flat vector body shows.
- **Channels without a figure,** such as Telegram, are unaffected.

## Alternatives considered

- **A photo or an initial in a circle.** It is the current avatar, and the owner asked to replace it.
- **3D, like the dots.** It is the closest to the reference, but costs about 590 KB for a 14 KB webchat, and WebGL in every row.
- **Rive, Lottie or dotLottie.** They have visual editors, but cost 424 to 974 KB with their WASM, and Lottie needs a file per combination.
- **Fur as an SVG filter at the edge.** It was cheaper to write, but the owner found it coarse, and textured only around the edge.
- **A continuous loop, like the dots' 6 s "Ambient".** It repeats one animation, and it breaks rule 8 and WCAG 2.2.2 without a pause.
- **Objects floating without hands.** The concept page kept this as a comparison, and the owner chose the hands.
- **Flat badges for waiting and error.** They didn't match the plush. 3D bubbles replace them.

## References

- [#364](https://github.com/guedesdiogo/kelpie/issues/364): the decision's issue, with the research findings as adopt, adapt and avoid.
- **ADRs:**
  - [ADR-0043](0043-design-system.md): §6 and rules 8 to 10;
  - [ADR-0044](0044-design-system-review.md): presence states and glyphs;
  - [ADR-0024](0024-fixed-wait-end-of-turn.md) and ADR-0043 §5: the wait;
  - [ADR-0025](0025-turn-tool-loop.md): the tool loop;
  - [ADR-0036](0036-agent-roles-models-and-subagents.md): subagents;
  - [ADR-0013](0013-self-configuration.md): configuration.
- **[`docs/design-system.md`](../design-system.md):**
  - §4: springs;
  - §5.6: subagents;
  - §5.9: presence;
  - §8: designing what isn't here yet.
- **External sources:**
  - [OpenAI's dots documentation](https://learn.chatgpt.com/docs/dots);
  - [the Apple Design Awards 2026](https://www.apple.com/newsroom/2026/06/apple-reveals-winners-of-the-2026-apple-design-awards/) and [2024](https://www.apple.com/newsroom/2024/06/apple-announces-winners-of-the-2024-apple-design-awards/);
  - [Hermes Agent's StatusPulse](https://github.com/NousResearch/hermes-agent/blob/b51e8b850494e0a95a4b410c3d9b9a26df9ae261/apps/desktop/src/components/ui/status-pulse.tsx#L1-L130).
