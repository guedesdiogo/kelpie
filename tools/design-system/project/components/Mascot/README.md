# Mascot

Every agent is a plush drop of water that stays alive in its box; every place that shows an agent shows its mascot, at a size from the table below, never a photo, an initial or a generic icon (5.19, ADR-0045).

The full rules are in the Mascot section. This card is the engine every surface reuses: `window.Kelpie.mascot`, the webchat's own `apps/ingress/public/webchat/mascot*.js` from `main`, which carries the Offline state of ADR-0047 since #412 and the editor's `restyle` since #414.

**Use it.**
```js
const { Mascot, setMotion } = window.Kelpie.mascot;
const m = new Mascot(host, { mascot: look, px: 48, mode: "header" });
m.setState("working", { activity: "vault" });  // the pose, with its announcement
m.setState("idle", { instant: true });          // from the keyboard: the pose only
m.setState("idle", { quiet: true });            // an expiry or a deny: the pose, with no announcement
m.restyle(look, "shape");                       // the AgentEditor tries a look on: a crossfade, and the part moves
m.arrive();                                     // a reply lands: a smile and a hop
setMotion("alive" | "states" | "still");        // the pause, for every mascot on the page
```
- **The consumer provides** the host element, sized to the mascot's box before the figure arrives, so nothing in the layout moves; the agent's `mascot` setting (five axes, validated with `isDrawable`); the size; and the state.
- **Modes:** `header` for the conversation's 48 px, `list` for a 36 px roster row (one gesture at a time across the list), `large` for 160 px, `still` for a pose with no life (the switcher list, a task card, the ConfirmCard's figure, the AgentEditor's tiles).
- **A new agent starts with a random mascot,** saved as its setting, which the owner edits from there (AgentEditor, ADR-0056). An agent created before shows a mascot derived from its id until its first edit saves one. Master starts as Kelpie: `mark`, `kelp`, `big` eyes, round ears and no accessory (ADR-0049).
- **States:** `idle`, `dozing` (on its own after 45 s), `listening`, `typing`, `working` with an activity (`search`, `vault`, `code`, `calendar`, `email`, `think`), `waiting`, `approved` (1.1 s, then what comes next), `error`, `noResponse`, and `offline` (ADR-0047): the page lost its connection, so every mascot that shows a state holds the plug that came out beside a solid `muted` bubble with a struck-through plug. Leaving `offline` plays the return: the plug clicks home, with a small hop and a blink.
- **Body colors** are the `mascot-*` tokens, one value in every theme. None is amber, which means the owner needs to act.

**Sizes.**

| Where | Size | What changes |
|---|---|---|
| Roster | 36 px | no mouth or brows, eyes 15% larger, no mittens; a glossy badge takes the bubble's place: `warm` for waiting, `danger` for error, `accent` with the tool's icon for working, `muted` for offline. One gesture at a time across the list, every 7 to 16 s, never a hop |
| Switcher list | 36 px | the Idle pose, still, with no badge |
| Task card | 20 px | the shape, the color and the eyes only; still |
| Conversation header | 48 px | its home; everything happens inside its box |
| Empty conversation, profile, the expired-login dialog | 160 px | gestures a little more often |
| Agent editor | 56 px in its frame, 160 px in its preview (120 on the phone), 46 px tiles | the tiles are still, each drawing one option on this agent |
| Telegram bot photo | 800 px square | a still, and a loop Telegram plays (ADR-0046) |

**Never:** words in its bubbles (a glyph: `?`, `!`, `…`, a struck-through plug); a sound; a character that wanders the screen; an activity that isn't happening.

**Reduced motion means Still:** the state's pose, no breathing, announcement or repertoire, and a 150 ms crossfade on a change; Offline keeps its plug in its mitten. The pause (Alive, States only, Still) is the owner's, and reduced motion overrides it.
