# The mascot

Pattern 5.19 of `docs/design-system.md`. The engine is in `components/bundle.js` as `window.Kelpie.mascot`; the Mascot card runs it.

Moment for its states, frequent for its life in place ([ADR-0045](https://github.com/guedesdiogo/kelpie/blob/main/docs/adr/0045-agent-mascot.md)). Each agent is a soft, furry drop of water that stays alive where it is. The engine is `apps/ingress/public/webchat/mascot*.js`: plain modules, SVG and the Web Animations API, with no library.

**Anatomy and axes.** Five axes, 374,400 combinations. Each is an agent setting (`mascot`), set through the configuration commands and validated against these ids:

| Axis | Options |
|---|---|
| Shape | `mark`, `bubble`, `drop`, `pebble`, `buoy`, `jellyfish`, `cloud`, `dune`, `star`, `heart`, `bean`, `block` |
| Color | `kelp`, `lagoon`, `tide`, `sky`, `indigo`, `anemone`, `pink`, `fawn`, `cocoa`, `moss`, `lime`, `slate` |
| Eyes | `dots`, `pills`, `shine`, `marbles`, `cyclops`, `half-moon`, `frog`, `stars`, `big`, `buttons`; `cheeks` on or off |
| Head | `none`; `ears`: `pointed`, `floppy`, `round`; `horns`: `two`, `one`, `antennae`; `hair`: `strands`, `curl`, `mohawk`; `leaves`: `one`, `two`, `kelp` |
| Accessory | `none`; `glasses`: `round`, `dark`; `bow`: `tie`, `head`; `hat`: `beret`, `top`, `beanie`; `belt`: `belt`, `collar` |

- **Master starts as Kelpie:** `mark`, `kelp`, `big` eyes, round ears and no accessory ([ADR-0049](https://github.com/guedesdiogo/kelpie/blob/main/docs/adr/0049-logo-main-mascot-silhouette.md)). Its silhouette is the logo (5.23).
- **A new agent starts with a random mascot,** saved as its setting, which the owner edits from there (5.25, [ADR-0056](https://github.com/guedesdiogo/kelpie/blob/main/docs/adr/0056-agent-editor-and-random-mascot.md)). An agent created before shows a mascot derived from its id until its first edit saves one. A new option goes at the end of its axis; derived mascots draw from the options above, frozen, so a new one never changes them.
- **A hat hides what sits in the middle of the head:** one horn, antennae, hair and leaves. Ears and two horns stay.
- **Body colors are tokens with one value in both themes,** since they color the figure, not the page. None is amber, which means the owner needs to act.

| Token | Value | Token | Value | Token | Value |
|---|---|---|---|---|---|
| `--mascot-kelp` | `#2E9E8E` | `--mascot-indigo` | `#777CE2` | `--mascot-cocoa` | `#A47458` |
| `--mascot-lagoon` | `#2FB3C6` | `--mascot-anemone` | `#B07CCF` | `--mascot-moss` | `#8AAA45` |
| `--mascot-tide` | `#4F8FD6` | `--mascot-pink` | `#E58BB0` | `--mascot-lime` | `#B3CC3E` |
| `--mascot-sky` | `#7EBDE9` | `--mascot-fawn` | `#B8916E` | `--mascot-slate` | `#7F95A5` |

- **The plush.** Soft parts (the body, ears, hair, leaves, felt and knit hats, mittens) are painted once per piece and size on a canvas: the shape shaded as a volume lit from the top left, then short strands in three layers. The painting is kept as an image, and motion only moves finished images and vectors. Until it is painted, the flat vector shows.
- **Hard parts** (eyes, mouth, glasses, bow tie, horns, antennae, tag, buckle) are crisp vectors with gloss and a soft shadow on the fur.

**States.** Each state has a pose that reads when still, a short announcement when it starts, and a repertoire while it lasts. In Alive the mascot breathes all the time, and draws a gesture from its state's repertoire by weight, never one of the last two (with only two, never the last one).

| State | Shown when | Pose | Announcement | Repertoire |
|---|---|---|---|---|
| Idle | 5.9 Idle | eyes open | a hop and a smile when a reply lands | blinks, glances, looks around and at the owner, wiggles, twitches an ear, hops (12 s apart), stretches, scratches its head, yawns; in Alive, waves when the pointer arrives and claps when tapped |
| Dozing | Idle, after 45 s without an event | eyes closed, a hand as a pillow, "z" | drifts off with `--spring-slow` | snores, stirs; every 20 s at most, wakes bored, rubs its eyes, yawns, rests its chin and dozes again |
| Listening | the wait of 5.1, where its bar shows | head tilted, hand cupped at the ear | its ears twitch | twitches an ear, tilts the other way, blinks, nods |
| Typing | 5.1's typing bubble | mouth open, hands on the keys | talks for about 4 s | talks, blinks |
| Working | 5.9 Working | the task's object and the hands | the object pops out of the body | the activity's loop, blinks, nods |
| Waiting for the owner | 5.9 Waiting; in the webchat, a confirmation's notice (5.3), until it is answered or expires | big eyes, brows up, the amber bubble with `?` | a hop, and the bubble pops and pulses three times | waves, sways, drums on its chin, points at the card, pulses the bubble |
| Approved | the owner's yes, for 1.1 s, then what comes next | arched eyes, a smile, thumbs up | a happy jump with sparks | none |
| Error | 5.9 Error; in the webchat, the notice of a turn no route answered, until the next message or turn | worried brows, hands on its cheeks, the red bubble with `!` | one shake, and the bubble pops | wipes its brow, trembles, pleads, sighs, waves for help, looks down |
| No response | 5.9 No response. The webchat gets no streamed tokens, so it can't tell a slow model from none, and doesn't show it | approved by the owner on #366: the task's object rests, and it looks up at the owner beside a still, dashed `--muted` bubble with `…` | the bubble pops | none |
| Offline | 5.12: the banner of a lost connection, or the expired-login dialog. Every mascot that shows a state, at once, since the page sees none of the agents (ADR-0047) | holds the plug that came out by its loose cord, eyes open on it, brows up, beside a solid `--muted` bubble with a struck-through plug | the plug comes out, drops a little and swings to rest, and the bubble pops | blinks, glances, looks at the plug, tries it in the air, shakes it, looks around, sighs, yawns; 4 to 8 s apart, never a hop |

- **Back from Offline** is an announcement: the plug clicks home, with a small hop and a blink, under 1 s. Then comes the state the history brings. It plays in Alive and States only, at every size, the roster's too. In Still the new pose comes with the crossfade.
- **The activity is always true.** It follows the tool the conversation names: a magnifier to search, paper and a pencil for the vault, a laptop for code, a calendar for the agenda, an envelope for email. A tool without its own object, and the model between tools, show thinking: bubbles over the head. Reading memory before a turn is the vault. While a tool runs, Working takes precedence over Typing.
- **Listening needs the bar.** The webchat's mascot listens while its bar shows (#140). The end of the wait brings it back to idle, unless typing or work has taken over.
- **Springs.** A state change moves the pose with `--spring-moment`, and the bubble pops with `--spring-pop`. Gestures use `--spring-fast`, `--spring-base` and `--spring-slow`.

**Hands and bubbles.**
- Floating plush mittens, a shade lighter than the body, with a soft shadow; no arms. They rest docked below the face, small, and appear where a pose or gesture puts them.
- At work, the task's object comes out of the body and the mittens use it.
- Waiting and error show a glossy 3D speech bubble beside the head, in `--warm` and `--danger` from the theme, with a glyph, so the state never rides on color alone. It pops out, floats, and pulses when the mascot calls the owner.
- Offline's bubble is the same, solid, in `--muted`, with a struck-through plug. It pops out and floats, and never pulses: nothing waits for the owner there.

**Sizes.**

| Where | Size | What changes |
|---|---|---|
| Roster | 36 px | no mouth or brows, eyes 15% larger, no mittens; a glossy badge with a `--surface` ring takes the bubble's place: `--warm` for waiting, `--danger` for error, `--accent` with the tool's icon for working, `--muted` for offline. One gesture at a time across the list, every 7 to 16 s, never a hop |
| Switcher list (5.21) | 36 px | the Idle pose, still, with no badge: the list is open for a moment and carries no state |
| Task card (5.5) | 20 px | the shape, the color and the eyes only: no head, accessory, mittens or badge; still, since the card already says the state. The engine draws a badge at every size up to 40 px today, so the board needs that changed |
| Conversation header | 48 px | its home. Everything happens inside its box; the box is kept before the figure arrives, so nothing moves when it does. Its pups stand in a row after the box, and the name slides to make room (5.6, ADR-0053) |
| Empty conversation, profile, the expired-login dialog (5.12) | 160 px | gestures a little more often |
| Pups (5.6) | 40% of the parent: 20 px in the conversation's header, 64 px on the profile | in the header, the shape, the head, the lighter color and dot eyes, breathing, blinking and announcing only, with 5.9's triangle above a failed one and no badge; on the profile, the full face of the 48 px row; left-aligned beside the parent, closing up as they come back; none while the page is Offline |
| Telegram bot photo | 800 px square, cropped round by Telegram | a still, and a loop Telegram plays (below) |

**Reduced motion and the pause.**
- **The pause** (WCAG 2.2.2) is a setting with three values: Alive, States only, Still. Before a mascot first moves, the webchat asks for it under the header, and the mascot stays still until the owner answers. The Display menu (5.22) keeps it, in the browser. The first run's comfort step and settings (5.17) will hold it too.
- **States only** plays the announcements and nothing else, and cuts each to end within 5 s of the state's start. The mascot doesn't breathe.
- **A change of setting** stops what the old one played, and keeps the pose. The activity's loop starts again only in Alive.
- **Still** shows the state's pose: no breathing, no announcement, no repertoire. A change is a 150 ms crossfade. The poses of listening, typing, working, approved, error and dozing keep their hands, the task's object stays in front of the mascot, and Offline keeps its plug in its mitten.
- **Reduced motion means Still.** Under `prefers-reduced-motion` or the less-motion switch, the setting can't pick Alive or States only, and the webchat doesn't ask.
- **Reading comes first.** While the owner types, the conversation's mascot only breathes and blinks.
- **Nothing moves off screen or in a hidden tab,** the activity's loop included. One shared timer, every 400 ms, schedules every mascot, and an `IntersectionObserver` stops those out of view.
- **The mascot makes no sound.**

**In Telegram** ([ADR-0046](https://github.com/guedesdiogo/kelpie/blob/main/docs/adr/0046-telegram-bot-photo.md)). The agent's bot shows the mascot as its profile photo. Browser Run draws it with the webchat's own engine when the bot connects and when the mascot changes; a mascot already on that bot isn't drawn again.
- **The square** is 800 px on a flat, opaque `--bg` (light). The figure is centered by what it shows, from its ears or hat to its shadow, so nothing that matters falls in the corners Telegram crops.
- **The still** is the rest pose. It is the JPG, and the loop's first frame.
- **The loop** lasts one idle breath, 3.6 s at 30 fps, so it joins up: a blink at 0.7 s, a wave at 1.3 s, a blink at 3.0 s.
- **Telegram decides when the loop plays,** so the pause and reduced motion don't reach it. It is made safe on its own: one pass under 5 s, no flash, no zoom and no scaling of the whole figure.
