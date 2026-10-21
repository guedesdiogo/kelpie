/* Kelpie: the agent mascot engine (ADR-0045) and the previews' motion helpers, as one classic script.
 * The engine is apps/ingress/public/webchat/mascot*.js as of 909fc2b, unchanged
 * but for its import and export lines.
 * window.Kelpie.mascot is the engine; window.Kelpie.ui the helpers. */
(function () {
  "use strict";
  var states = (function () {
// The mascot's states, poses and scheduling (ADR-0045 §6): plain data and pure functions, so they
// run the same in the browser and in tests. mascot.js draws and moves the figure from them.

/** The pause setting (ADR-0045 §6, WCAG 2.2.2): Alive is the default. */
const MOTIONS = ["alive", "states", "still"];

/** Reduced motion means Still: the setting can't pick Alive or States only then. */
function effectiveMotion(chosen, reduced) {
  if (reduced) return "still";
  return MOTIONS.includes(chosen) ? chosen : "alive";
}

/** An idle mascot dozes after this long without an event for its agent. */
const SLEEP_MS = 45_000;
/** "States only" keeps the announcements, and each ends within this long. */
const ANNOUNCEMENT_MS = 5_000;
/** The approval's pose lasts this long, then the mascot goes back to work (ADR-0045 §6). */
const APPROVED_MS = 1_100;
/** A confirmation's notice waits for the owner's press until it expires (ADR-0026 §3). */
const CONFIRMATION_MS = 10 * 60_000;

/**
 * The design system's springs (`docs/design-system.md` §4.2), as WAAPI takes them. A state change
 * uses the moment springs; the repertoire's gestures use the frequent ones.
 */
const SPRINGS = {
  fast: {
    duration: 194,
    easing:
      "linear(0, 0.063, 0.176, 0.323, 0.466, 0.58, 0.687, 0.773, 0.839, 0.884, 0.921, 0.948, 0.965, 0.978, 0.987, 0.993, 0.996, 0.998, 1, 1, 1)",
  },
  base: {
    duration: 266,
    easing:
      "linear(0, 0.052, 0.174, 0.309, 0.441, 0.561, 0.671, 0.754, 0.82, 0.874, 0.912, 0.939, 0.961, 0.975, 0.984, 0.991, 0.995, 0.998, 1, 1, 1)",
  },
  slow: {
    duration: 394,
    easing:
      "linear(0, 0.052, 0.157, 0.291, 0.426, 0.543, 0.649, 0.737, 0.807, 0.859, 0.901, 0.932, 0.954, 0.97, 0.981, 0.989, 0.994, 0.997, 0.999, 1, 1)",
  },
  momentFast: {
    duration: 393,
    easing:
      "linear(0, 0.133, 0.384, 0.656, 0.872, 1.004, 1.074, 1.092, 1.081, 1.057, 1.033, 1.013, 1, 0.993, 0.992, 0.993, 0.995, 0.997, 0.999, 1, 1)",
  },
  moment: {
    duration: 457,
    easing:
      "linear(0, 0.083, 0.254, 0.443, 0.606, 0.745, 0.849, 0.92, 0.966, 0.993, 1.007, 1.013, 1.014, 1.012, 1.01, 1.007, 1.005, 1.003, 1.002, 1.001, 1)",
  },
  pop: {
    duration: 471,
    easing:
      "linear(0, 0.184, 0.513, 0.827, 1.023, 1.112, 1.12, 1.086, 1.045, 1.011, 0.992, 0.985, 0.987, 0.991, 0.996, 1, 1.002, 1.002, 1.001, 1.001, 1)",
  },
};

/** Where the moment grammar applies: a presence change the owner should notice. */
const MOMENTS = new Set(["waiting", "approved", "error"]);

/**
 * What stays on screen in each state, and what reduced motion keeps: where the eyes look, the
 * body's tilt and squash, the eyes' scale and shape, the brows, the mouth, an effect and the
 * bubble beside the head.
 */
const POSES = {
  idle: pose({}),
  dozing: pose({ gaze: [0, 2], sx: 1.02, sy: 0.96, eyes: "closed", fx: "zzz" }),
  listening: pose({ gaze: [-2, 2.5], tilt: -9, eye: 1.06, brows: "up" }),
  typing: pose({ gaze: [2.5, 2.5], mouth: "o" }),
  working: pose({ gaze: [3, 3], tilt: 4, eye: 0.7, brows: "focus" }),
  waiting: pose({ gaze: [0, -1.5], sx: 0.98, sy: 1.03, eye: 1.14, brows: "up", badge: "wait" }),
  approved: pose({ gaze: [0, -1], sy: 1.02, eyes: "happy", mouth: "smile", fx: "spark" }),
  error: pose({
    gaze: [0, 2],
    sx: 1.04,
    sy: 0.93,
    eye: 0.82,
    brows: "worry",
    mouth: "wave",
    badge: "error",
  }),
  // The owner approved it on #366: the task's object rests, and the mascot looks up at the owner
  // beside a still, dashed bubble, as the label's dashed circle (ADR-0044). The
  // webchat doesn't show it: it gets no streamed tokens, so it can't tell a slow model from none.
  noResponse: pose({ gaze: [0, -1.5], tilt: 2, eye: 0.92, brows: "up", badge: "silent" }),
  // Offline (#380): the page lost its connection, so it says that and nothing about the agent
  // (rule 7). It holds the plug that came out and looks at it, puzzled, beside a grey bubble.
  offline: pose({ gaze: [3, 3.5], tilt: 3, eye: 0.96, brows: "up", badge: "offline" }),
};

function pose(over) {
  return {
    gaze: [0, 0],
    tilt: 0,
    sx: 1,
    sy: 1,
    eye: 1,
    eyes: "open",
    brows: "none",
    mouth: "none",
    fx: "none",
    badge: "none",
    ...over,
  };
}

/** The states whose pose holds the task's object. */
const WORKING_STATES = new Set(["working", "noResponse"]);
/** The states whose mittens hold something: the task's object, or offline's plug. */
const HOLDING_STATES = new Set([...WORKING_STATES, "offline"]);

/**
 * The mittens each state keeps, by side; reduced motion keeps them too, so the state still reads.
 * At work, the task's object brings its own mittens (ADR-0045 §10).
 */
const HAND_POSES = {
  listening: { r: "ear" },
  typing: { l: "typeL", r: "typeR" },
  approved: { l: "thumbL", r: "thumbR" },
  error: { l: "cheekL", r: "cheekR" },
  dozing: { r: "pillowR" },
};

/** What the mittens hold for each activity, and where the eyes look at it. */
const ACTIVITIES = {
  search: { gaze: [2, 4] },
  vault: { gaze: [2, 4.5] },
  code: { gaze: [2, 4] },
  calendar: { gaze: [2, 4.5] },
  email: { gaze: [3, 3.5] },
  think: { gaze: [0, -3] },
  plug: { gaze: [3, 3.5] },
};

/** A tool's activity, or thinking for a tool without its own object (ADR-0045 §10). */
function activityOf(value) {
  // The plug is Offline's object, never a tool's.
  return value !== "plug" && Object.hasOwn(ACTIVITIES, value) ? value : "think";
}

/** Breathing in "Alive": its period and depth per state. */
const BREATH = {
  idle: [3600, 0.014],
  dozing: [5200, 0.03],
  listening: [3000, 0.012],
  typing: [2400, 0.012],
  working: [2200, 0.014],
  waiting: [2600, 0.018],
  approved: [2400, 0.012],
  error: [1700, 0.016],
  noResponse: [4200, 0.01],
  offline: [4400, 0.01],
};

/** How deep the breath goes in `state`: a roster row breathes at 60%. */
function breathDepth(state, mode) {
  const [, depth] = BREATH[state] ?? BREATH.idle;
  return mode === "list" ? depth * 0.6 : depth;
}

// What keeps the figure in its frame (ADR-0063). Every motion that lifts it is cut to the room
// above it: the hop, the stretches and the editor's drop-in. The figure stretches and squashes
// about its feet, at y 108 on the grid (mascot.css's transform-origin).
const GROUND = 108;
/** Grid units kept free between the figure's top and its frame's, at rest and in every motion. */
const HEADROOM = 1;
/**
 * The most the figure tilts about its feet, in degrees: listening's pose. The gestures that tilt it
 * stay within this, tiltFlip's 16 included, which turns listening's -9 the other way.
 */
const TILT = 9;

/** How far the state's pose and its breath, at its deepest, stretch the figure upward. */
function stillStretch(state, mode) {
  return POSES[state].sy * (1 + breathDepth(state, mode));
}
/** The most any state's pose and breath stretch it: the frame keeps room for this at rest. */
const STILL_MOST = Math.max(...Object.keys(POSES).map((state) => stillStretch(state)));

/**
 * The hop (Mascot.hop) as data: its lift, a share of its height, with each step's easing, and its
 * squash, keyed over the same time with one easing for the whole hop.
 */
const HOP = {
  lift: [
    [0, 0],
    [0.2, 0, "cubic-bezier(.2,.7,.4,1)"],
    [0.52, 1, "cubic-bezier(.6,0,.8,.4)"],
    [0.84, 0],
    [1, 0],
  ],
  squash: [
    [0, 1, 1],
    [0.2, 1.08, 0.9],
    [0.4, 0.95, 1.07],
    [0.66, 1, 1],
    [0.86, 1.08, 0.9],
    [1, 1.08, 0.9],
  ],
  squashEasing: "cubic-bezier(.42,0,.58,1)",
};

/** A CSS cubic-bezier() as a function of time, as the browser plays it. */
function bezier(easing) {
  const [x1, y1, x2, y2] = easing.match(/[\d.]+/g).map(Number);
  const at = (s, a, b) => 3 * (1 - s) ** 2 * s * a + 3 * (1 - s) * s * s * b + s ** 3;
  return (x) => {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 32; i++) {
      const s = (lo + hi) / 2;
      if (at(s, x1, x2) < x) lo = s;
      else hi = s;
    }
    return at((lo + hi) / 2, y1, y2);
  };
}

/** A keyframe track's value at `p`, each step eased as `easing` gives it. */
function keyed(track, p, value, easing) {
  for (let i = 1; i < track.length; i++) {
    const [o0] = track[i - 1];
    const [o1] = track[i];
    if (p <= o1)
      return (
        value(track[i - 1]) +
        (value(track[i]) - value(track[i - 1])) * easing(track[i - 1])((p - o0) / (o1 - o0))
      );
  }
  return value(track.at(-1));
}

const linear = (t) => t;
const squashEase = bezier(HOP.squashEasing);
/** The hop sampled over its time: [lift, squash's height] at each step. */
const HOP_STEPS = Array.from({ length: 241 }, (_, i) => {
  const p = i / 240;
  return [
    keyed(
      HOP.lift,
      p,
      ([, y]) => y,
      ([, , easing]) => (easing ? bezier(easing) : linear),
    ),
    keyed(
      HOP.squash,
      squashEase(p),
      ([, , sy]) => sy,
      () => linear,
    ),
  ];
});

/** How far a hop of height `h` lifts the top of a figure whose top is at `top`, at most. */
function hopRise(top, h, stretch) {
  let rise = 0;
  for (const [lift, sy] of HOP_STEPS) {
    rise = Math.max(rise, (GROUND - top) * stretch * (sy - 1) + h * lift);
  }
  return rise;
}

/** How far stretching the figure to `sy` of its height lifts its top. */
function stretchRise(top, sy, stretch) {
  return Math.max(0, (GROUND - top) * stretch * (sy - 1));
}

/**
 * The share of a motion that fits under `ceiling`: the figure, at rest with its top at `top` and
 * stretched by its pose and breath, has some room above it, and the motion would lift it by `rise`
 * grid units at most. A motion lifts the figure in proportion to its share, so a share of it lifts
 * it by that share of `rise`.
 */
function liftShare(top, ceiling, stretch, rise) {
  if (rise <= 0) return 1;
  const room = GROUND - (GROUND - top) * stretch - ceiling - HEADROOM;
  return Math.min(1, Math.max(0, room / rise));
}

/** Gestures that need a moment since the last of their kind. */
const HOP_EVERY_MS = 12_000;
const WAKE_EVERY_MS = 20_000;

const gesture = (name, weight, options = {}) => ({ name, weight, ...options });
const hasEars = (figure) => figure.ears > 0;
const canHop = (figure) => figure.sinceHop > HOP_EVERY_MS;

/**
 * Each state's repertoire (ADR-0045 §6), drawn by weight. `list` marks what a roster row may do,
 * and `need` what the figure or the time since a gesture must allow.
 */
const REPERTOIRES = {
  idle: [
    gesture("blink", 3, { list: true }),
    gesture("glance", 2, { list: true }),
    gesture("lookAround", 1.2),
    gesture("lookYou", 1.2),
    gesture("wiggle", 1.2),
    gesture("ear", 1.4, { list: true, need: hasEars }),
    gesture("hop", 1.2, { need: canHop }),
    gesture("doubleHop", 0.6, { need: canHop }),
    gesture("stretch", 1),
    gesture("scratch", 1.2),
    gesture("yawn", 0.7),
  ],
  dozing: [
    gesture("snore", 3, { list: true }),
    gesture("stir", 2, { list: true }),
    gesture("wakeBored", 1.6, { need: (figure) => figure.sinceWake > WAKE_EVERY_MS }),
  ],
  listening: [
    gesture("ear", 2, { need: hasEars }),
    gesture("tiltFlip", 1.6),
    gesture("blink", 1.4),
    gesture("nod", 1.4),
  ],
  typing: [gesture("talk", 2), gesture("blink", 1)],
  working: [gesture("blink", 2, { list: true }), gesture("nod", 0.8)],
  waiting: [
    gesture("callAttention", 2),
    gesture("sway", 2, { list: true }),
    gesture("lookYou", 1.5),
    gesture("impatient", 1.5, { list: true }),
    gesture("lookAtCard", 1.5),
    gesture("pulse", 1.2, { list: true }),
    gesture("blink", 0.8, { list: true }),
  ],
  approved: [],
  error: [
    gesture("sweat", 2, { list: true }),
    gesture("tremble", 1.6, { list: true }),
    gesture("plead", 1.6),
    gesture("sigh", 1.5),
    gesture("shake", 1, { list: true }),
    gesture("callHelp", 1.4),
    gesture("lookDown", 1),
  ],
  noResponse: [],
  // Calm, and without a hop: the owner may be worried about the connection already.
  offline: [
    gesture("blink", 2, { list: true }),
    gesture("glance", 1.2, { list: true }),
    gesture("lookAtPlug", 1.6),
    gesture("tryPlug", 1.4),
    gesture("shakePlug", 1),
    gesture("lookAround", 1),
    gesture("sigh", 0.8),
    gesture("yawn", 0.5),
  ],
};

/** The gestures a mascot may draw now: its size's, and those its figure and timing allow. */
function available(state, mode, figure) {
  return (REPERTOIRES[state] ?? []).filter(
    (option) => (mode !== "list" || option.list) && (!option.need || option.need(figure)),
  );
}

/**
 * Draws a gesture by weight, never one of the last two. With only two to draw from, it never
 * repeats the last one; with one, it plays that one.
 */
function draw(options, recent, random = Math.random) {
  if (options.length === 0) return null;
  const avoid = recent.slice(0, Math.min(2, options.length - 1));
  const pool = options.filter((option) => !avoid.includes(option.name));
  let left = random() * pool.reduce((sum, option) => sum + option.weight, 0);
  for (const option of pool) {
    left -= option.weight;
    if (left < 0) return option.name;
  }
  return pool.at(-1).name;
}

/** The last two gestures, newest first. */
function remember(recent, name) {
  return [name, ...recent].slice(0, 2);
}

/** How long a mascot rests between gestures in a state, by its size. */
const GAPS = {
  idle: [2500, 6000],
  dozing: [5000, 10000],
  listening: [1500, 3000],
  typing: [1300, 2600],
  working: [2500, 5000],
  waiting: [3000, 6000],
  error: [3000, 6000],
  offline: [4000, 8000],
};

function gapAfter(state, mode, random = Math.random) {
  const [low, high] = GAPS[state] ?? GAPS.idle;
  // The roster's rows gesture every 7 to 16 s instead of every 4 to 9 s (ADR-0045 §4).
  const scale = mode === "list" ? 2.2 : mode === "large" ? 0.85 : 1;
  return (low + random() * (high - low)) * scale;
}

/** One gesture at a time across a roster: the next row waits this long. */
const LIST_LOCK_MS = 2_500;
/** While the owner types, the conversation's mascot only breathes and blinks this often. */
const QUIET_BLINK_MS = 1_500;

/**
 * What the shared timer does for one mascot at `now` (ADR-0045 §6): nothing in a hidden tab, off
 * screen, or under any setting but Alive; doze an idle mascot after 45 s without an event; blink
 * only while the owner types; else draw a gesture when its rest is over, one roster row at a time.
 */
function due(mascot, world) {
  if (world.hidden || world.motion !== "alive" || !mascot.visible || mascot.mode === "still") {
    return "rest";
  }
  if (mascot.state === "idle" && world.now - mascot.lastEvent > SLEEP_MS) return "doze";
  if (world.now < mascot.nextGesture) return "rest";
  if (mascot.quietable && world.now < world.quietUntil) return "blink";
  if (mascot.mode === "list" && world.now < world.listLock) return "defer";
  return "gesture";
}

/** Whether a mascot breathes: only in "Alive", visible, in a tab that shows. */
function breathes(mascot, world) {
  return world.motion === "alive" && mascot.mode !== "still" && mascot.visible && !world.hidden;
}

/**
 * An animation's timing as the setting lets it play: unchanged in "Alive"; in "States only",
 * an announcement cut to the iterations that end within 5 s, or null when none does; null in
 * "Still".
 */
function allowed(timing, motion) {
  if (motion === "alive") return timing;
  if (motion !== "states") return null;
  const delay = timing.delay ?? 0;
  const fits = Math.floor((ANNOUNCEMENT_MS - delay) / timing.duration);
  if (fits < 1) return null;
  const iterations = Math.min(timing.iterations ?? 1, fits);
  return { ...timing, iterations };
}

/**
 * The mascot's state from what the conversation shows (ADR-0045 §6, §10), for the webchat's
 * header. `event` is a socket frame, or `{ type: "sent" }` for the owner's message.
 *
 * - A turn's steps are working, with the tool's activity, or thinking between tools.
 * - Typing is the reply being written; a running tool takes precedence over it.
 * - A confirmation's notice waits for the owner; their yes is approved, then work goes on.
 * - The notice of a turn no route answered is an error, until the next message or turn. The
 *   turn settles right after it, and that clears only the step.
 * - The wait before a reply, where its bar shows (ADR-0045 §5), is listening; its end goes back
 *   to idle, unless typing or work has taken over.
 * - A lost socket changes nothing at once; when the banner enters, 2 s later, every mascot shows
 *   Offline (ADR-0047). The history of a new socket ends it.
 */
function presenceAfter(presence, event) {
  switch (event.type) {
    case "status":
      if (event.status === "idle") {
        return presence.state === "error" || presence.state === "waiting" ? presence : idle();
      }
      if (event.status === "tool") {
        return { state: "working", activity: activityOf(event.activity), tool: true };
      }
      if (event.status === "memory") return { state: "working", activity: "vault", tool: false };
      if (event.status === "thinking") return { state: "working", activity: "think", tool: false };
      return presence;
    case "typing":
      if (presence.tool) return presence;
      if (event.active) return { state: "typing", activity: null, tool: false };
      return presence.state === "typing" ? idle() : presence;
    case "bubble":
      if (event.failed) return { state: "error", activity: null, tool: false };
      if (Number.isSafeInteger(event.confirmation)) {
        return { state: "waiting", activity: null, tool: false };
      }
      return idle();
    case "wait":
      if (event.deadline?.remainingMs > 0) {
        return presence.state === "working" || presence.state === "typing"
          ? presence
          : { state: "listening", activity: null, tool: false };
      }
      return presence.state === "listening" ? idle() : presence;
    // The open confirmations (ADR-0052 §4): after a reconnect, one still open is still waited on.
    case "requests":
      if (Array.isArray(event.requests) && event.requests.length > 0) {
        return presence.state === "working" || presence.state === "typing"
          ? presence
          : { state: "waiting", activity: null, tool: false };
      }
      return presence.state === "waiting" ? idle() : presence;
    case "confirmation":
      return event.status === "accepted"
        ? { state: "approved", activity: null, tool: false }
        : idle();
    // The owner's message ends a wait or an error; a turn already running goes on showing.
    case "sent":
      return presence.state === "working" || presence.state === "typing" ? presence : idle();
    // A pause holds every answer, and a new socket starts from the history.
    case "paused":
    case "history":
      return idle();
    case "offline":
      return { state: "offline", activity: null, tool: false };
    default:
      return presence;
  }
}

function idle() {
  return { state: "idle", activity: null, tool: false };
}

const IDLE = idle();

const same = (a, b) => a.state === b.state && a.activity === b.activity && a.tool === b.tool;

/**
 * Keeps the conversation's presence over time and calls `show` on each change: the approval's
 * pose for 1.1 s, then what arrived meanwhile; a wait that ends when the confirmation expires.
 * `show` also learns how: `instant` for a change the keyboard caused (§4.1), `quiet` for an expiry
 * or a refused press, which bring no announcement (5.3).
 *
 * @param {(presence: { state: string, activity: string | null, tool: boolean }, how: { instant?: boolean, quiet?: boolean }) => void} show
 * @param {{ set: (run: () => void, ms: number) => unknown, clear: (timer: unknown) => void }} [timers]
 */
function presenceKeeper(
  show,
  timers = { set: (run, ms) => setTimeout(run, ms), clear: (timer) => clearTimeout(timer) },
) {
  let presence = IDLE;
  let afterApproval = IDLE;
  let timer = null;
  const apply = (next, how = {}, waitMs = CONFIRMATION_MS) => {
    timers.clear(timer);
    timer = null;
    presence = next;
    show(presence, how);
    if (presence.state === "approved") {
      afterApproval = IDLE;
      timer = timers.set(() => apply(afterApproval), APPROVED_MS);
    } else if (presence.state === "waiting") {
      timer = timers.set(() => apply(IDLE, { quiet: true }), waitMs);
    }
  };
  // A notice waits its 10 minutes; the open list says how long each confirmation has left.
  const waitOf = (event) =>
    event.type === "requests" && event.requests.length > 0
      ? Math.max(...event.requests.map((request) => request.expiresInMs))
      : CONFIRMATION_MS;
  return {
    get current() {
      return presence;
    },
    event(event, { instant = false } = {}) {
      if (presence.state === "approved") {
        afterApproval = presenceAfter(afterApproval, event);
        return;
      }
      const next = presenceAfter(presence, event);
      // A new notice while one waits starts its own 10 minutes.
      const renewed = next.state === "waiting" && event.type === "bubble";
      const refused = event.type === "confirmation" && event.status !== "accepted";
      if (renewed || !same(next, presence)) apply(next, { instant, quiet: refused }, waitOf(event));
    },
  };
}

  return { MOTIONS, effectiveMotion, SLEEP_MS, ANNOUNCEMENT_MS, APPROVED_MS, CONFIRMATION_MS, SPRINGS, MOMENTS, POSES, WORKING_STATES, HOLDING_STATES, HAND_POSES, ACTIVITIES, activityOf, BREATH, breathDepth, GROUND, HEADROOM, TILT, stillStretch, STILL_MOST, HOP, hopRise, stretchRise, liftShare, REPERTOIRES, available, draw, remember, gapAfter, LIST_LOCK_MS, QUIET_BLINK_MS, due, breathes, allowed, presenceAfter, IDLE, presenceKeeper };
  })();
  var art = (function () {
// The mascot's figure as data (ADR-0045 §2, §3, §10): shapes, eyes, heads, accessories, mittens,
// the task's objects and the bubbles, built as one SVG string for any combination. The ids are
// @kelpie/config's. Soft parts are "pieces": mascot.js paints their fur once per piece and size,
// and until then their flat vectors show.
//
// The page's content policy refuses inline style attributes, so nothing here writes one: colors
// are presentation attributes or classes in mascot.css, and mascot.js sets what varies through
// the CSSOM.

const { GROUND, HEADROOM, STILL_MOST, TILT } = states;

/**
 * Every mascot's frame on the 120 grid (ADR-0063): the box it draws in, with room above the tallest
 * heads for their hops. It keeps the ground and the middle where `10 14 100 100` had them.
 */
const FRAME = { x: 4, y: 2, size: 112 };

/**
 * What shows beside the figure floats past the frame on purpose (ADR-0065): the speech bubble, the
 * badge, the thought bubbles, the sparks and the "z"s. This is how far, in grid units past each side
 * of FRAME, at rest and through their own motion, per size class (sizeOf). Each host keeps that
 * much room free around the box for what it shows.
 */
const MARGIN = {
  s: { top: 17, right: 13.5, bottom: 14.5 },
  m: { top: 17, right: 13.5, bottom: 0 },
  l: { top: 17, right: 10.5, bottom: 0 },
};

/** The ink of the eyes and lines, and the mix the fur's shades come from. */
const INK = "#0C2523";

const rgb = (hex) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));

/** `a` mixed toward `b` by `t`, in sRGB, so a painted fur layer needs no CSS. */
function mix(a, b, t) {
  const to = rgb(b);
  const channels = rgb(a).map((value, i) => Math.round(value + (to[i] - value) * t));
  return `#${channels.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

/** The body's shades from its color token's value. */
function palette(hex) {
  const body = hex.toLowerCase();
  return {
    body,
    light: mix(body, "#ffffff", 0.2),
    edge: mix(body, INK, 0.22),
    dark: mix(body, INK, 0.34),
    darkish: mix(body, INK, 0.2),
  };
}

/** A rectangle with its own radius at each corner: top left, top right, bottom right, bottom left. */
const rounded = (x, y, w, h, [a, b, c, d]) =>
  `M${x + a},${y} H${x + w - b} A${b},${b} 0 0 1 ${x + w},${y + b} V${y + h - c} A${c},${c} 0 0 1 ${x + w - c},${y + h} H${x + d} A${d},${d} 0 0 1 ${x},${y + h - d} V${y + a} A${a},${a} 0 0 1 ${x + a},${y} Z`;
const ellipse = (cx, cy, rx, ry) =>
  `M${cx - rx},${cy} a${rx},${ry} 0 1,0 ${2 * rx},0 a${rx},${ry} 0 1,0 ${-2 * rx},0 Z`;
const circle = (cx, cy, r) => ellipse(cx, cy, r, r);
/** A path mirrored across its y axis; every point is an absolute "x,y" pair. */
const mirror = (d) => d.replace(/(-?[\d.]+),/g, (_, x) => `${-x},`);

/**
 * The pointed ear (#455): a kelpie's left ear traced from a photo, with a domed top, an outer edge
 * nearly upright, a straight inner diagonal and a light shell inside, so it reads as an ear and
 * not a horn. The origin is the middle of its base, EAR_LIFT above the shape's ear anchor; the
 * right ear mirrors it. The shell's color is the body's mixed toward cream, the opening in every
 * color.
 */
const POINTED_EAR =
  "M10,-1.7 L3.8,7.7 L-8.7,6.1 L-10,1.7 C-10,-0.7 -9.5,-3.4 -7.9,-8.2 L-2.7,-22 C-2.1,-23.5 -1.2,-24.1 0,-24 C2,-23.7 4.5,-21.6 5,-19.8 L10,-1.7 Z";
const POINTED_SHELL =
  "M-7.9,-2.5 C-7.1,-7 -5.4,-11.8 -3.6,-14.7 C-2.3,-16.4 -0.7,-17.3 0.8,-17.1 C2.5,-15.8 3.8,-12.1 5,-8.3 C5.9,-5.1 6.5,-2.2 6.2,0.5 Z";
const SHELL_CREAM = "#FFF1DD";
const EAR_LIFT = 2.8;

/**
 * A shape's pointed ears as outlines on the 120 grid, left then right, for a drawing that flattens
 * the mascot: the logo (ADR-0062, scripts/brand-icons.mjs) takes Master's from here.
 */
function pointedEarOutlines(shapeName) {
  const shape = SHAPES[shapeName];
  const round = (value) => Math.round(value * 1000) / 1000;
  return (shape.pointed ?? shape.ears).map(([x, y, a]) => {
    const r = (a * Math.PI) / 180;
    return (a < 0 ? POINTED_EAR : mirror(POINTED_EAR)).replace(
      /(-?[\d.]+),(-?[\d.]+)/g,
      (_, px, py) =>
        `${round(x + px * Math.cos(r) - py * Math.sin(r))},${round(y - EAR_LIFT + px * Math.sin(r) + py * Math.cos(r))}`,
    );
  });
}

/**
 * How far a soft part's painted fur reaches past its outline, in grid units. Headless Chrome read
 * the painted pixels at least 25% opaque on #474: up to 2.4 past an outline at 36 and 160 px.
 */
const FUR_REACH = 2.5;

/** An SVG transform attribute as a matrix [a, b, c, d, e, f]. */
function matrixOf(transform = "") {
  let m = [1, 0, 0, 1, 0, 0];
  const times = ([a, b, c, d, e, f]) =>
    (m = [
      m[0] * a + m[2] * b,
      m[1] * a + m[3] * b,
      m[0] * c + m[2] * d,
      m[1] * c + m[3] * d,
      m[0] * e + m[2] * f + m[4],
      m[1] * e + m[3] * f + m[5],
    ]);
  for (const [, name, args] of transform.matchAll(/(\w+)\(([^)]*)\)/g)) {
    const [p = 0, q, r] = args.match(/-?[\d.]+/g).map(Number);
    if (name === "translate") times([1, 0, 0, 1, p, q ?? 0]);
    if (name === "scale") times([p, 0, 0, q ?? p, 0, 0]);
    if (name === "rotate") {
      const a = (p * Math.PI) / 180;
      times([1, 0, 0, 1, q ?? 0, r ?? 0]);
      times([Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]);
      times([1, 0, 0, 1, -(q ?? 0), -(r ?? 0)]);
    }
  }
  return m;
}

/** Points along a path's outline, curves and arcs sampled, enough to find how far it reaches. */
function outline(d) {
  const ARITY = { M: 2, L: 2, H: 1, V: 1, C: 6, Q: 4, A: 7, Z: 0 };
  const steps = 16;
  const points = [];
  let [x, y, sx, sy] = [0, 0, 0, 0];
  for (const [, command, args] of d.matchAll(/([a-zA-Z])([^a-zA-Z]*)/g)) {
    const all = (args.match(/-?(?:\d+\.?\d*|\.\d+)/g) ?? []).map(Number);
    const rel = command !== command.toUpperCase();
    let C = command.toUpperCase();
    for (let i = 0; i === 0 || i < all.length; i += ARITY[C] || 1) {
      const n = all.slice(i, i + ARITY[C]);
      const at = (j) => [n[j] + (rel ? x : 0), n[j + 1] + (rel ? y : 0)];
      if (C === "Z") [x, y] = [sx, sy];
      if (C === "M" || C === "L") [x, y] = at(0);
      if (C === "M") [sx, sy] = [x, y];
      if (C === "H") x = n[0] + (rel ? x : 0);
      if (C === "V") y = n[0] + (rel ? y : 0);
      if (C === "Q" || C === "C") {
        const ps = [[x, y], at(0), at(2), ...(C === "C" ? [at(4)] : [])];
        for (let k = 1; k <= steps; k++) {
          // De Casteljau: the curve's point at t.
          const t = k / steps;
          let row = ps;
          while (row.length > 1) {
            row = row
              .slice(1)
              .map(([px, py], j) => [
                row[j][0] + (px - row[j][0]) * t,
                row[j][1] + (py - row[j][1]) * t,
              ]);
          }
          points.push(row[0]);
        }
        [x, y] = ps.at(-1);
      }
      if (C === "A") points.push(...arc([x, y], n.slice(0, 5), at(5), 2 * steps));
      if (C === "A") [x, y] = at(5);
      points.push([x, y]);
      // Pairs after a moveto are linetos.
      if (C === "M") C = "L";
    }
  }
  return points;
}

/** Points along an arc from `from` to `to`, its centre found as SVG's implementation notes (F.6.5) do. */
function arc([x1, y1], [rx0, ry0, turn, large, sweep], [x2, y2], steps) {
  // A radius of 0 makes the arc a straight line.
  if (!rx0 || !ry0) return [[x2, y2]];
  const phi = (turn * Math.PI) / 180;
  const [cos, sin] = [Math.cos(phi), Math.sin(phi)];
  const x1p = (cos * (x1 - x2)) / 2 + (sin * (y1 - y2)) / 2;
  const y1p = (-sin * (x1 - x2)) / 2 + (cos * (y1 - y2)) / 2;
  const grow = Math.max(1, Math.hypot(x1p / rx0, y1p / ry0));
  const [rx, ry] = [rx0 * grow, ry0 * grow];
  const cross = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const k =
    (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, (rx * rx * ry * ry - cross) / cross));
  const cxp = (k * rx * y1p) / ry;
  const cyp = (-k * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const t1 = Math.atan2((y1p - cyp) / ry, (x1p - cxp) / rx);
  let dt = Math.atan2((-y1p - cyp) / ry, (-x1p - cxp) / rx) - t1;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  return Array.from({ length: steps }, (_, i) => {
    const t = t1 + (dt * (i + 1)) / steps;
    return [
      cx + rx * cos * Math.cos(t) - ry * sin * Math.sin(t),
      cy + rx * sin * Math.cos(t) + ry * cos * Math.sin(t),
    ];
  });
}

/**
 * The points `svg` draws, in grid units, each with how far it reaches around it: each shape through
 * its groups' transforms, a stroke by half its width and a soft part by its fur's reach. Images are
 * the fur's paintings of the flat shapes beside them, so those shapes stand for them.
 */
function pointsOf(svg) {
  const reached = [];
  const stack = [{ m: [1, 0, 0, 1, 0, 0], fur: false }];
  const shapes = new Set(["path", "circle", "ellipse", "rect"]);
  for (const [, close, tag, attrs, alone] of svg.matchAll(/<(\/?)(\w+)([^>]*?)(\/?)>/g)) {
    // A part drawn with anything else would escape the frame's measure, so it can't be drawn.
    if (!shapes.has(tag) && tag !== "g" && tag !== "image") {
      throw new Error(`The mascot's frame can't measure <${tag}>`);
    }
    if (close) {
      if (!shapes.has(tag)) stack.pop();
      continue;
    }
    const attr = (name) => attrs.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1];
    const parent = stack.at(-1);
    const own = matrixOf(attr("transform"));
    const [a, b, c, d, e, f] = parent.m;
    const m = [
      a * own[0] + c * own[1],
      b * own[0] + d * own[1],
      a * own[2] + c * own[3],
      b * own[2] + d * own[3],
      a * own[4] + c * own[5] + e,
      b * own[4] + d * own[5] + f,
    ];
    const fur = parent.fur || /\bfp\b/.test(attr("class") ?? "");
    const num = (name) => Number(attr(name) ?? 0);
    let points = [];
    if (tag === "path") points = outline(attr("d"));
    if (tag === "circle" || tag === "ellipse") {
      const [rx, ry] = tag === "circle" ? [num("r"), num("r")] : [num("rx"), num("ry")];
      points = outline(
        `M${num("cx") - rx},${num("cy")} A${rx},${ry} 0 1,0 ${num("cx") + rx},${num("cy")} A${rx},${ry} 0 1,0 ${num("cx") - rx},${num("cy")}`,
      );
    }
    if (tag === "rect") {
      const [rx, ry, w, h] = [num("x"), num("y"), num("width"), num("height")];
      points = [
        [rx, ry],
        [rx + w, ry],
        [rx, ry + h],
        [rx + w, ry + h],
      ];
    }
    const reach = (fur ? FUR_REACH : 0) + num("stroke-width") / 2;
    for (const [px, py] of points) {
      reached.push([m[0] * px + m[2] * py + m[4], m[1] * px + m[3] * py + m[5], reach]);
    }
    if (!alone && !shapes.has(tag)) stack.push({ m, fur });
  }
  return reached;
}

/**
 * The highest those points reach as the figure tilts about its feet from `low` to `high` degrees:
 * a degree apart, both ends included.
 */
function crownOf(reached, low, high) {
  const [px, py] = [FRAME.x + FRAME.size / 2, GROUND];
  let top = Number.POSITIVE_INFINITY;
  const angles = Array.from({ length: Math.floor(high - low) + 1 }, (_, i) => low + i);
  for (const degrees of [...angles, high]) {
    const [sin, cos] = [Math.sin((degrees * Math.PI) / 180), Math.cos((degrees * Math.PI) / 180)];
    for (const [x, y, reach] of reached) {
      top = Math.min(top, py + (x - px) * sin + (y - py) * cos - reach);
    }
  }
  return top;
}

/**
 * What the frame measured of each figure, by what it draws less its mascot's own ids: a figure is
 * drawn again and again.
 */
const MEASURED = new Map();

/**
 * The frame a figure draws in, from its top as it tilts by up to TILT either way: FRAME, unless the
 * figure doesn't fit it even at rest, with the most its pose and breath stretch it. Then its own
 * frame, as much taller as it needs, so that figure draws smaller (ADR-0063).
 */
function frameOf(top) {
  const reach = GROUND - (GROUND - top) * STILL_MOST - HEADROOM;
  if (reach >= FRAME.y) return FRAME;
  const size = FRAME.y + FRAME.size - reach;
  return { x: 60 - size / 2, y: reach, size };
}

/**
 * Shapes drawn on a 120 grid and framed by FRAME, so the body fills about 64%; the ground is at
 * y 108. Anchors: the face, the eyes' spread, the top of the head, the ears (x, y, angle),
 * the pointed ears' own where they need lower ones, the hat (x, y, width) and the collar.
 */
const SHAPES = {
  mark: {
    d: rounded(24, 36, 72, 72, [36, 36, 36, 11.5]),
    face: [61, 70],
    spread: 14,
    top: [60, 36],
    ears: [
      [41, 45, -18],
      [79, 45, 18],
    ],
    hat: [60, 44, 46],
    collar: [58, 92],
  },
  bubble: {
    d: "M21,73 A39,35 0 1,1 99,73 A39,35 0 1,1 21,73 Z",
    face: [60, 72],
    spread: 15,
    top: [60, 38],
    ears: [
      [40, 47, -20],
      [80, 47, 20],
    ],
    hat: [60, 46, 50],
    collar: [60, 93],
  },
  drop: {
    d: "M60,22 C64,36 96,52 96,74 A36,34 0 0 1 24,74 C24,52 56,36 60,22 Z",
    face: [60, 79],
    spread: 13,
    mouth: 11,
    top: [60, 23],
    ears: [
      [46, 49, -26],
      [74, 49, 26],
    ],
    hat: [60, 42, 30],
    collar: [60, 98],
  },
  pebble: {
    d: "M60,42 C88,42 101,54 101,76 C101,98 88,108 60,108 C32,108 19,98 19,76 C19,54 32,42 60,42 Z",
    face: [60, 76],
    spread: 16,
    top: [60, 42],
    ears: [
      [38, 51, -16],
      [82, 51, 16],
    ],
    hat: [60, 48, 50],
    collar: [60, 95],
  },
  buoy: {
    d: rounded(31, 28, 58, 80, [29, 29, 24, 24]),
    face: [60, 62],
    spread: 12,
    top: [60, 28],
    ears: [
      [44, 36, -12],
      [76, 36, 12],
    ],
    pointed: [
      [38, 45, -18],
      [82, 45, 18],
    ],
    hat: [60, 36, 40],
    collar: [60, 86],
  },
  jellyfish: {
    d: "M22,72 C22,49 39,36 60,36 C81,36 98,49 98,72 V100 Q85.33,116 72.67,100 Q60,116 47.33,100 Q34.67,116 22,100 Z",
    face: [60, 68],
    spread: 15,
    top: [60, 36],
    ears: [
      [40, 45, -20],
      [80, 45, 20],
    ],
    hat: [60, 44, 46],
    collar: [60, 89],
  },
  cloud: {
    d: "M32,108 C22,108 18,100 19,92 C12,88 12,76 20,72 C18,60 28,52 39,55 C42,44 52,39 61,40 C71,40 79,46 81,55 C92,53 101,61 99,72 C107,77 107,90 100,94 C101,103 95,108 88,108 Z",
    face: [60, 78],
    spread: 15,
    top: [61, 41],
    ears: [
      [39, 58, -28],
      [82, 58, 28],
    ],
    hat: [61, 47, 40],
    collar: [60, 97],
  },
  dune: {
    d: "M60,32 C66,32 70,36 74,43 L96,90 C100,99 95,108 85,108 L35,108 C25,108 20,99 24,90 L46,43 C50,36 54,32 60,32 Z",
    face: [60, 80],
    spread: 13,
    mouth: 11,
    top: [60, 33],
    ears: [
      [49, 46, -22],
      [71, 46, 22],
    ],
    hat: [60, 44, 28],
    collar: [60, 97],
  },
  star: {
    d: "M52.7,36.7 Q60,21.8 67.3,36.7 Q74.7,51.6 91.1,54 Q107.6,56.4 95.7,67.9 Q83.8,79.5 86.6,95.9 Q89.4,112.3 74.7,104.5 Q60,96.8 45.3,104.5 Q30.6,112.3 33.4,95.9 Q36.2,79.5 24.3,67.9 Q12.4,56.4 28.9,54 Q45.3,51.6 52.7,36.7 Z",
    face: [60, 70],
    spread: 11,
    mouth: 12,
    top: [60, 31],
    ears: [
      [51, 42, -16],
      [69, 42, 16],
    ],
    hat: [60, 40, 22],
    collar: [60, 85],
  },
  heart: {
    d: "M60,108 C40,96 20,82 20,62 C20,49 30,41 41,41 C50,41 56,47 60,54 C64,47 70,41 79,41 C90,41 100,49 100,62 C100,82 80,96 60,108 Z",
    face: [60, 64],
    spread: 14,
    mouth: 12,
    top: [60, 52],
    ears: [
      [38, 48, -18],
      [82, 48, 18],
    ],
    hat: [60, 50, 40],
    collar: [60, 86],
  },
  bean: {
    d: "M30,60 C38,46 54,48 62,50 C72,52 80,44 92,52 C104,60 104,96 84,104 C70,110 46,110 32,104 C14,96 18,72 30,60 Z",
    face: [58, 79],
    spread: 15,
    top: [60, 49],
    ears: [
      [38, 58, -22],
      [84, 55, 20],
    ],
    hat: [62, 52, 44],
    collar: [60, 99],
  },
  block: {
    d: rounded(22, 40, 76, 68, [18, 18, 16, 16]),
    face: [60, 72],
    spread: 16,
    top: [60, 40],
    ears: [
      [34, 47, -10],
      [86, 47, 10],
    ],
    hat: [60, 44, 56],
    collar: [60, 97],
  },
};

/** The body colors' token names; their values are `--mascot-*` in mascot.css. */
const COLORS = [
  "kelp",
  "lagoon",
  "tide",
  "sky",
  "indigo",
  "anemone",
  "pink",
  "fawn",
  "cocoa",
  "moss",
  "lime",
  "slate",
];

const pupil = (r, h) =>
  `<g class="m-pupil"><circle class="eink" r="${r}"/><circle class="wht" cx="${-r * 0.34}" cy="${-r * 0.38}" r="${h}"/><circle class="wht" cx="${r * 0.36}" cy="${r * 0.34}" r="${h * 0.4}" opacity=".7"/></g>`;
/** The crease of shadow where an eye meets the fur, and the highlight that stays on the eyeball. */
const crease = (rx, ry) => `<ellipse class="eao" rx="${rx * 1.32}" ry="${ry * 1.32}"/>`;
const gloss = (rx, ry) =>
  `<ellipse class="espec" cx="${-rx * 0.34}" cy="${-ry * 0.4}" rx="${rx * 0.5}" ry="${ry * 0.38}" transform="rotate(-28 ${-rx * 0.34} ${-ry * 0.4})"/>`;
const STAR =
  "M-1,-5.2 Q0,-7.6 1,-5.2 Q2,-2.8 4.6,-2.5 Q7.2,-2.3 5.2,-.6 Q3.2,1.1 3.9,3.6 Q4.5,6.1 2.2,4.8 Q0,3.4 -2.2,4.8 Q-4.5,6.1 -3.9,3.6 Q-3.2,1.1 -5.2,-.6 Q-7.2,-2.3 -4.6,-2.5 Q-2,-2.8 -1,-5.2 Z";

/** Eyes: their half height, and whether there is one, it sits on top, or it has a pupil. */
const EYES = {
  dots: {
    height: 5.6,
    draw: () =>
      `${crease(4.6, 5.6)}<ellipse class="eink" rx="4.6" ry="5.6"/>${gloss(4.6, 5.6)}<circle class="wht" cx="-1.5" cy="-2.4" r="1.1"/>`,
  },
  pills: {
    height: 7.5,
    draw: () =>
      `${crease(3.8, 7.6)}<rect class="eink" x="-3.4" y="-7.5" width="6.8" height="15" rx="3.4"/><rect class="wht" x="-2.1" y="-6" width="1.5" height="4.2" rx=".75" opacity=".9"/>`,
  },
  shine: {
    height: 6.5,
    draw: () =>
      `${crease(6.5, 6.5)}<circle class="eink" r="6.5"/>${gloss(6.5, 6.5)}<circle class="wht" cx="-2.2" cy="-2.5" r="1.9"/><circle class="wht" cx="2.3" cy="2.4" r=".8" opacity=".7"/>`,
  },
  marbles: {
    height: 8,
    pupil: true,
    draw: () => `${crease(8, 8)}<circle class="scl" r="8"/>${pupil(4.2, 1.3)}${gloss(8, 8)}`,
  },
  cyclops: {
    height: 12.5,
    one: true,
    pupil: true,
    draw: () =>
      `${crease(12.5, 12.5)}<circle class="scl" r="12.5"/>${pupil(6.6, 2.1)}${gloss(12.5, 12.5)}`,
  },
  "half-moon": {
    height: 5,
    draw: () =>
      `${crease(6.5, 4.5)}<path class="eink" d="M-6.5,-1.5 H6.5 A6.5,6.5 0 0 1 -6.5,-1.5 Z"/><circle class="wht" cx="-2.6" cy="1.4" r="1.3"/>`,
  },
  frog: {
    height: 9.5,
    top: true,
    wide: 4,
    pupil: true,
    draw: () =>
      `${crease(9.5, 9.5)}<circle class="scl" r="9.5"/>${pupil(4.8, 1.5)}${gloss(9.5, 9.5)}`,
  },
  stars: {
    height: 6.4,
    draw: () =>
      `${crease(6.2, 6.2)}<path class="eink" d="${STAR}"/><circle class="wht" cx="-1.4" cy="-1.6" r="1.1"/>`,
  },
  big: {
    height: 8,
    draw: () =>
      `${crease(5.8, 8)}<ellipse class="eink" rx="5.8" ry="8"/>${gloss(5.8, 8)}<circle class="wht" cx="-2" cy="-3.4" r="2.2"/><circle class="wht" cx="2" cy="3" r="1" opacity=".75"/>`,
  },
  buttons: {
    height: 6.2,
    draw: () =>
      `${crease(6.2, 6.2)}<circle class="eink" r="6.2"/><circle class="btn-r" r="4.3"/>${[
        [-1.5, -1.5],
        [1.5, -1.5],
        [-1.5, 1.5],
        [1.5, 1.5],
      ]
        .map(([x, y]) => `<circle class="btn-h" cx="${x}" cy="${y}" r=".95"/>`)
        .join("")}${gloss(6.2, 6.2)}`,
  },
};

/** What sits on the head, and the accessories: each type with its variations. */
const HEADS = {
  none: [],
  ears: ["pointed", "floppy", "round"],
  horns: ["two", "one", "antennae"],
  hair: ["strands", "curl", "mohawk"],
  leaves: ["one", "two", "kelp"],
};
const ACCESSORIES = {
  none: [],
  glasses: ["round", "dark"],
  bow: ["tie", "head"],
  hat: ["beret", "top", "beanie"],
  belt: ["belt", "collar"],
};

const LEAVES = {
  one: ["M0,8 C-2,0 -1,-8 3,-16 C9,-10 8,-2 0,8 Z"],
  two: ["M-1,8 C-3,-1 -9,-5 -7,-17 C0,-12 3,-3 -1,8 Z", "M1,8 C2,0 8,-3 11,-11 C4,-10 0,-4 1,8 Z"],
  kelp: ["M-2,8 C-6,0 2,-6 -2,-14 C-6,-22 2,-28 6,-34 C8,-26 2,-22 5,-14 C8,-6 2,0 3,8 Z"],
};
const LEAF_BOX = { one: [-7, -21, 19, 32], two: [-12, -22, 27, 33], kelp: [-10, -38, 20, 49] };
const LEAF_VEIN = {
  one: '<path class="vein" d="M.6,6 Q2.4,-3 3,-13"/>',
  two: '<path class="vein" d="M-1.2,6 Q-3.4,-4 -6.4,-14 M1.4,6 Q3.6,-2 9,-9"/>',
  kelp: '<path class="vein" d="M.4,6 Q2,-6 -.6,-14 Q-2.4,-22 4,-31"/>',
};

const MITT =
  "M-4.6,-5.6 C-4.6,-9 4.6,-9 4.6,-5.6 V3.4 C4.6,7.4 -4.6,7.4 -4.6,3.4 Z M3.4,-1.6 C7.6,-3 9.6,1.8 5,3.8 Z";

/** The badge's icon per activity, at roster size. */
const ICONS = {
  search: '<circle cx="-1.2" cy="-1.2" r="3.6"/><path d="M1.6,1.6 L5,5"/>',
  vault: '<path d="M-4.5,4.5 L3,-3 L5,-1 L-2.5,6.5 Z"/>',
  code: '<path d="M-2,-4.5 L-6,0 L-2,4.5 M2,-4.5 L6,0 L2,4.5"/>',
  calendar: '<rect x="-5" y="-4" width="10" height="9" rx="1.4"/><path d="M-5,-1 H5"/>',
  email: '<rect x="-6" y="-4" width="12" height="8" rx="1.2"/><path d="M-6,-3.5 L0,1 L6,-3.5"/>',
  think: '<path class="dots" d="M-4,0 h.01 M0,0 h.01 M4,0 h.01"/>',
};

/**
 * Whether the page can draw this mascot: every axis one of its own options. The runtime validated
 * it already; a frame that isn't one is ignored, so nothing unknown reaches the markup.
 */
function isDrawable(mascot) {
  if (typeof mascot !== "object" || mascot === null) return false;
  const part = (types, value) => {
    if (typeof value !== "object" || value === null || !Object.hasOwn(types, value.type)) {
      return false;
    }
    const variations = types[value.type];
    return variations.length === 0
      ? value.variation === undefined
      : variations.includes(value.variation);
  };
  return (
    Object.hasOwn(SHAPES, mascot.shape) &&
    COLORS.includes(mascot.color) &&
    Object.hasOwn(EYES, mascot.eyes) &&
    typeof mascot.cheeks === "boolean" &&
    part(HEADS, mascot.head) &&
    part(ACCESSORIES, mascot.accessory)
  );
}

/** The mascot's size class: the roster's 36 px, the header's 48 px, or the 160 px of a profile. */
function sizeOf(px) {
  if (px <= 40) return "s";
  return px <= 88 ? "m" : "l";
}

/**
 * The SVG of one mascot, and its fur pieces: each piece's flat shapes, the box it is painted in,
 * the fur's flow and its strand length. `work` adds the task's objects, `hands` the mittens.
 */
function buildMascot(mascot, { uid, px, hex, work = true, hands = true }) {
  const shape = SHAPES[mascot.shape];
  const eye = EYES[mascot.eyes];
  const color = palette(hex);
  const size = sizeOf(px);
  const [fx, fy] = shape.face;
  const [tx, ty] = shape.top;
  const k = eye.one ? 1.6 : 1;
  const strokeK = eye.one ? 1.3 : 1;
  const eyeY = eye.top ? ty + 13 : fy;
  const spread = shape.spread + (eye.wide ?? 0);
  const eyes = eye.one
    ? [[fx, eyeY - 2]]
    : [
        [fx - spread, eyeY],
        [fx + spread, eyeY],
      ];
  const pieces = [];
  const flat = (part) =>
    part.width
      ? `<path d="${part.d}" fill="none" stroke="${part.fill}" stroke-width="${part.width}" stroke-linecap="round"/>`
      : `<path d="${part.d}" fill="${part.gradient ? `url(#mg${uid})` : part.fill}"${part.alpha === undefined ? "" : ` fill-opacity="${part.alpha}"`}/>`;
  const piece = (shapes, box, flow, length) => {
    pieces.push({ shapes, box, flow, length });
    return `<g class="fp" data-piece="${pieces.length - 1}"><g class="fpv">${shapes.map(flat).join("")}</g><image class="fpi" x="${box[0]}" y="${box[1]}" width="${box[2]}" height="${box[3]}" preserveAspectRatio="none" display="none"/></g>`;
  };
  const atEars = (draw) => shape.ears.map(([x, y, a]) => draw(x, y, a)).join("");
  const head = mascot.head.type;
  const headVariation = mascot.head.variation;
  const accessory = mascot.accessory.type;
  const accessoryVariation = mascot.accessory.variation;
  // A shape with no room above its head sets its pointed ears lower than its other heads; a head
  // bow and the listening mitten follow the ears it shows.
  const ears =
    head === "ears" && headVariation === "pointed" ? (shape.pointed ?? shape.ears) : shape.ears;
  // A hat hides what sits in the middle of the head.
  const hat = accessory === "hat";
  let backHard = "";
  let backEars = "";
  let frontEars = "";
  let mohawk = null;
  if (head === "ears" && headVariation === "pointed") {
    backEars = ears
      .map(([x, y, a]) => {
        const side = (d) => (a < 0 ? d : mirror(d));
        return `<g transform="translate(${x} ${y}) translate(0 -${EAR_LIFT}) rotate(${a})"><g class="m-ear">${piece(
          [
            { d: side(POINTED_EAR), fill: color.body },
            { d: side(POINTED_SHELL), fill: mix(color.body, SHELL_CREAM, 0.55) },
          ],
          [-14.2, -28, 28.4, 39.7],
          [0, -0.7],
          0.85,
        )}</g></g>`;
      })
      .join("");
  }
  if (head === "ears" && headVariation === "round") {
    backEars = atEars(
      (x, y, a) =>
        `<g transform="translate(${x + Math.sign(a) * 3} ${y - 3})"><g class="m-ear">${piece(
          [
            { d: circle(0, 0, 10.5), fill: color.body },
            { d: circle(0, 1, 5.5), fill: color.dark, alpha: 0.45 },
          ],
          [-17, -17, 34, 34],
          [0, 0.2],
          0.85,
        )}</g></g>`,
    );
  }
  if (head === "ears" && headVariation === "floppy") {
    frontEars = atEars(
      (x, y, a) =>
        `<g transform="translate(${x} ${y + 2}) scale(${a < 0 ? 1 : -1} 1)"><g class="m-ear m-flop">${piece(
          [
            {
              d: "M4,-4 C-6,-6 -15,2 -15,14 C-15,24 -9,30 -4,26 C0,22 2,12 6,4 Z",
              fill: color.darkish,
            },
          ],
          [-21, -10, 31, 42],
          [0, 0.7],
          0.85,
        )}</g></g>`,
    );
  }
  if (head === "horns" && headVariation === "two") {
    backHard = atEars(
      (x, y, a) =>
        `<g transform="translate(${x + Math.sign(a) * 2} ${y + 2}) rotate(${a * 0.7}) scale(${a < 0 ? -1 : 1} 1)"><path class="horn" d="M-5.5,6 Q-5,-6 1,-15 Q5,-5 5.5,6 Z"/><path class="hornl" d="M-4.6,1.4 Q0,3 4.8,1.4 M-3.8,-4 Q.4,-2.8 4,-4.2 M-2.4,-9 Q.8,-8.2 3,-9.4"/><path class="hornhi" d="M-2.8,4 Q-3,-5.5 .4,-12"/></g>`,
    );
  }
  if (!hat) {
    if (head === "horns" && headVariation === "one") {
      backHard = `<g transform="translate(${tx} ${ty + 4})"><path class="horn" d="M-6,6 Q-3,-8 0,-22 Q3,-8 6,6 Z"/><path class="hornl" d="M-4.6,-1 Q0,.4 4.8,-3 M-3.2,-8 Q.4,-6.8 3.6,-10 M-1.8,-14.6 Q.6,-13.8 2.4,-16.4"/><path class="hornhi" d="M-3.6,4 Q-2.6,-8 -.6,-17"/></g>`;
    }
    if (head === "horns" && headVariation === "antennae") {
      backHard = [-1, 1]
        .map(
          (s) =>
            `<g transform="translate(${tx + s * 9} ${ty + 6})"><g class="m-ant"><path class="ant" d="M0,4 Q${s * 2},-8 ${s * 7},-16"/><path class="anthi" d="M${-s * 0.6},3 Q${s * 1.2},-8 ${s * 6.2},-15"/><circle cx="${s * 7}" cy="-17" r="4.4" fill="url(#mg${uid})"/><g transform="translate(${s * 7} -17)">${gloss(4.4, 4.4)}</g><circle class="wht" cx="${s * 7 - 1.5}" cy="-18.6" r="1.1"/></g></g>`,
        )
        .join("");
    }
    if (head === "hair" && headVariation === "strands") {
      backHard = `<g transform="translate(${tx} ${ty})"><g class="m-leaf">${piece(
        [
          { d: "M-7,8 Q-9,-3 -14,-6", width: 4.8, fill: color.darkish },
          { d: "M0,8 Q-1,-5 3,-12", width: 4.8, fill: color.darkish },
          { d: "M7,8 Q10,-2 15,-3", width: 4.8, fill: color.darkish },
        ],
        [-19, -17, 38, 30],
        [0, -0.5],
        0.5,
      )}</g></g>`;
    }
    if (head === "hair" && headVariation === "curl") {
      backHard = `<g transform="translate(${tx} ${ty})"><g class="m-leaf">${piece(
        [
          {
            d: "M0,8 C-1,-2 2,-10 9,-11 C15,-12 17,-5 13,-2 C9,1 5,-3 8,-6",
            width: 4.6,
            fill: color.darkish,
          },
        ],
        [-6, -16, 26, 28],
        [0, -0.4],
        0.5,
      )}</g></g>`;
    }
    if (head === "hair" && headVariation === "mohawk") {
      const points = [
        [-16, 10],
        [-13, -5],
        [-8, 6],
        [-4, -9],
        [0, 5],
        [4, -9],
        [8, 6],
        [13, -5],
        [16, 10],
      ];
      mohawk = {
        d: `M${points.map(([x, y]) => `${tx + x},${ty + y}`).join(" L")} Z`,
        fill: color.darkish,
      };
    }
    if (head === "leaves") {
      const leaf = mix("#3D8B5A", color.body, 0.3);
      backHard = `<g transform="translate(${tx} ${ty})"><g class="m-leaf">${piece(
        LEAVES[headVariation].map((d) => ({ d, fill: leaf })),
        LEAF_BOX[headVariation],
        [0, -0.6],
        0.45,
      )}${LEAF_VEIN[headVariation]}</g></g>`;
    }
  }
  const body = piece(
    [
      ...(mohawk ? [mohawk] : []),
      { d: shape.d, fill: color.body, gradient: true },
      // The frog's eyes sit on bumps of the body.
      ...(mascot.eyes === "frog"
        ? eyes.map(([x, y]) => ({ d: circle(x, y + 1, 12.5), fill: color.body }))
        : []),
    ],
    [0, 0, 120, 120],
    [0, 0.55],
  );
  const [cx, cy] = shape.collar;
  let lower = "";
  let glasses = "";
  let onTop = "";
  const band = (y) =>
    `<g clip-path="url(#mc${uid})"><path class="strap" d="M0,${y - 4} Q60,${y + 3} 120,${y - 4} V${y + 2.5} Q60,${y + 9.5} 0,${y + 2.5} Z"/><path class="strap-hl" d="M0,${y - 3.4} Q60,${y + 3.6} 120,${y - 3.4}"/><path class="stitch" d="M0,${y - 0.7} Q60,${y + 6.3} 120,${y - 0.7}"/></g>`;
  if (accessory === "belt" && accessoryVariation === "collar") {
    lower = `${band(cy)}<circle class="ring" cx="${cx}" cy="${cy + 6}" r="2"/><ellipse class="csh" cx="${cx + 0.8}" cy="${cy + 13}" rx="5.6" ry="3.4"/><circle class="tagc" cx="${cx}" cy="${cy + 11}" r="4.6"/><g transform="translate(${cx} ${cy + 11})">${gloss(4.6, 4.6)}</g>`;
  }
  if (accessory === "belt" && accessoryVariation === "belt") {
    lower = `${band(cy + 3)}<rect class="buckle" x="${cx - 5}" y="${cy + 1.3}" width="10" height="9" rx="1.6"/><path class="hl" d="M${cx - 3.6},${cy + 2.6} H${cx + 2}"/>`;
  }
  if (accessory === "bow" && accessoryVariation === "tie") {
    lower = `<g transform="translate(${cx} ${cy + 3})"><ellipse class="csh" cx="1" cy="5" rx="14" ry="3.6"/><path class="gloss" d="M0,0 L-11,-6.5 Q-13.5,0 -11,6.5 Z"/><path class="gloss" d="M0,0 L11,-6.5 Q13.5,0 11,6.5 Z"/><path class="hl" d="M-9.6,-4 Q-11.2,-.6 -10.2,2.6 M9.4,-4.4 Q10.6,-2 10.2,0"/><rect class="gloss" x="-3" y="-3.4" width="6" height="6.8" rx="2"/><path class="hl" d="M-1.4,-2.2 H1.2"/></g>`;
  }
  if (accessory === "bow" && accessoryVariation === "head") {
    const [x, y] = ears[0];
    onTop = `<g transform="translate(${x + 3} ${y + 3}) rotate(-20)"><g class="bow"><ellipse class="csh" cx="1" cy="5" rx="13" ry="3.4"/><path class="satin" d="M0,0 C-5,-9 -15,-8 -13,0 C-12,7 -4,5 0,0 Z"/><path class="satin" d="M0,0 C5,-9 15,-8 13,0 C12,7 4,5 0,0 Z"/><path class="hl" d="M-11.4,-2 Q-9.6,-6.4 -5,-5.6 M11.4,-2 Q9.6,-6.4 5,-5.6"/><circle class="knot" r="2.8"/><circle class="wht" cx="-.8" cy="-.9" r=".7" opacity=".7"/></g></g>`;
  }
  if (hat) {
    // Hats are felt and knit, so they are painted like the plush.
    const [hx, hy, hw] = shape.hat;
    const felt = "#2C3332";
    const knit = mix(color.body, INK, 0.55);
    const knitBand = mix(color.body, INK, 0.4);
    if (accessoryVariation === "beret") {
      onTop = `<g transform="translate(${hx} ${hy}) rotate(-12)"><ellipse class="csh" cx="-1" cy="${hw * 0.14}" rx="${hw * 0.52}" ry="${hw * 0.1}"/>${piece(
        [
          { d: ellipse(-2, -3, hw * 0.56, hw * 0.2), fill: felt },
          {
            d: `M-1.8,${-2 - hw * 0.2} L-1.6,${-6.5 - hw * 0.2} Q0,${-8 - hw * 0.2} 1.6,${-6.5 - hw * 0.2} L1.8,${-2 - hw * 0.2} Z`,
            fill: felt,
          },
        ],
        [-hw * 0.62 - 4, -hw * 0.2 - 12, hw * 1.24 + 8, hw * 0.4 + 18],
        [0, 0.2],
        0.45,
      )}</g>`;
    }
    if (accessoryVariation === "top") {
      onTop = `<g transform="translate(${hx} ${hy})"><ellipse class="csh" cx="0" cy="3.4" rx="${hw * 0.52}" ry="3.2"/>${piece(
        [
          { d: rounded(-hw * 0.3, -22, hw * 0.6, 22, [2.5, 2.5, 0, 0]), fill: felt },
          { d: ellipse(0, 0, hw * 0.5, 3.4), fill: felt },
          { d: rounded(-hw * 0.3, -7.5, hw * 0.6, 5, [0, 0, 0, 0]), fill: color.light },
        ],
        [-hw * 0.55 - 3, -26, hw * 1.1 + 6, 33],
        [0, 0.2],
        0.3,
      )}</g>`;
    }
    if (accessoryVariation === "beanie") {
      onTop = `<g transform="translate(${hx} ${hy})"><ellipse class="csh" cx="0" cy="6" rx="${hw * 0.52}" ry="2.8"/>${piece(
        [
          {
            d: `M${-hw * 0.52},3 C${-hw * 0.52},${-hw * 0.5} ${hw * 0.52},${-hw * 0.5} ${hw * 0.52},3 Z`,
            fill: knit,
          },
          { d: rounded(-hw * 0.55, -1, hw * 1.1, 7, [3.5, 3.5, 3.5, 3.5]), fill: knitBand },
          { d: circle(0, -hw * 0.38 - 3, Math.max(4, hw * 0.1)), fill: color.light },
        ],
        [-hw * 0.6 - 3, -hw * 0.5 - 10, hw * 1.2 + 6, hw * 0.5 + 20],
        [0, 0.2],
        0.55,
      )}</g>`;
    }
  }
  if (accessory === "glasses") {
    const r = eye.height + 3.6;
    const lens = accessoryVariation === "dark" ? "lens-d" : "lens";
    glasses =
      eyes
        .map(
          ([x, y]) =>
            `<ellipse class="csh" cx="${x + 1.2}" cy="${y + r * 0.75}" rx="${r * 0.95}" ry="${r * 0.4}"/>`,
        )
        .join("") +
      eyes
        .map(
          ([x, y]) =>
            `<circle class="${lens}" cx="${x}" cy="${y}" r="${r}"/><path class="hl" d="M${x - r * 0.62},${y - r * 0.1} Q${x - r * 0.5},${y - r * 0.62} ${x - r * 0.02},${y - r * 0.7}"/><path class="hl thin" d="M${x + r * 0.3},${y + r * 0.55} Q${x + r * 0.55},${y + r * 0.3} ${x + r * 0.62},${y}"/>`,
        )
        .join("");
    if (!eye.one) {
      glasses += `<path class="frame" d="M${eyes[0][0] + r},${eyes[0][1] - 1} Q${fx},${eyes[0][1] - 5} ${eyes[1][0] - r},${eyes[1][1] - 1}"/>`;
    }
    glasses = `<g class="m-glasses">${glasses}</g>`;
  }
  const handColor = mix(color.body, "#ffffff", 0.3);
  const mittShadow = '<ellipse class="csh" cx="1.5" cy="6.5" rx="8.5" ry="3.6"/>';
  const mittPiece = () => piece([{ d: MITT, fill: handColor }], [-9, -12, 20, 22], [0, 0.35], 0.5);
  const mitt = (x, y, a, flip) =>
    `<g class="mitt" transform="translate(${x} ${y}) rotate(${a})${flip ? " scale(-1 1)" : ""}">${mittShadow}${mittPiece()}</g>`;
  const workSvg =
    !work || size === "s"
      ? ""
      : `<g transform="translate(${fx + 23} ${fy + 27}) scale(1.4)"><g class="m-work">${[
          `<g class="act act-search"><g class="aw w-lens"><path class="p-handle" d="M4.8,4.8 L10.5,10.5"/><circle class="p-glass" r="7"/><path class="p-glint" d="M-4,-2 Q-3,-4.6 -.4,-5"/>${mitt(12, 12.5, -40)}</g></g>`,
          `<g class="act act-vault"><ellipse class="csh" cx="1" cy="12" rx="13" ry="3"/><g transform="rotate(-6)"><rect class="p-paper" x="-9" y="-11" width="18" height="22" rx="2"/>${[
            [-5, -5, 5],
            [-5, 0, 5],
            [-5, 5, 2],
          ]
            .map(([x0, y0, x1]) => `<path class="p-line" pathLength="1" d="M${x0},${y0} H${x1}"/>`)
            .join(
              "",
            )}</g>${mitt(-10, 10, 25, true)}<g class="aw w-pen"><g transform="translate(3 -4) rotate(32)"><rect class="p-pencil" x="-1.7" y="-12" width="3.4" height="12" rx="1"/><path class="p-tip" d="M-1.7,0 L0,3.6 L1.7,0 Z"/></g>${mitt(10, -6, -30)}</g></g>`,
          `<g class="act act-code"><ellipse class="csh" cx="1" cy="12" rx="13" ry="3"/><rect class="p-screen" x="-10" y="-10" width="20" height="14" rx="1.6"/>${[
            [-7, -6, 2],
            [-5, -3, 5],
            [-7, 0, 0],
          ]
            .map(([x0, y0, x1]) => `<path class="p-code" pathLength="1" d="M${x0},${y0} H${x1}"/>`)
            .join(
              "",
            )}<path class="p-base" d="M-13,4.5 H13 L11,8.5 H-11 Z"/><g class="aw w-kl">${mitt(-6, 10, 15, true)}</g><g class="aw w-kr">${mitt(6, 10, -15)}</g></g>`,
          `<g class="act act-calendar"><ellipse class="csh" cx="1" cy="12" rx="13" ry="3"/><g class="aw w-page"><rect class="p-paper" x="-9" y="-10" width="18" height="20" rx="2"/><path class="p-band" d="M-9,-6 V-8 Q-9,-10 -7,-10 H7 Q9,-10 9,-8 V-6 Z"/>${[
            -5, 0, 5,
          ]
            .map((x0) =>
              [-1, 3, 7]
                .map(
                  (y0) =>
                    `<rect class="p-cell" x="${x0 - 1.4}" y="${y0 - 1.4}" width="2.8" height="2.8" rx=".6"/>`,
                )
                .join(""),
            )
            .join(
              "",
            )}<path class="p-check" pathLength="1" d="M-4,2.5 L-1,5.5 L5,-1.5"/></g>${mitt(-11, -5, -15, true)}<g class="aw w-stamp">${mitt(10, 0, -20)}</g></g>`,
          `<g class="act act-email"><ellipse class="csh" cx="1" cy="12" rx="13" ry="3"/><g class="aw w-env"><rect class="p-paper" x="-9" y="-6" width="18" height="12" rx="1.5"/><path class="p-flap" d="M-9,-5.5 L0,1 L9,-5.5"/></g><g class="aw w-er">${mitt(11, 5, -25)}</g></g>`,
          // Offline (#380): the plug that came out, its cord hanging loose, in one mitten.
          `<g class="act act-plug"><path class="p-cord" d="M0,8 C0,11 -4,12 -7,12 S-12,10 -14,13"/><g class="aw w-plug"><ellipse class="csh" cx="1" cy="10" rx="8" ry="2.4"/><rect class="p-prong" x="-3.6" y="-11" width="2.4" height="7" rx=".9"/><rect class="p-prong" x="1.2" y="-11" width="2.4" height="7" rx=".9"/><rect class="p-plugb" x="-6" y="-5" width="12" height="13" rx="3"/><path class="p-plughl" d="M-3.6,-2.6 V4.6"/>${mitt(9, 3, -28)}</g></g>`,
        ].join("")}</g></g>`;
  const handsSvg =
    hands && size !== "s"
      ? ["l", "r"]
          .map(
            (side) =>
              `<g class="hand hand-${side}"><g class="hg"><g${side === "l" ? ' transform="scale(-1 1)"' : ""}>${mittShadow}${mittPiece()}</g></g></g>`,
          )
          .join("")
      : "";
  const cheekAt = eye.one
    ? [
        [fx - 18, fy + 11],
        [fx + 18, fy + 11],
      ]
    : [
        [fx - spread - 8, eyeY + 8],
        [fx + spread + 8, eyeY + 8],
      ];
  const cheeks = mascot.cheeks
    ? cheekAt.map(([x, y]) => `<ellipse class="chk" cx="${x}" cy="${y}" rx="7" ry="4.6"/>`).join("")
    : "";
  const shadowR = eye.height * k * (eye.one ? 0.7 : 1);
  const eyeSvg = eyes
    .map(
      ([x, y]) =>
        `<g transform="translate(${x} ${y})"><g class="m-eyeW"><g class="m-eyeP"><g class="m-blink"><g class="e-open sw"><ellipse class="esh" cx=".6" cy="1.8" rx="${shadowR + 2.6}" ry="${shadowR + 2}"/>${eye.draw()}</g><path class="e-happy sw stk" stroke-width="${3 * strokeK}" d="M${-6.5 * k},${2.5 * k} Q0,${-6 * k} ${6.5 * k},${2.5 * k}"/><path class="e-closed sw stk" stroke-width="${2.8 * strokeK}" d="M${-6.5 * k},0 Q0,${4.5 * k} ${6.5 * k},0"/></g></g></g></g>`,
    )
    .join("");
  const brows = eyes
    .map(
      ([x, y]) =>
        `<g transform="translate(${x} ${y - eye.height - (eye.one ? 7 : 6)})"><g class="m-brow"><path class="stk" stroke-width="3.2" d="M${eye.one ? -8 : -5},0 H${eye.one ? 8 : 5}"/></g></g>`,
    )
    .join("");
  const mouthY = fy + (eye.one ? 15 : (shape.mouth ?? 13));
  const mouth = `<g class="m-mouth" transform="translate(${fx} ${mouthY})"><g class="mo-o-w"><ellipse class="mo-o sw ink" rx="2.8" ry="3.3"/></g><path class="mo-smile sw stk" stroke-width="2.8" d="M-5.5,-1.5 Q0,4.5 5.5,-1.5"/><path class="mo-wave sw stk" stroke-width="2.6" d="M-6,0.5 Q-3,-2.5 0,0.5 T6,0.5"/></g>`;
  // What shows beside the figure (ADR-0065): the thought bubbles, the sparks and the "z"s float in
  // a layer of their own, which takes the state's pose but not the figure's hops or breath.
  const beside =
    `<g class="fx-bub sw">${[
      [24, -3, 3.2],
      [32, -14, 4.4],
      [39, -27, 5.6],
    ]
      .map(([dx, dy, r]) => `<circle class="bub" cx="${tx + dx}" cy="${ty + dy}" r="${r}"/>`)
      .join("")}</g>` +
    `<g class="fx-spark sw">${[
      [-32, 6, 1],
      [33, -4, 0.8],
      [2, -17, 0.7],
    ]
      .map(
        ([dx, dy, s]) =>
          `<g transform="translate(${tx + dx} ${ty + dy}) scale(${s})"><g class="star-a"><path class="star" d="M0,-8 Q1.4,-1.4 8,0 Q1.4,1.4 0,8 Q-1.4,1.4 -8,0 Q-1.4,-1.4 0,-8 Z"/></g></g>`,
      )
      .join("")}</g>` +
    `<g class="fx-zzz sw"><text class="zz" x="${tx + 22}" y="${ty - 2}" font-size="15">z</text><text class="zz" x="${tx + 32}" y="${ty - 12}" font-size="11">z</text></g>`;
  // The sweat drop sits on the face, and moves with it.
  const sweat = `<g transform="translate(${fx + spread + 9} ${eyeY - 9})"><path class="drop" d="M0,-6 C3,-2 4.5,1 4.5,3 A4.5,4.5 0 0 1 -4.5,3 C-4.5,1 -3,-2 0,-6 Z"/></g>`;
  // At 36 px a glossy badge stands in for the bubble (ADR-0045 §9).
  const badge =
    size === "s"
      ? `<g transform="translate(99 98)"><g class="m-bdw"><circle class="bd-ring" r="12"/><g class="bd-dot"><circle class="bd-c" r="12"/><ellipse class="bd-hl" cx="-4" cy="-5" rx="4.6" ry="2.6" transform="rotate(-25 -4 -5)"/><text class="bd-g" y="5.6" text-anchor="middle"></text><g class="bd-ico">${Object.entries(
          ICONS,
        )
          .map(([name, d]) => `<g class="ico ico-${name}">${d}</g>`)
          .join("")}</g></g></g></g>`
      : `<g transform="translate(${fx + spread + 25} ${ty - 9}) scale(${size === "m" ? 1.6 : 1.4})"><g class="m-bdw speech"><g class="bd-bob"><g class="bd-dot"><path class="bd-c bub3d" d="M0,-11 C7,-11 11,-7 11,-2 C11,3.5 7,7 1,7 L-5,11.5 L-3.6,6.2 C-8.5,5 -11,2 -11,-2 C-11,-7 -7,-11 0,-11 Z"/><ellipse class="bd-hl" cx="-4.6" cy="-6.2" rx="4.4" ry="2.1" transform="rotate(-20 -4.6 -6.2)"/><text class="bd-g" y="3" text-anchor="middle"></text><g class="bd-off"><path d="M-2.2,-6.4 V-3.8 M2.2,-6.4 V-3.8"/><rect x="-4.2" y="-3.8" width="8.4" height="5.6" rx="1.6"/><path d="M0,1.8 V4.4"/><path class="slash" d="M-6.2,4.6 L6.2,-7"/></g></g></g></g></g>`;
  // The head's and the accessory's parts, each in a group the editor's preview drops in (#379).
  const part = (name, svg) => (svg ? `<g class="${name}">${svg}</g>` : "");
  // The figure: its body, its head and what it wears, which every motion keeps in the frame. Its
  // top, upright or tilting between two angles; the frame holds it at rest at every tilt.
  const figure = backHard + backEars + body + frontEars + lower + onTop;
  const key = figure.replace(/#m[cg]\d+\)/g, ")");
  if (!MEASURED.has(key)) {
    if (MEASURED.size >= 256) MEASURED.clear();
    MEASURED.set(key, pointsOf(figure));
  }
  const reached = MEASURED.get(key);
  const crown = (low = 0, high = 0) => crownOf(reached, low, high);
  const frame = frameOf(crown(-TILT, TILT));
  const html =
    `<svg class="mascot" viewBox="${frame.x} ${frame.y} ${frame.size} ${frame.size}" width="${px}" height="${px}" data-size="${size}" data-eyes="open" data-mouth="none" data-brows="none" data-fx="none" data-badge="none" aria-hidden="true" focusable="false">` +
    `<defs><clipPath id="mc${uid}"><path d="${shape.d}"/></clipPath><radialGradient id="mg${uid}" cx=".36" cy=".3" r=".85"><stop offset="0" stop-color="${color.light}"/><stop offset=".55" stop-color="${color.body}"/><stop offset="1" stop-color="${color.edge}"/></radialGradient></defs>` +
    '<ellipse class="m-shadow" cx="60" cy="111" rx="30" ry="3.6"/>' +
    `<g class="m-hop g"><g class="m-breath g"><g class="m-sq g"><g class="m-pose g">${part("m-head", backHard + backEars)}${body}${part("m-head", frontEars)}${part("m-acc", lower)}` +
    `<g class="m-face">${cheeks}${eyeSvg}${part("m-acc", glasses)}<g class="m-brows">${brows}</g>${mouth}</g>${workSvg}${part("m-acc", onTop)}${handsSvg}${sweat}</g></g></g></g>` +
    `<g class="m-fx g">${beside}</g>${badge}</svg>`;
  return {
    html,
    pieces,
    size,
    top: crown(),
    crown,
    frame,
    anchors: { fx, fy, spread, tx, ty, ear: head === "ears" ? ears[1] : null },
  };
}

/** Where a mitten goes, as [x, y, rotation, scale] on the 120 grid; the left one is mirrored. */
function handSpot(name, { fx, fy, spread: es, tx, ty, ear }) {
  const s = 1.4;
  const spots = {
    dockL: [fx - es - 8, fy + 20, 25, 0.3],
    dockR: [fx + es + 8, fy + 20, -25, 0.3],
    waveR: [fx + es + 18, fy - 6, 8, s],
    waveL: [fx - es - 18, fy - 6, -8, s],
    upR: [fx + es + 12, ty - 2, -12, s],
    upL: [fx - es - 12, ty - 2, 12, s],
    ear: ear ? [ear[0] + 9, ear[1] + 9, -35, s] : [fx + es + 15, fy - 7, -35, s],
    thumbR: [fx + es + 16, fy + 9, -90, s],
    thumbL: [fx - es - 16, fy + 9, 90, s],
    cheekR: [fx + es + 8, fy + 10, -18, s],
    cheekL: [fx - es - 8, fy + 10, 18, s],
    pillowR: [fx + es + 7, fy + 15, -100, s],
    typeR: [fx + 9, fy + 25, 175, s * 0.9],
    typeL: [fx - 9, fy + 25, -175, s * 0.9],
    mouthR: [fx + 2, fy + 15, -25, s * 0.9],
    headR: [tx + 15, ty + 9, -45, s],
    browR: [fx + es + 12, fy - 13, -80, s],
    browSweep: [fx - es + 4, fy - 14, -80, s],
    eyeR: [fx + es + 2, fy + 3, -30, s * 0.9],
    eyeL: [fx - es - 2, fy + 3, 30, s * 0.9],
    chinR: [fx + 4, fy + 20, -100, s],
    pleaseR: [fx + 4, fy + 19, -20, s],
    pleaseL: [fx - 4, fy + 19, 20, s],
    cardL: [fx - es - 15, fy + 15, -60, s],
    clapR: [fx + 8, fy + 22, -10, s],
    clapL: [fx - 8, fy + 22, 10, s],
  };
  return spots[name] ?? null;
}

/**
 * Where a mitten turns as it waves: the middle of its painted box and shadow, 85% of the way down
 * (mascot.css's .hg).
 */
const WRIST = [1, 6.8];

/**
 * The highest a mitten reaches at `spot` (handSpot), fur included, as it waves up to `swing`
 * degrees about its wrist. The stretch and a call for help raise both above the head.
 */
function mittenTop([x, y, angle, scale], swing = 0, left = false) {
  const side = left ? -1 : 1;
  const own = pointsOf(`<g class="fp"><path d="${MITT}"/></g>`).map(([px, py, reach]) => [
    side * px,
    py,
    reach,
  ]);
  const r = (angle * Math.PI) / 180;
  const [cos, sin] = [Math.cos(r), Math.sin(r)];
  const placed = (degrees) =>
    own.map(([px, py, reach]) => {
      // The wave's turn about the wrist, then the spot's place, angle and scale.
      const w = (degrees * Math.PI) / 180;
      const [wx, wy] = [side * WRIST[0], WRIST[1]];
      const qx = wx + (px - wx) * Math.cos(w) - (py - wy) * Math.sin(w);
      const qy = wy + (px - wx) * Math.sin(w) + (py - wy) * Math.cos(w);
      return [x + scale * (qx * cos - qy * sin), y + scale * (qx * sin + qy * cos), reach * scale];
    });
  let top = Number.POSITIVE_INFINITY;
  const steps = Math.ceil(Math.abs(swing));
  for (let i = 0; i <= steps; i++) {
    top = Math.min(top, crownOf(placed(steps ? (swing * i) / steps : 0), 0, 0));
  }
  return top;
}

/**
 * The gradients every mascot shares, once per page. Their stops take their colors from classes
 * in mascot.css where a theme token sets them.
 */
const SHARED_DEFS = `<defs>
<radialGradient id="kg-sclera" cx=".38" cy=".3" r=".8"><stop offset="0" stop-color="#FFFFFF"/><stop offset=".45" stop-color="#F4F6F5"/><stop offset=".8" stop-color="#D2DAD8"/><stop offset="1" stop-color="#A7B3B0"/></radialGradient>
<radialGradient id="kg-bead" cx=".34" cy=".28" r=".85"><stop offset="0" stop-color="#5A6060"/><stop offset=".42" stop-color="#151818"/><stop offset="1" stop-color="#000000"/></radialGradient>
<radialGradient id="kg-ao"><stop offset=".7" stop-color="#0C2523" stop-opacity="0"/><stop offset=".82" stop-color="#0C2523" stop-opacity=".42"/><stop offset="1" stop-color="#0C2523" stop-opacity="0"/></radialGradient>
<radialGradient id="kg-esh"><stop offset=".55" stop-color="#0C2523" stop-opacity=".32"/><stop offset="1" stop-color="#0C2523" stop-opacity="0"/></radialGradient>
<radialGradient id="kg-spec"><stop offset="0" stop-color="#FFFFFF" stop-opacity=".75"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>
<radialGradient id="kg-wait" cx=".35" cy=".28" r=".85"><stop offset="0" class="kg-warm-1"/><stop offset=".55" class="kg-warm-2"/><stop offset="1" class="kg-warm-3"/></radialGradient>
<radialGradient id="kg-err" cx=".35" cy=".28" r=".85"><stop offset="0" class="kg-danger-1"/><stop offset=".55" class="kg-danger-2"/><stop offset="1" class="kg-danger-3"/></radialGradient>
<radialGradient id="kg-acc" cx=".35" cy=".28" r=".85"><stop offset="0" class="kg-accent-1"/><stop offset=".55" class="kg-accent-2"/><stop offset="1" class="kg-accent-3"/></radialGradient>
<radialGradient id="kg-off" cx=".35" cy=".28" r=".85"><stop offset="0" class="kg-muted-1"/><stop offset=".55" class="kg-muted-2"/><stop offset="1" class="kg-muted-3"/></radialGradient>
<radialGradient id="kg-shadow"><stop offset=".25" stop-color="#0C2523" stop-opacity=".38"/><stop offset="1" stop-color="#0C2523" stop-opacity="0"/></radialGradient>
<radialGradient id="kg-gloss" cx=".32" cy=".28" r=".85"><stop offset="0" stop-color="#5B6866"/><stop offset=".45" stop-color="#1A2120"/><stop offset="1" stop-color="#030505"/></radialGradient>
<radialGradient id="kg-metal" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#FFFFFF"/><stop offset=".5" stop-color="#D3DCDA"/><stop offset="1" stop-color="#7F8E8B"/></radialGradient>
<radialGradient id="kg-satin" cx=".4" cy=".3" r=".8"><stop offset="0" stop-color="#FFC2D5"/><stop offset=".5" stop-color="#E8709A"/><stop offset="1" stop-color="#A3365E"/></radialGradient>
<linearGradient id="kg-lens" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFFFFF" stop-opacity=".5"/><stop offset=".45" stop-color="#FFFFFF" stop-opacity=".1"/><stop offset=".55" stop-color="#FFFFFF" stop-opacity=".26"/><stop offset="1" stop-color="#FFFFFF" stop-opacity=".04"/></linearGradient>
<linearGradient id="kg-lensd" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4C5856"/><stop offset=".5" stop-color="#121918"/><stop offset="1" stop-color="#000000"/></linearGradient>
<linearGradient id="kg-frame" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#55605E"/><stop offset="1" stop-color="#080B0A"/></linearGradient>
<linearGradient id="kg-strap" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3D4B49"/><stop offset=".5" stop-color="#17211F"/><stop offset="1" stop-color="#070C0B"/></linearGradient>
<radialGradient id="kg-blush"><stop offset="0" stop-color="#F06A86" stop-opacity=".55"/><stop offset="1" stop-color="#F06A86" stop-opacity="0"/></radialGradient>
<linearGradient id="kg-horn" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#FBF5E8"/><stop offset=".5" stop-color="#E8D9B8"/><stop offset="1" stop-color="#AE956A"/></linearGradient>
<linearGradient id="kg-paper" x1="0" y1="0" x2=".3" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#DCE4E2"/></linearGradient>
<linearGradient id="kg-screen" x1="0" y1="0" x2=".4" y2="1"><stop offset="0" stop-color="#24504A"/><stop offset="1" stop-color="#081A18"/></linearGradient>
<linearGradient id="kg-alu" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#EEF2F1"/><stop offset="1" stop-color="#9AA8A5"/></linearGradient>
<linearGradient id="kg-pencil" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#6FA6CC"/><stop offset=".5" stop-color="#3F7FA8"/><stop offset="1" stop-color="#255A7C"/></linearGradient>
</defs>`;

  return { FRAME, MARGIN, mix, palette, pointedEarOutlines, frameOf, SHAPES, COLORS, EYES, HEADS, ACCESSORIES, isDrawable, sizeOf, buildMascot, handSpot, mittenTop, SHARED_DEFS };
  })();
  var engine = (function () {
// The agent's mascot (ADR-0045): a plush figure that stays alive in place. mascot-art.js builds
// its SVG and mascot-states.js says what each state shows and when it may move; this module
// paints the fur, plays the poses and gestures with the Web Animations API, and runs the one
// timer every mascot shares. No library, and nothing per frame repaints the fur.

const { buildMascot, handSpot, mittenTop, SHARED_DEFS } = art;
const {
  ACTIVITIES,
  allowed,
  available,
  BREATH,
  breathDepth,
  breathes,
  draw,
  due,
  gapAfter,
  HAND_POSES,
  HOLDING_STATES,
  HOP,
  hopRise,
  LIST_LOCK_MS,
  liftShare,
  POSES,
  QUIET_BLINK_MS,
  remember,
  SPRINGS,
  stillStretch,
  stretchRise,
  WORKING_STATES,
} = states;

/** What every mascot on the page shares: the setting, and while the owner types. */
const world = { motion: "still", quietUntil: 0, listLock: 0, hidden: document.hidden };
const live = new Set();
let uids = 0;

const now = () => performance.now();
const transformOf = (spot) =>
  `translate(${spot[0]}px, ${spot[1]}px) rotate(${spot[2]}deg) scale(${spot[3]})`;
const randomOf = (list) => list[Math.floor(Math.random() * list.length)];

function cancel(element) {
  for (const animation of element.getAnimations()) animation.cancel();
}

/** Starts an animation. A change of state cancels it, and its `finished` then rejects unread. */
function animate(element, keyframes, options) {
  const animation = element.animate(keyframes, options);
  animation.finished?.catch(() => {});
  return animation;
}

/** Moves to a pose from wherever the element is now, so a change can interrupt another. */
function poseTo(element, transform, spring) {
  if (!spring || world.motion === "still") {
    cancel(element);
    element.style.transform = transform;
    return;
  }
  const from = getComputedStyle(element).transform;
  cancel(element);
  element.style.transform = transform;
  animate(element, [{ transform: from }, { transform }], {
    duration: spring.duration,
    easing: spring.easing,
  });
}

/** The page's motion setting, after reduced motion (mascot-states.js `effectiveMotion`). */
function setMotion(motion) {
  if (world.motion === motion) return;
  world.motion = motion;
  for (const mascot of live) mascot.settle();
}

/** The owner is typing: the conversation's mascot only breathes and blinks for a moment. */
function ownerTyping() {
  world.quietUntil = now() + 2_500;
}

// Fur, painted once per piece and size on a canvas (ADR-0045 §3): the shape shaded as a soft
// volume lit from the top left, then thousands of short strands in three layers that grow out
// from the middle. The mascot moves the finished image, so breathing never repaints it.

/** FNV-1a and mulberry32: the same strands for the same piece, in every paint. */
function hash(text) {
  let h = 2_166_136_261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16_777_619);
  return h >>> 0;
}
function seeded(seed) {
  let state = seed || 1;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Three box blurs, close to a Gaussian, for the volume's height map. */
function boxBlur(source, w, h, r) {
  const row = new Float32Array(w * h);
  const out = new Float32Array(source);
  const d = 2 * r + 1;
  const clampX = (x) => Math.min(w - 1, Math.max(0, x));
  const clampY = (y) => Math.min(h - 1, Math.max(0, y));
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) {
      const base = y * w;
      let sum = 0;
      for (let x = -r; x <= r; x++) sum += out[base + clampX(x)];
      for (let x = 0; x < w; x++) {
        row[base + x] = sum / d;
        sum += out[base + clampX(x + r + 1)] - out[base + clampX(x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let y = -r; y <= r; y++) sum += row[clampY(y) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = sum / d;
        sum += row[clampY(y + r + 1) * w + x] - row[clampY(y - r) * w + x];
      }
    }
  }
  return out;
}

/** [share, tone, alpha, length, width]: fine, short, dense strands with little contrast, like velvet. */
const LAYERS = [
  [0.42, 0.9, 0.62, 1, 1],
  [0.36, 1, 0.6, 0.95, 1],
  [0.22, 1.14, 0.55, 0.85, 0.9],
];

function paintFur(piece, w, key) {
  const [bx, by, bw, bh] = piece.box;
  const k = w / bw;
  const h = Math.max(4, Math.round(bh * k));
  const n = w * h;
  const random = seeded(hash(key));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d", { willReadFrequently: true });
  g.setTransform(k, 0, 0, k, -bx * k, -by * k);
  for (const shape of piece.shapes) {
    g.globalAlpha = shape.alpha ?? 1;
    const path = new Path2D(shape.d);
    if (shape.width) {
      g.lineWidth = shape.width;
      g.lineCap = "round";
      g.lineJoin = "round";
      g.strokeStyle = shape.fill;
      g.stroke(path);
    } else {
      g.fillStyle = shape.fill;
      g.fill(path);
    }
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  const image = g.getImageData(0, 0, w, h);
  const px = image.data;
  const alpha = new Float32Array(n);
  let area = 0;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    const a = px[i * 4 + 3] / 255;
    alpha[i] = a;
    area += a;
    mx += a * (i % w);
    my += a * ((i / w) | 0);
  }
  mx /= area || 1;
  my = my / (area || 1) - h * 0.06;
  // The volume: a blurred height map, its slope lit from the top left.
  const r = Math.max(1, Math.round(7 * k));
  const height = boxBlur(alpha, w, h, r);
  const slope = r * 1.9;
  const nx = new Float32Array(n);
  const ny = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const o = i * 4;
      if (!px[o + 3]) continue;
      const gx = (height[i + 1] - height[i - 1]) * slope;
      const gy = (height[i + w] - height[i - w]) * slope;
      const length = Math.hypot(gx, gy, 1);
      const lit = Math.max(0, (gx * 0.5 + gy * 0.72 + 0.48) / length);
      const edge = Math.min(1, Math.max(0, (1 - height[i]) * 2.2));
      const shade =
        (0.6 + 0.58 * lit + 0.06 * edge * edge - 0.1 * Math.max(0, y / h - 0.6)) *
        (0.98 + random() * 0.04);
      const luma = 0.3 * px[o] + 0.59 * px[o + 1] + 0.11 * px[o + 2];
      for (let c = 0; c < 3; c++) {
        const v = Math.max(0, Math.min(255, luma + (px[o + c] - luma) * 1.12));
        px[o + c] = shade <= 1 ? v * shade : v + (255 - v) * (shade - 1);
      }
      const g2 = Math.hypot(gx, gy);
      if (g2 > 1e-4) {
        nx[i] = -gx / g2;
        ny[i] = -gy / g2;
      }
    }
  }
  g.putImageData(image, 0, 0);
  // The strands: outward at the edge, flowing down elsewhere, in buckets of one color each.
  const [fx, fy] = piece.flow;
  const total = Math.min((area / (k * k)) * 9, area * 1.1) | 0;
  const lineWidth = Math.max(0.38, k * 0.12);
  const length0 = 1.5 * k * (piece.length ?? 1);
  for (const [share, tone, layerAlpha, lengthF, widthF] of LAYERS) {
    const buckets = new Map();
    const count = (total * share) | 0;
    for (let j = 0, tries = 0; j < count && tries < count * 5; tries++) {
      const x = random() * w;
      const y = random() * h;
      const i = (y | 0) * w + (x | 0);
      if (alpha[i] < 0.5) continue;
      j++;
      const edge = Math.min(1, Math.max(0, (1 - height[i]) * 2.2));
      let rx = x - mx;
      let ry = y - my;
      const rl = Math.hypot(rx, ry) || 1;
      rx /= rl;
      ry /= rl;
      let ox = rx * 0.75 + nx[i] * 0.9 * edge + fx * 0.35 + (random() - 0.5) * 0.8;
      let oy = ry * 0.75 + ny[i] * 0.9 * edge + fy * 0.35 + (random() - 0.5) * 0.8;
      const ol = Math.hypot(ox, oy) || 1;
      ox /= ol;
      oy /= ol;
      const l = length0 * lengthF * (0.7 + random() * 0.6) * (1 + 0.35 * edge);
      const x1 = x + ox * l;
      const y1 = y + oy * l;
      const bend = (random() - 0.5) * 0.5 * l;
      const o = i * 4;
      const t = tone * (0.9 + random() * 0.2);
      const q = (v) =>
        Math.min(255, Math.round((t <= 1 ? v * t : v + (255 - v) * (t - 1)) / 6) * 6);
      const key2 = `${q(px[o])},${q(px[o + 1])},${q(px[o + 2])}`;
      let path = buckets.get(key2);
      if (!path) {
        path = new Path2D();
        buckets.set(key2, path);
      }
      path.moveTo(x, y);
      path.quadraticCurveTo((x + x1) / 2 - oy * bend, (y + y1) / 2 + ox * bend, x1, y1);
    }
    g.lineWidth = lineWidth * widthF;
    g.lineCap = "round";
    g.globalAlpha = layerAlpha;
    for (const [color, path] of buckets) {
      g.strokeStyle = `rgb(${color})`;
      g.stroke(path);
    }
  }
  g.globalAlpha = 1;
  return canvas;
}

/** Finished paintings, by piece and size, for the page's life. */
const paintings = new Map();
const jobs = [];
let pumping = false;
/** How long the last batch of paintings took, from its first job to its last (for measuring). */
const furTiming = { started: 0, pieces: 0, ms: 0 };

/** One painting at a time, in short slices, so the page stays responsive while they arrive. */
function pump() {
  if (pumping) return;
  pumping = true;
  furTiming.started = now();
  furTiming.pieces = 0;
  const run = () => {
    const sliceStart = now();
    while (jobs.length > 0 && now() - sliceStart < 14) {
      const job = jobs.shift();
      try {
        job();
        furTiming.pieces += 1;
      } catch {
        // That piece keeps its flat vector.
      }
    }
    if (jobs.length > 0) {
      setTimeout(run, 0);
      return;
    }
    pumping = false;
    furTiming.ms = now() - furTiming.started;
    performance.measure?.("mascot-fur", { start: furTiming.started, end: now() });
  };
  setTimeout(run, 0);
}

function painting(piece, width) {
  const key = `${width}|${JSON.stringify(piece)}`;
  const known = paintings.get(key);
  if (known) return known;
  const promise = new Promise((resolve, reject) => {
    jobs.push(() =>
      paintFur(piece, width, key).toBlob(
        (blob) => (blob ? resolve(URL.createObjectURL(blob)) : reject(new Error("fur"))),
        "image/png",
      ),
    );
    pump();
  });
  paintings.set(key, promise);
  return promise;
}

function ensureDefs() {
  if (document.getElementById("kg-bead")) return;
  const holder = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  holder.setAttribute("class", "mascot-defs");
  holder.setAttribute("aria-hidden", "true");
  holder.setAttribute("width", "0");
  holder.setAttribute("height", "0");
  holder.innerHTML = SHARED_DEFS;
  document.body.append(holder);
}

/** Every mascot on screen: whether its host is visible, by an observer shared by all. */
const observer =
  "IntersectionObserver" in window
    ? new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const mascot = entry.target.mascot;
            if (!mascot) continue;
            mascot.visible = entry.isIntersecting;
            mascot.breathe();
          }
        },
        { rootMargin: "40px" },
      )
    : null;

class Mascot {
  /**
   * `host` holds the figure; `mode` is "header" for the conversation's, "list" for a roster row,
   * "large" for a profile, or "still" for a pose with no life; `quietable` makes it only blink
   * while the owner types.
   */
  constructor(host, { mascot, px = 48, mode = "header", state = "idle", quietable = false }) {
    ensureDefs();
    this.host = host;
    host.mascot = this;
    this.mascot = mascot;
    this.px = px;
    this.mode = mode;
    this.state = state;
    this.quietable = quietable;
    this.uid = ++uids;
    this.timers = new Set();
    this.visible = true;
    this.recent = [];
    this.activity = null;
    this.session = 0;
    this.override = null;
    this.lastEvent = now();
    this.lastHop = now();
    this.lastWake = 0;
    this.announcedAt = now();
    this.nextGesture = now() + 1200 + Math.random() * 2800;
    this.render();
    if (mode !== "still") {
      live.add(this);
      observer?.observe(host);
      host.addEventListener("pointerenter", () => this.notice());
    }
  }

  render() {
    const hex = getComputedStyle(this.host).getPropertyValue(`--mascot-${this.mascot.color}`);
    const built = buildMascot(this.mascot, {
      uid: this.uid,
      px: this.px,
      hex: hex.trim(),
      work: this.mode !== "still" || HOLDING_STATES.has(this.state),
      hands: this.mode !== "still" || Boolean(HAND_POSES[this.state]),
    });
    this.host.innerHTML = built.html;
    const svg = this.host.firstElementChild;
    this.svg = svg;
    svg.style.setProperty("--body", hex.trim());
    const one = (selector) => svg.querySelector(selector);
    const all = (selector) => [...svg.querySelectorAll(selector)];
    this.hopG = one(".m-hop");
    this.breathG = one(".m-breath");
    this.squash = one(".m-sq");
    this.poseG = one(".m-pose");
    this.fxG = one(".m-fx");
    this.face = one(".m-face");
    this.shadow = one(".m-shadow");
    this.eyeScale = all(".m-eyeP");
    this.blinks = all(".m-blink");
    this.pupils = all(".m-pupil");
    this.brows = all(".m-brow");
    this.ears = all(".m-ear, .m-leaf, .m-ant");
    this.bubbles = all(".bub");
    this.stars = all(".star-a");
    this.zs = all(".zz");
    this.drop = one(".drop");
    this.badgeDot = one(".bd-dot");
    this.badgeRing = one(".bd-ring");
    this.badgeGlyph = one(".bd-g");
    this.badgeBob = one(".bd-bob");
    this.mouthO = one(".mo-o-w");
    this.workG = one(".m-work");
    this.handL = one(".hand-l");
    this.handR = one(".hand-r");
    this.anchors = built.anchors;
    this.crown = built.crown;
    this.frame = built.frame;
    this.shownActivity = null;
    this.applyPose(this.pose(), null);
    const k = (this.px / built.frame.size) * Math.min(2, window.devicePixelRatio || 1) * 1.2;
    for (const node of all(".fp")) {
      const piece = built.pieces[Number(node.dataset.piece)];
      painting(piece, Math.max(12, Math.round(piece.box[2] * k))).then(
        (url) => {
          if (!node.isConnected) return;
          const image = node.querySelector(".fpi");
          image.setAttribute("href", url);
          image.removeAttribute("display");
          node.querySelector(".fpv").setAttribute("display", "none");
        },
        () => {},
      );
    }
    if (HOLDING_STATES.has(this.state)) this.showActivity(false);
    this.breathe();
  }

  /** Swaps the figure: a change the owner made plays a jump, like the dots' "Excite". */
  change(mascot) {
    if (JSON.stringify(mascot) === JSON.stringify(this.mascot)) return;
    this.mascot = mascot;
    this.clearTimers();
    this.render();
    this.excite();
  }

  /**
   * The editor's preview tries a look on (#379): the figure crossfades from the old one in
   * --dur-fade, and the part that changed moves. A shape squashes and settles with --spring-pop, a
   * head or an accessory drops in with --spring-moment-fast, new eyes blink once, and a color only
   * crossfades, with no overshoot. A draw of every axis is the Excite: a 12 px hop and a blink.
   * Each change starts from the figure as it is now, without queueing; in Still it only fades.
   */
  restyle(mascot, axis) {
    if (JSON.stringify(mascot) === JSON.stringify(this.mascot)) return;
    const old = this.svg;
    this.mascot = mascot;
    this.clearTimers();
    this.render();
    old.classList.add("m-leaving");
    this.host.append(old);
    animate(old, [{ opacity: 1 }, { opacity: 0 }], {
      duration: 150,
      easing: "cubic-bezier(0, 0, .2, 1)",
      fill: "forwards",
    }).finished.then(
      () => old.remove(),
      () => old.remove(),
    );
    if (world.motion === "still") return;
    if (axis === "random") {
      this.excite();
    } else if (axis === "shape") {
      // The pop's spring overshoots by 12%, so the squash rebounds past its height.
      const share = this.fit(stretchRise(this.top(), 1 + 0.12 * 0.12, this.poseStretch()));
      this.play(
        this.squash,
        [{ transform: `scale(${1 + 0.1 * share}, ${1 - 0.12 * share})` }, { transform: "none" }],
        { ...SPRINGS.pop, from: false },
      );
    } else if (axis === "head" || axis === "accessory") {
      const name = axis === "head" ? ".m-head" : ".m-acc";
      const drop = 8 * this.fit(8);
      for (const group of this.svg.querySelectorAll(name)) {
        this.play(group, [{ transform: `translate(0px, ${-drop}px)` }, { transform: "none" }], {
          ...SPRINGS.momentFast,
          from: false,
        });
      }
    } else if (axis === "eyes" || axis === "cheeks") {
      this.blink();
    }
  }

  /** The setting changed: stop what it no longer allows, keep the pose. */
  settle() {
    if (world.motion !== "alive" && this.state === "dozing") {
      this.setState("idle", { instant: true });
    }
    // What plays now belongs to the old setting: the pose stays, and the activity's loop starts
    // again only in Alive.
    for (const animation of this.svg.getAnimations({ subtree: true })) animation.cancel();
    this.clearTimers();
    this.override = null;
    this.applyPose(this.pose(), null);
    if (HOLDING_STATES.has(this.state)) this.showActivity(false);
    this.lastEvent = now();
    this.nextGesture = now() + 800 + Math.random() * 1700;
    this.breathe();
  }

  clearTimers() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  later(ms, run) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      run();
    }, ms);
    this.timers.add(timer);
  }

  /**
   * Plays a one-shot on a group whose rest is no transform, from its current frame. In "States
   * only" it is an announcement, cut to end within 5 s of the state's start; in "Still" nothing
   * plays.
   */
  play(element, frames, { from = true, delay = 0, ...timing }) {
    if (!element) return null;
    const elapsed = world.motion === "states" ? now() - this.announcedAt : 0;
    const fits = allowed({ ...timing, delay: elapsed + delay }, world.motion);
    if (!fits) return null;
    const current = getComputedStyle(element).transform;
    cancel(element);
    const keyframes =
      from && current !== "none"
        ? [{ ...frames[0], transform: current }, ...frames.slice(1)]
        : frames;
    return animate(element, keyframes, { ...fits, delay });
  }

  pose() {
    return this.override ? { ...POSES[this.state], ...this.override } : POSES[this.state];
  }

  /** How far the state's pose and breath stretch the figure upward. */
  poseStretch() {
    return stillStretch(this.state, this.mode);
  }

  /**
   * The figure's top in its state's pose, which tilts it. A motion that lifts the figure plays on
   * the group the tilting gestures use, so it stops them.
   */
  top() {
    const { tilt } = POSES[this.state];
    return this.crown(Math.min(0, tilt), Math.max(0, tilt));
  }

  /** The figure's top with both mittens raised above its head, waving up to `swing` degrees. */
  raised(swing = 0) {
    if (!this.handR) return this.top();
    const spot = (name) => handSpot(name, this.anchors);
    return Math.min(
      this.top(),
      mittenTop(spot("upL"), -swing, true),
      mittenTop(spot("upR"), swing),
    );
  }

  /**
   * The share of a motion that keeps the figure in its frame (ADR-0063): one that would lift its
   * top, at `top`, by `rise` grid units.
   */
  fit(rise, top = this.top()) {
    return liftShare(top, this.frame.y, this.poseStretch(), rise);
  }

  /** A stretch to `sx` by `sy` of the figure's size, cut to what fits. */
  stretchTo(sx, sy, top = this.top()) {
    const share = this.fit(stretchRise(top, sy, this.poseStretch()), top);
    return `scale(${1 + (sx - 1) * share}, ${1 + (sy - 1) * share})`;
  }

  applyPose(pose, spring) {
    const svg = this.svg;
    svg.dataset.eyes = pose.eyes;
    svg.dataset.mouth = pose.mouth;
    svg.dataset.fx = pose.fx;
    const badge = WORKING_STATES.has(this.state) && svg.dataset.size === "s" ? "work" : pose.badge;
    svg.dataset.badge = badge;
    if (this.badgeGlyph) {
      this.badgeGlyph.textContent = { wait: "?", error: "!", silent: "…" }[badge] ?? "";
    }
    const posed = `rotate(${pose.tilt}deg) scale(${pose.sx}, ${pose.sy})`;
    poseTo(this.poseG, posed, spring);
    // What shows beside the figure takes its pose, but not its hops (ADR-0065).
    poseTo(this.fxG, posed, spring);
    this.restore(spring, pose);
  }

  restore(spring, pose = this.pose()) {
    const svg = this.svg;
    svg.dataset.eyes = pose.eyes;
    svg.dataset.mouth = pose.mouth;
    svg.dataset.fx = pose.fx;
    this.gaze(pose.gaze, spring);
    for (const eye of this.eyeScale) {
      poseTo(eye, `scale(${Math.max(1, pose.eye)}, ${pose.eye})`, spring);
    }
    this.setBrows(pose.brows, spring);
    this.restoreHands(spring);
  }

  hand(side, name, spring = SPRINGS.base) {
    const hand = side === "l" ? this.handL : this.handR;
    if (!hand) return;
    const dock = transformOf(handSpot(side === "l" ? "dockL" : "dockR", this.anchors));
    const moving = world.motion !== "still" ? spring : null;
    if (!name) {
      if (hand.dataset.on) {
        delete hand.dataset.on;
        poseTo(hand, dock, moving ? SPRINGS.fast : null);
      } else {
        cancel(hand);
        hand.style.transform = dock;
      }
      return;
    }
    if (!hand.dataset.on) {
      cancel(hand);
      hand.style.transform = dock;
      hand.dataset.on = "1";
    }
    poseTo(hand, transformOf(handSpot(name, this.anchors)), moving);
  }

  restoreHands(spring) {
    const hands = this.override?.hands ?? HAND_POSES[this.state] ?? {};
    this.hand("l", hands.l ?? null, spring);
    this.hand("r", hands.r ?? null, spring);
  }

  handGesture(side, frames, timing) {
    const hand = side === "l" ? this.handL : this.handR;
    if (hand) this.play(hand.querySelector(".hg"), frames, { from: false, ...timing });
  }

  setBrows(name, spring) {
    this.svg.dataset.brows = name;
    const angles = {
      none: [
        [0, 0],
        [0, 0],
      ],
      up: [
        [-3.5, 0],
        [-3.5, 0],
      ],
      focus: [
        [1.5, 4],
        [1.5, -4],
      ],
      worry: [
        [-1.5, -16],
        [-1.5, 16],
      ],
      plead: [
        [-3, -24],
        [-3, 24],
      ],
    }[name];
    const one = this.brows.length === 1;
    this.brows.forEach((brow, i) => {
      const [y, r] = one ? [angles[0][0], 0] : angles[i];
      poseTo(brow, `translate(0px, ${y}px) rotate(${r}deg)`, spring);
    });
  }

  gaze([x, y], spring) {
    poseTo(this.face, `translate(${x}px, ${y}px)`, spring);
    for (const pupil of this.pupils) {
      poseTo(pupil, `translate(${x * 0.7}px, ${y * 0.7}px)`, spring);
    }
  }

  /** A short change of expression, back to the pose afterwards. */
  expression(eyes, mouth, ms) {
    if (world.motion === "still") return;
    if (eyes) this.svg.dataset.eyes = eyes;
    if (mouth) this.svg.dataset.mouth = mouth;
    this.later(ms, () => {
      const pose = this.pose();
      this.svg.dataset.eyes = pose.eyes;
      this.svg.dataset.mouth = pose.mouth;
    });
  }

  /** Breathing never stops in "Alive", with its period and depth per state. */
  breathe() {
    this.breath?.cancel();
    this.bob?.cancel();
    this.breath = null;
    this.bob = null;
    const alive = breathes(this, world);
    // The activity's loop stops off screen and in a hidden tab, and comes back with the mascot.
    if (this.state === "working" && this.shownActivity) {
      if (!alive && this.looping) this.stopActivity();
      if (alive && !this.looping) this.runActivity(this.shownActivity);
    }
    if (!alive) return;
    const [period] = BREATH[this.state] ?? BREATH.idle;
    const depth = breathDepth(this.state, this.mode);
    this.breath = animate(
      this.breathG,
      [{ transform: "none" }, { transform: `scale(${1 - depth * 0.45}, ${1 + depth})` }],
      {
        duration: period / 2,
        iterations: Number.POSITIVE_INFINITY,
        direction: "alternate",
        easing: "ease-in-out",
      },
    );
    if (
      this.badgeBob &&
      (POSES[this.state].badge === "wait" || POSES[this.state].badge === "error")
    ) {
      this.bob = animate(
        this.badgeBob,
        [{ transform: "none" }, { transform: "translate(0px, -1.8px) rotate(-3deg)" }],
        {
          duration: 1150,
          iterations: Number.POSITIVE_INFINITY,
          direction: "alternate",
          easing: "ease-in-out",
        },
      );
    }
  }

  /** Reduced motion's change: a 150 ms crossfade. */
  fade() {
    animate(this.svg, [{ opacity: 0.35 }, { opacity: 1 }], { duration: 150, easing: "ease-out" });
  }

  /**
   * Shows a state: its pose, then its announcement. `activity` is the task's object at work;
   * `auto` marks a change the mascot made itself, such as dozing off, which is no event.
   */
  /**
   * Takes a new state: its pose with the moment springs, then its announcement. `instant` shows the
   * pose at once, as a keyboard action does (§4.1); `quiet` moves to it without the announcement,
   * as an expiry or a refusal does (5.3).
   */
  setState(next, { activity = null, auto = false, instant = false, quiet = false } = {}) {
    const previous = this.state;
    if (next === previous && activity === this.activity) return;
    if (HOLDING_STATES.has(previous)) this.stopWork();
    this.state = next;
    this.activity = activity;
    this.recent = [];
    this.override = null;
    this.announcedAt = now();
    if (!auto) this.lastEvent = now();
    this.clearTimers();
    this.nextGesture = now() + Math.min(2500, gapAfter(next, this.mode));
    const pose = POSES[next];
    if (instant || world.motion === "still") {
      for (const animation of this.svg.getAnimations({ subtree: true })) animation.cancel();
      this.breath = null;
      this.applyPose(pose, null);
      if (HOLDING_STATES.has(next)) this.showActivity(false);
      this.breathe();
      if (!instant) this.fade();
      return;
    }
    if (next === "dozing") this.svg.style.setProperty("--sw", "480ms");
    else this.svg.style.removeProperty("--sw");
    // A presence change uses the moment springs; drifting off to sleep is slow (ADR-0045 §6).
    this.applyPose(pose, next === "dozing" ? SPRINGS.slow : SPRINGS.moment);
    this.breathe();
    if (previous === "dozing" && next === "idle") {
      this.play(this.squash, [{ transform: this.stretchTo(0.96, 1.06) }, { transform: "none" }], {
        ...SPRINGS.pop,
        from: false,
      });
    }
    // Back online (#380): a small hop as the plug clicks home, then the state itself.
    if (previous === "offline") {
      this.hop(8);
      this.blink();
    }
    if (!quiet) this.announce(next);
  }

  announce(state) {
    if (state === "offline") {
      this.showActivity(true);
      this.badgeIn(0);
      // The plug drops a little and swings to rest once it has popped out.
      this.later(520, () =>
        this.play(
          this.workG,
          [
            { transform: "none" },
            { transform: "translate(0px, 3px) rotate(9deg)", offset: 0.3 },
            { transform: "translate(0px, 1px) rotate(-5deg)", offset: 0.62 },
            { transform: "none" },
          ],
          { duration: 1000, easing: "ease-out", from: false },
        ),
      );
    }
    if (state === "waiting") {
      this.hop(11, true);
      this.badgeIn(3);
    }
    if (state === "error") {
      this.shake();
      this.badgeIn(0);
    }
    if (state === "noResponse") {
      this.showActivity(false);
      this.badgeIn(0);
    }
    if (state === "approved") {
      this.hop(15, true);
      this.sparkle();
      for (const side of ["l", "r"]) {
        this.handGesture(
          side,
          [
            { transform: "none" },
            { transform: "translate(0px, -3px)", offset: 0.5 },
            { transform: "none" },
          ],
          { duration: 380, iterations: 2, delay: 250 },
        );
      }
    }
    if (state === "working") this.showActivity(true);
    if (state === "typing") this.talk();
    if (state === "dozing") this.zzz();
    if (state === "listening") {
      this.ear(true);
      this.handGesture(
        "r",
        [
          { transform: "none" },
          { transform: "rotate(-12deg)", offset: 0.5 },
          { transform: "none" },
        ],
        { duration: 700, easing: "ease-in-out", delay: 250 },
      );
    }
  }

  /** An event for its agent: it counts against dozing, and wakes a dozing mascot. */
  touch() {
    this.lastEvent = now();
    if (this.state === "dozing") this.setState("idle");
  }

  /** The shared timer's turn for this mascot. */
  tick(at) {
    const action = due(this, { ...world, now: at, hidden: document.hidden });
    if (action === "doze") {
      this.setState("dozing", { auto: true });
      return;
    }
    if (action === "defer") {
      this.nextGesture = at + 1500;
      return;
    }
    if (action === "blink") {
      this.blink();
      this.nextGesture = at + QUIET_BLINK_MS;
      return;
    }
    if (action !== "gesture") return;
    if (this.mode === "list") world.listLock = at + LIST_LOCK_MS;
    const options = available(this.state, this.mode, {
      ears: this.ears.length,
      sinceHop: at - this.lastHop,
      sinceWake: at - this.lastWake,
    });
    const name = draw(options, this.recent);
    if (name) {
      this.recent = remember(this.recent, name);
      this[name]();
    }
    this.nextGesture = at + gapAfter(this.state, this.mode);
  }

  // Working: the task's object comes out of the body and the mittens use it (ADR-0045 §10). It
  // shows only the activity the conversation names, never one that isn't happening.

  showActivity(pop) {
    if (!HOLDING_STATES.has(this.state)) return;
    // Offline always holds its plug; work holds the task's object.
    const next = this.state === "offline" ? "plug" : (this.activity ?? "think");
    const swap = () => {
      if (!HOLDING_STATES.has(this.state)) return;
      this.setActivity(next, pop && world.motion !== "still");
      if (this.state === "working" && breathes(this, world)) this.runActivity(next);
    };
    const leaving =
      this.shownActivity && this.shownActivity !== next && this.workG && pop
        ? this.play(
            this.workG,
            [
              { transform: "none", opacity: 1 },
              { transform: "scale(.4)", opacity: 0 },
            ],
            {
              duration: 160,
              easing: "cubic-bezier(.4,0,1,1)",
              fill: "forwards",
              from: false,
            },
          )
        : null;
    if (leaving) leaving.finished.then(swap, () => {});
    else swap();
  }

  setActivity(activity, pop) {
    this.stopActivity();
    this.shownActivity = activity;
    this.session += 1;
    this.svg.dataset.act = activity;
    this.override = {
      ...(this.state === "working" ? { gaze: ACTIVITIES[activity].gaze } : {}),
      eye: activity === "think" ? 1 : POSES[this.state].eye,
      // Without a reply, the thought bubbles go too: nothing is happening (ADR-0044).
      fx: activity === "think" && this.state === "working" ? "bubbles" : "none",
    };
    this.restore(pop ? SPRINGS.base : null);
    if (this.workG) {
      cancel(this.workG);
      if (pop) {
        this.play(
          this.workG,
          [
            { transform: "translate(-14px, -6px) scale(.3)", opacity: 0 },
            { transform: "none", opacity: 1 },
          ],
          { ...SPRINGS.moment, from: false },
        );
      }
    }
  }

  stopActivity() {
    if (this.workG) for (const part of this.workG.querySelectorAll("*")) cancel(part);
    for (const bubble of this.bubbles) cancel(bubble);
    // Ends the eyes' following too.
    this.session += 1;
    this.looping = false;
  }

  stopWork() {
    this.stopActivity();
    if (this.workG) cancel(this.workG);
    this.shownActivity = null;
    this.svg.dataset.act = "";
  }

  /** The eyes follow the work along these points while the activity lasts. */
  follow(points, ms) {
    const session = this.session;
    let i = 0;
    const step = () => {
      if (this.state !== "working" || session !== this.session || !this.override) return;
      this.override = { ...this.override, gaze: points[i++ % points.length] };
      this.gaze(this.override.gaze, SPRINGS.base);
      this.later(ms, step);
    };
    step();
  }

  /** The activity's loop, in "Alive" only. */
  runActivity(activity) {
    this.looping = true;
    const one = (selector) => this.svg.querySelector(selector);
    const all = (selector) => [...this.svg.querySelectorAll(selector)];
    const loop = { iterations: Number.POSITIVE_INFINITY, from: false };
    const drawLines = (elements, period, slots) => {
      elements.forEach((element, i) => {
        this.play(
          element,
          [
            { strokeDashoffset: 1 },
            { strokeDashoffset: 1, offset: slots[i][0] },
            { strokeDashoffset: 0, offset: slots[i][1] },
            { strokeDashoffset: 0, offset: 0.94 },
            { strokeDashoffset: 1 },
          ],
          { duration: period, easing: "linear", ...loop },
        );
      });
    };
    if (activity === "think") {
      this.bubbleUp(Number.POSITIVE_INFINITY);
      this.follow(
        [
          [0, -3],
          [2, -3.5],
        ],
        1500,
      );
      return;
    }
    if (!this.workG) return;
    if (activity === "search") {
      this.play(
        one(".w-lens"),
        [
          { transform: "translate(-8px, 1px) rotate(-12deg)" },
          { transform: "translate(3px, -3px) rotate(8deg)" },
        ],
        { duration: 1300, direction: "alternate", easing: "ease-in-out", ...loop },
      );
      this.follow(
        [
          [0, 4],
          [4, 3.5],
        ],
        1300,
      );
    }
    if (activity === "vault") {
      this.play(
        one(".w-pen"),
        [
          { transform: "translate(-7px, -5px)" },
          { transform: "translate(4px, -4px)", offset: 0.3 },
          { transform: "translate(-7px, 0px)", offset: 0.36 },
          { transform: "translate(4px, 1px)", offset: 0.64 },
          { transform: "translate(-7px, 5px)", offset: 0.7 },
          { transform: "translate(1px, 6px)", offset: 0.92 },
          { transform: "translate(-7px, -5px)" },
        ],
        { duration: 2600, easing: "linear", ...loop },
      );
      drawLines(all(".p-line"), 2600, [
        [0, 0.3],
        [0.36, 0.64],
        [0.7, 0.92],
      ]);
    }
    if (activity === "code") {
      this.play(
        one(".w-kl"),
        [
          { transform: "none" },
          { transform: "translate(0px, 2px)", offset: 0.25 },
          { transform: "none", offset: 0.5 },
          { transform: "none" },
        ],
        { duration: 300, easing: "ease-in-out", ...loop },
      );
      this.play(
        one(".w-kr"),
        [
          { transform: "none" },
          { transform: "none", offset: 0.5 },
          { transform: "translate(0px, 2px)", offset: 0.75 },
          { transform: "none" },
        ],
        { duration: 300, easing: "ease-in-out", ...loop },
      );
      drawLines(all(".p-code"), 2400, [
        [0, 0.25],
        [0.3, 0.6],
        [0.65, 0.85],
      ]);
    }
    if (activity === "calendar") {
      drawLines([one(".p-check")], 2400, [[0.3, 0.45]]);
      this.play(
        one(".w-stamp"),
        [
          { transform: "none" },
          { transform: "none", offset: 0.2 },
          { transform: "translate(-6px, 2px) scale(.92)", offset: 0.3 },
          { transform: "none", offset: 0.42 },
          { transform: "none" },
        ],
        { duration: 2400, easing: "ease-in-out", ...loop },
      );
      this.play(
        one(".w-page"),
        [
          { transform: "none" },
          { transform: "none", offset: 0.9 },
          { transform: "scale(1, .15)", offset: 0.95 },
          { transform: "none" },
        ],
        { duration: 2400, easing: "ease-in-out", ...loop },
      );
    }
    if (activity === "email") {
      this.play(
        one(".w-env"),
        [
          { transform: "none", opacity: 1 },
          { transform: "none", opacity: 1, offset: 0.35 },
          { transform: "translate(2px, 1px) scale(.95)", opacity: 1, offset: 0.45 },
          {
            transform: "translate(20px, -24px) rotate(-25deg) scale(.6)",
            opacity: 0,
            offset: 0.78,
          },
          { transform: "scale(.3)", opacity: 0, offset: 0.8 },
          { transform: "none", opacity: 1 },
        ],
        { duration: 2400, easing: "ease-in-out", ...loop },
      );
      this.play(
        one(".w-er"),
        [
          { transform: "none" },
          { transform: "none", offset: 0.3 },
          { transform: "translate(-4px, -1px)", offset: 0.42 },
          { transform: "none", offset: 0.55 },
          { transform: "none" },
        ],
        { duration: 2400, easing: "ease-in-out", ...loop },
      );
      this.follow(
        [
          [3, 4],
          [5, 0],
        ],
        1200,
      );
    }
  }

  // The repertoire's gestures, with the frequent springs.

  blink(n = 1) {
    for (const lid of this.blinks) {
      this.play(
        lid,
        [
          { transform: "none" },
          { transform: "scale(1, .08)", offset: 0.45 },
          { transform: "none" },
        ],
        {
          duration: 200,
          easing: "ease-in-out",
          iterations: n,
        },
      );
    }
  }

  glance() {
    this.gaze([randomOf([-4.5, -3.5, 3.5, 4.5]), randomOf([-2, 0, 1.5])], SPRINGS.fast);
    this.later(900 + Math.random() * 700, () => {
      this.gaze(this.pose().gaze, SPRINGS.base);
      if (Math.random() < 0.5) this.blink();
    });
  }

  lookYou(ms = 1300) {
    this.gaze([0, -2], SPRINGS.fast);
    this.blink();
    this.later(ms, () => this.gaze(this.pose().gaze, SPRINGS.base));
  }

  lookAround() {
    this.gaze([-4.5, 0], SPRINGS.fast);
    this.later(750, () => this.gaze([4.5, -0.5], SPRINGS.fast));
    this.later(1550, () => {
      this.gaze(this.pose().gaze, SPRINGS.base);
      this.blink();
    });
  }

  lookDown() {
    this.gaze([0, 4], SPRINGS.base);
    this.later(1300, () => this.gaze(this.pose().gaze, SPRINGS.base));
  }

  lookAtCard() {
    this.gaze([-3, 4], SPRINGS.fast);
    this.hand("l", "cardL", SPRINGS.moment);
    this.handGesture(
      "l",
      [
        { transform: "none" },
        { transform: "translate(-2px, 2px)", offset: 0.5 },
        { transform: "none" },
      ],
      { duration: 420, iterations: 2, delay: 200 },
    );
    this.later(1150, () => {
      this.gaze(this.pose().gaze, SPRINGS.fast);
      this.blink();
      this.restoreHands(SPRINGS.base);
    });
  }

  wiggle() {
    this.play(
      this.squash,
      [
        { transform: "none" },
        { transform: "rotate(-5deg)", offset: 0.25 },
        { transform: "rotate(4deg)", offset: 0.55 },
        { transform: "rotate(-1.5deg)", offset: 0.8 },
        { transform: "none" },
      ],
      { duration: 720, easing: "ease-in-out" },
    );
  }

  /** Scratches its head. */
  scratch() {
    this.play(
      this.squash,
      [
        { transform: "none" },
        { transform: "rotate(7deg)", offset: 0.25 },
        { transform: "rotate(7deg)", offset: 0.75 },
        { transform: "none" },
      ],
      { duration: 1600, easing: "ease-in-out" },
    );
    this.gaze([1.5, -1], SPRINGS.fast);
    this.hand("r", "headR");
    this.handGesture(
      "r",
      [
        { transform: "none" },
        { transform: "translate(0px, -2.4px)", offset: 0.5 },
        { transform: "none" },
      ],
      { duration: 300, iterations: 4, easing: "ease-in-out", delay: 250 },
    );
    this.later(1400, () => {
      this.gaze(this.pose().gaze, SPRINGS.base);
      this.restoreHands(SPRINGS.base);
    });
  }

  tiltFlip() {
    this.play(
      this.squash,
      [
        { transform: "none" },
        { transform: "rotate(16deg)", offset: 0.3 },
        { transform: "rotate(16deg)", offset: 0.75 },
        { transform: "none" },
      ],
      { duration: 1500, easing: "ease-in-out" },
    );
  }

  stretch() {
    this.expression("closed", null, 750);
    // Its mittens go up as it stretches.
    const tall = this.stretchTo(0.95, 1.09, this.raised());
    this.play(
      this.squash,
      [
        { transform: "none" },
        { transform: tall, offset: 0.35, easing: "ease-out" },
        { transform: tall, offset: 0.6 },
        { transform: "none" },
      ],
      { duration: 1100, easing: "ease-in-out" },
    );
    this.hand("l", "upL");
    this.hand("r", "upR");
    this.later(950, () => this.restoreHands(SPRINGS.base));
  }

  yawn() {
    this.expression("closed", "o", 1300);
    this.hand("r", "mouthR", SPRINGS.fast);
    this.later(1250, () => this.restoreHands(SPRINGS.base));
    this.play(
      this.mouthO,
      [
        { transform: "none" },
        { transform: "scale(1.6, 1.9)", offset: 0.3 },
        { transform: "scale(1.6, 1.9)", offset: 0.7 },
        { transform: "none" },
      ],
      { duration: 1300, easing: "ease-in-out", from: false },
    );
    const tall = this.stretchTo(0.97, 1.06);
    this.play(
      this.squash,
      [
        { transform: "none" },
        { transform: tall, offset: 0.35 },
        { transform: tall, offset: 0.7 },
        { transform: "none" },
      ],
      { duration: 1300, easing: "ease-in-out" },
    );
  }

  sigh() {
    this.expression("closed", null, 700);
    this.play(
      this.squash,
      [
        { transform: "none" },
        { transform: "scale(1.03, .93)", offset: 0.45, easing: "ease-out" },
        { transform: "scale(1.03, .93)", offset: 0.6 },
        { transform: "none" },
      ],
      { duration: 1600, easing: "ease-in-out" },
    );
  }

  nod() {
    this.play(
      this.squash,
      [
        { transform: "none" },
        { transform: "translate(0px, 2px) scale(1.01, .97)", offset: 0.25 },
        { transform: "none", offset: 0.5 },
        { transform: "translate(0px, 2px) scale(1.01, .97)", offset: 0.75 },
        { transform: "none" },
      ],
      { duration: 900, easing: "ease-in-out" },
    );
  }

  /** Drums on its chin. */
  impatient() {
    this.hand("r", "chinR", SPRINGS.fast);
    this.handGesture(
      "r",
      Array.from({ length: 8 }, (_, i) => ({
        transform: i % 2 ? "translate(0px, -1.6px)" : "none",
      })),
      { duration: 1100, easing: "linear", delay: 150 },
    );
    this.later(1400, () => this.restoreHands(SPRINGS.base));
  }

  sway() {
    this.play(
      this.squash,
      [
        { transform: "none" },
        { transform: "rotate(-7deg)", offset: 0.2 },
        { transform: "rotate(7deg)", offset: 0.45 },
        { transform: "rotate(-5deg)", offset: 0.7 },
        { transform: "rotate(3deg)", offset: 0.85 },
        { transform: "none" },
      ],
      { duration: 1200, easing: "ease-in-out" },
    );
    this.wave("l", 2);
    this.wave("r", 2);
  }

  tremble() {
    this.play(
      this.squash,
      Array.from({ length: 11 }, (_, i) => ({
        transform: i % 10 === 0 ? "none" : `translate(${i % 2 ? 1.6 : -1.6}px, 0px)`,
      })),
      { duration: 520, easing: "linear" },
    );
  }

  ear(both = false) {
    const ears = both ? this.ears : this.ears.length > 0 ? [randomOf(this.ears)] : [];
    if (ears.length === 0) {
      if (!both) this.wiggle();
      return;
    }
    ears.forEach((ear, i) => {
      this.play(
        ear,
        [
          { transform: "none" },
          { transform: `rotate(${i ? 14 : -14}deg)`, offset: 0.3 },
          { transform: `rotate(${i ? -6 : 6}deg)`, offset: 0.65 },
          { transform: "none" },
        ],
        { duration: 460, easing: "ease-out" },
      );
    });
  }

  hop(height, moment = false, top = this.top()) {
    if (world.motion === "still") return;
    const full = height ?? (this.mode === "large" ? 9 : 7);
    // Cut to the room above the figure (ADR-0063): a share of the hop lifts it, squashes it and
    // shrinks its shadow by that share. A hop with no room doesn't play.
    const share = this.fit(hopRise(top, full, this.poseStretch()), top);
    this.lastHop = now();
    if (share === 0) return;
    const h = full * share;
    const squash = ([offset, sx, sy]) => ({
      transform: `scale(${1 + (sx - 1) * share}, ${1 + (sy - 1) * share})`,
      offset,
    });
    const shadow = `scale(${1 - 0.3 * share}, ${1 - 0.3 * share})`;
    const duration = moment ? 500 : 440;
    this.play(
      this.hopG,
      HOP.lift.map(([offset, y, easing]) => ({
        transform: y ? `translate(0px, ${-h * y}px)` : "none",
        offset,
        ...(easing ? { easing } : {}),
      })),
      { duration, easing: "linear" },
    );
    this.play(
      this.shadow,
      [
        { transform: "none", opacity: 1 },
        { transform: "none", opacity: 1, offset: 0.2 },
        { transform: shadow, opacity: 1 - 0.55 * share, offset: 0.52 },
        { transform: "none", opacity: 1, offset: 0.84 },
        { transform: "none", opacity: 1 },
      ],
      { duration, easing: "linear", from: false },
    );
    const squashed = this.play(this.squash, HOP.squash.map(squash), {
      duration,
      easing: HOP.squashEasing,
      fill: "forwards",
    });
    const { transform: landed } = squash(HOP.squash.at(-1));
    squashed?.finished.then(
      () =>
        this.play(this.squash, [{ transform: landed }, { transform: "none" }], {
          ...(moment ? SPRINGS.pop : SPRINGS.base),
        }),
      () => {},
    );
  }

  doubleHop() {
    this.hop(6);
    this.later(520, () => this.hop(5));
  }

  excite() {
    if (world.motion === "still") {
      this.fade();
      return;
    }
    this.hop(12, true);
    this.blink();
  }

  shake() {
    this.play(
      this.squash,
      [
        { transform: "none" },
        { transform: "translate(-6px, 0px)" },
        { transform: "translate(6px, 0px)" },
        { transform: "translate(-4px, 0px)" },
        { transform: "translate(3px, 0px)" },
        { transform: "none" },
      ],
      { duration: 380, easing: "ease-out" },
    );
  }

  talk() {
    this.play(
      this.mouthO,
      [{ transform: "none" }, { transform: "scale(1.25, .5)", offset: 0.5 }, { transform: "none" }],
      { duration: 380, iterations: 11, easing: "ease-in-out", from: false },
    );
    this.handGesture(
      "l",
      [
        { transform: "none" },
        { transform: "translate(0px, 2px)", offset: 0.25 },
        { transform: "none", offset: 0.5 },
        { transform: "none" },
      ],
      { duration: 320, iterations: 13, easing: "ease-in-out" },
    );
    this.handGesture(
      "r",
      [
        { transform: "none" },
        { transform: "none", offset: 0.5 },
        { transform: "translate(0px, 2px)", offset: 0.75 },
        { transform: "none" },
      ],
      { duration: 320, iterations: 13, easing: "ease-in-out" },
    );
  }

  bubbleUp(n) {
    this.bubbles.forEach((bubble, i) => {
      this.play(
        bubble,
        [
          { transform: "translate(0px, 7px) scale(.4)", opacity: 0 },
          { opacity: 1, offset: 0.25 },
          { transform: "translate(0px, -3px) scale(1)", opacity: 1, offset: 0.75 },
          { transform: "translate(0px, -8px) scale(1.08)", opacity: 0 },
        ],
        {
          duration: 1400,
          iterations: n,
          delay: i * 320,
          easing: "ease-out",
          fill: "backwards",
          from: false,
        },
      );
    });
  }

  /** The bubble pops out of the head; at 36 px the badge pops and rings. */
  badgeIn(pulses) {
    if (this.badgeBob) {
      this.play(
        this.badgeDot,
        [{ transform: "translate(-12px, 12px) scale(0)" }, { transform: "none" }],
        {
          ...SPRINGS.pop,
          from: false,
        },
      );
      for (let i = 0; i < pulses; i++) this.later(700 + i * 1500, () => this.pulse());
      return;
    }
    this.play(this.badgeDot, [{ transform: "scale(0)" }, { transform: "none" }], {
      ...SPRINGS.pop,
      from: false,
    });
    if (pulses) {
      this.play(
        this.badgeRing,
        [
          { transform: "scale(1)", opacity: 0.8 },
          { transform: "scale(2.1)", opacity: 0 },
        ],
        {
          duration: 1600,
          iterations: pulses,
          delay: 150,
          easing: "cubic-bezier(.2,0,0,1)",
          from: false,
        },
      );
    }
  }

  pulse() {
    if (this.badgeBob) {
      this.play(
        this.badgeDot,
        [
          { transform: "none" },
          { transform: "scale(1.2) rotate(-6deg)", offset: 0.35 },
          { transform: "scale(.96) rotate(3deg)", offset: 0.7 },
          { transform: "none" },
        ],
        { duration: 560, easing: "ease-in-out", from: false },
      );
      return;
    }
    this.play(
      this.badgeRing,
      [
        { transform: "scale(1)", opacity: 0.8 },
        { transform: "scale(2.1)", opacity: 0 },
      ],
      {
        duration: 1600,
        easing: "cubic-bezier(.2,0,0,1)",
        from: false,
      },
    );
  }

  /** Offline: looks down at the plug it holds, then back. */
  lookAtPlug() {
    this.gaze([4, 5], SPRINGS.base);
    this.blink();
    this.later(1300, () => this.restore(SPRINGS.base));
  }

  /** Offline: reaches the plug out, as into a socket, and draws it back. */
  tryPlug() {
    this.play(
      this.workG,
      [
        { transform: "none" },
        { transform: "translate(5px, -3px) rotate(-12deg)", offset: 0.4 },
        { transform: "translate(6px, -3px) rotate(-12deg)", offset: 0.58 },
        { transform: "none" },
      ],
      { duration: 1300, easing: "ease-in-out", from: false },
    );
    this.gaze([5, 2], SPRINGS.base);
    this.later(1400, () => this.restore(SPRINGS.base));
  }

  /** Offline: gives the plug a little shake. */
  shakePlug() {
    this.play(
      this.workG,
      [
        { transform: "none" },
        { transform: "rotate(-9deg)", offset: 0.2 },
        { transform: "rotate(8deg)", offset: 0.45 },
        { transform: "rotate(-5deg)", offset: 0.7 },
        { transform: "none" },
      ],
      { duration: 720, easing: "ease-in-out", from: false },
    );
  }

  wave(side, n = 3, spot) {
    this.hand(side, spot ?? (side === "l" ? "waveL" : "waveR"), SPRINGS.moment);
    this.handGesture(
      side,
      [
        { transform: "none" },
        { transform: `rotate(${side === "l" ? -22 : 22}deg)`, offset: 0.5 },
        { transform: "none" },
      ],
      { duration: 420, iterations: n, easing: "ease-in-out", delay: 140 },
    );
    this.later(420 * n + 450, () => this.restoreHands(SPRINGS.base));
  }

  clap() {
    this.hand("l", "clapL", SPRINGS.fast);
    this.hand("r", "clapR", SPRINGS.fast);
    for (const [side, x] of [
      ["l", 6],
      ["r", -6],
    ]) {
      this.handGesture(
        side,
        [
          { transform: "none" },
          { transform: `translate(${x}px, 0px)`, offset: 0.5 },
          { transform: "none" },
        ],
        { duration: 300, iterations: 3, easing: "ease-in-out", delay: 160 },
      );
    }
    this.later(1300, () => this.restoreHands(SPRINGS.base));
  }

  callAttention() {
    this.hop(10, true);
    this.later(250, () => this.lookYou(1400));
    this.wave("r", 3);
    this.pulse();
  }

  callHelp() {
    // It hops with both mittens up, waving.
    this.hop(9, true, this.raised(22));
    this.later(300, () => this.lookYou(1400));
    this.wave("l", 3, "upL");
    this.wave("r", 3, "upR");
    this.pulse();
  }

  plead() {
    this.setBrows("plead", SPRINGS.fast);
    this.lookYou(1500);
    this.hop(4);
    this.hand("l", "pleaseL", SPRINGS.fast);
    this.hand("r", "pleaseR", SPRINGS.fast);
    for (const side of ["l", "r"]) {
      this.handGesture(
        side,
        [
          { transform: "none" },
          { transform: "translate(0px, -1.5px)", offset: 0.5 },
          { transform: "none" },
        ],
        { duration: 360, iterations: 3, delay: 200 },
      );
    }
    this.later(1600, () => {
      this.setBrows(this.pose().brows, SPRINGS.base);
      this.restoreHands(SPRINGS.base);
    });
  }

  /** Wipes its brow. */
  sweat() {
    this.hand("r", "browR", SPRINGS.fast);
    this.later(380, () => this.hand("r", "browSweep", SPRINGS.base));
    this.later(1050, () => this.restoreHands(SPRINGS.base));
    this.play(
      this.drop,
      [
        { opacity: 0, transform: "translate(0px, -2px) scale(.5)" },
        { opacity: 1, transform: "none", offset: 0.2 },
        { opacity: 1, transform: "translate(1px, 9px)", offset: 0.8 },
        { opacity: 0, transform: "translate(1px, 13px) scale(.8)" },
      ],
      { duration: 1700, easing: "ease-in", from: false },
    );
    this.later(200, () => this.blink());
  }

  sparkle() {
    this.stars.forEach((star, i) => {
      this.play(
        star,
        [
          { transform: "scale(0) rotate(-40deg)", opacity: 0 },
          { transform: "scale(1.2) rotate(8deg)", opacity: 1, offset: 0.5 },
          { transform: "none", opacity: 1 },
        ],
        {
          duration: 520,
          delay: 60 + i * 80,
          easing: "cubic-bezier(.2,.8,.3,1)",
          fill: "backwards",
          from: false,
        },
      );
    });
  }

  zzz() {
    this.zs.forEach((z, i) => {
      this.play(
        z,
        [
          { transform: "translate(-4px, 8px) scale(.6)", opacity: 0 },
          { transform: "none", opacity: 1 },
        ],
        {
          duration: 900,
          delay: 300 + i * 350,
          easing: "cubic-bezier(.2,0,0,1)",
          fill: "backwards",
          from: false,
        },
      );
    });
  }

  snore() {
    this.zzz();
    this.play(
      this.squash,
      [
        { transform: "none" },
        { transform: "scale(1.03, .96)", offset: 0.5 },
        { transform: "none" },
      ],
      {
        duration: 1800,
        easing: "ease-in-out",
      },
    );
  }

  stir() {
    this.play(
      this.squash,
      [
        { transform: "none" },
        { transform: "rotate(-3deg)", offset: 0.3 },
        { transform: "rotate(2.5deg)", offset: 0.65 },
        { transform: "none" },
      ],
      { duration: 1400, easing: "ease-in-out" },
    );
    if (this.ears.length > 0 && Math.random() < 0.5) this.later(500, () => this.ear(false));
  }

  /** Asleep, it wakes now and then: rubs its eyes, stretches, looks around, yawns, dozes again. */
  wakeBored() {
    this.lastWake = now();
    this.svg.style.removeProperty("--sw");
    this.override = {
      eyes: "open",
      fx: "none",
      gaze: [0, 0],
      eye: 0.8,
      hands: { l: "eyeL", r: "eyeR" },
    };
    this.restore(SPRINGS.base);
    for (const side of ["l", "r"]) {
      this.handGesture(
        side,
        [
          { transform: "none" },
          { transform: "translate(1.5px, -1px)", offset: 0.25 },
          { transform: "translate(-1px, 1px)", offset: 0.75 },
          { transform: "none" },
        ],
        { duration: 300, iterations: 3, easing: "linear", delay: 200 },
      );
    }
    this.later(1100, () => {
      this.override = { ...this.override, hands: null };
      this.stretch();
    });
    this.later(2200, () => this.lookAround());
    this.later(3900, () => this.yawn());
    this.later(5400, () => {
      this.override = { ...this.override, gaze: [0, -1.5], eye: 0.6, hands: { r: "chinR" } };
      this.restore(SPRINGS.base);
    });
    this.later(6400, () => this.sigh());
    this.later(7900, () => {
      this.override = null;
      this.svg.style.setProperty("--sw", "480ms");
      this.restore(SPRINGS.slow);
      this.zzz();
    });
  }

  /** A reply lands: a smile, and a hop when motion allows. */
  arrive() {
    this.touch();
    this.expression("happy", "smile", 650);
    this.hop(10, true);
  }

  /** A click or tap on an idle mascot makes it clap (ADR-0045 §10). */
  pet() {
    if (this.state === "dozing") {
      this.touch();
      return;
    }
    this.touch();
    if (this.state !== "idle" || world.motion !== "alive") return;
    this.expression("happy", "smile", 650);
    this.hop(10, true);
    this.svg.dataset.fx = "spark";
    this.sparkle();
    this.clap();
    this.later(900, () => {
      this.svg.dataset.fx = this.pose().fx;
    });
  }

  /** The pointer arrives: it looks up and waves; a dozing one wakes. */
  notice() {
    const at = now();
    if (at - (this.lastNotice ?? 0) < 1500) return;
    this.lastNotice = at;
    this.lastEvent = at;
    if (this.state === "dozing") {
      this.setState("idle");
      return;
    }
    if (this.state !== "idle" || world.motion !== "alive") return;
    this.lookYou(1300);
    this.wave("r", 2);
  }

  /**
   * The owner types: an event for the agent, which wakes a dozing mascot. Reading comes first, so
   * it only breathes and blinks meanwhile (`ownerTyping`).
   */
  watch() {
    this.touch();
  }
}

// One timer for every live mascot. It skips a hidden tab, and each mascot's guards do the rest.
setInterval(() => {
  if (document.hidden) return;
  const at = now();
  for (const mascot of live) {
    if (!mascot.host.isConnected) {
      live.delete(mascot);
      continue;
    }
    mascot.tick(at);
  }
}, 400);

document.addEventListener("visibilitychange", () => {
  world.hidden = document.hidden;
  for (const mascot of live) mascot.breathe();
});

  return { setMotion, ownerTyping, furTiming, Mascot };
  })();
  // ── Kelpie.ui: what every preview shares ────────────────────────────────────────────────────
  // Motion reads its values from the tokens (tokens.css), so a value changed in the system
  // changes every preview. Reduced motion replaces movement with a short fade (rule 10).
  var ui = (function () {
    var root = document.documentElement;
    var KEEP = ["opacity", "offset", "color", "backgroundColor", "borderColor"];
    var mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    function token(name) {
      return getComputedStyle(root).getPropertyValue("--" + name).trim();
    }
    function num(name, fallback) {
      var v = parseFloat(token(name));
      return isNaN(v) ? fallback : v;
    }
    function reduced() {
      return mq.matches || root.hasAttribute("data-reduced");
    }
    function spring(name) {
      return {
        duration: num("spring-" + name + "-dur", 266),
        easing: token("spring-" + name) || "ease-out",
      };
    }
    function ease(name) {
      return token("ease-" + name) || "ease-out";
    }
    // o: { spring } or { dur, ease }, plus delay, fill, essential (progress keeps moving).
    function animate(el, frames, o) {
      o = o || {};
      var timing = o.spring
        ? spring(o.spring)
        : { duration: o.dur != null ? o.dur : num("dur-fade", 150), easing: o.ease || ease("standard") };
      var fr = frames;
      if (reduced() && !o.essential) {
        fr = frames.map(function (f) {
          var g = {};
          KEEP.forEach(function (k) {
            if (k in f) g[k] = f[k];
          });
          return g;
        });
        timing = { duration: Math.min(timing.duration, num("dur-fade", 150)), easing: ease("fade") };
      }
      return el.animate(fr, {
        duration: timing.duration,
        easing: timing.easing,
        delay: o.delay || 0,
        fill: o.fill || "backwards",
      });
    }
    // Enters from below and a little smaller; the moment grammar travels farther.
    function enter(el, o) {
      o = o || {};
      var rise = o.y != null ? o.y : num(o.moment ? "rise-moment" : "rise", 8);
      var scale = o.scale != null ? o.scale : num(o.moment ? "scale-in-moment" : "scale-in", 0.97);
      return animate(
        el,
        [
          { opacity: 0, transform: "translate(" + (o.x || 0) + "px, " + rise + "px) scale(" + scale + ")" },
          { opacity: 1, transform: "none" },
        ],
        { spring: o.spring || (o.moment ? "moment" : "base"), delay: o.delay },
      );
    }
    // Leaving is faster than arriving (rule 9).
    function exit(el, o) {
      o = o || {};
      return animate(
        el,
        [
          { opacity: 1, transform: "none" },
          { opacity: 0, transform: "translate(0px, " + (o.y != null ? o.y : -4) + "px) scale(" + (o.scale || 0.985) + ")" },
        ],
        { dur: num(o.moment ? "dur-exit-moment" : "dur-exit", 120), ease: ease("exit"), fill: "forwards", delay: o.delay },
      );
    }
    // A label that rolls: the old one leaves upward, the new one rises (5.2).
    function roll(box, html, o) {
      o = o || {};
      var old = box.lastElementChild;
      var next = document.createElement("span");
      next.className = "n";
      next.innerHTML = html;
      box.append(next);
      if (old) {
        animate(old, [{ transform: "none", opacity: 1 }, { transform: "translateY(-75%)", opacity: 0 }], {
          dur: num("dur-exit", 120),
          ease: ease("exit"),
          fill: "forwards",
        }).finished.then(
          function () { old.remove(); },
          function () { old.remove(); },
        );
      }
      animate(next, [{ transform: "translateY(75%)", opacity: 0 }, { transform: "none", opacity: 1 }], {
        spring: o.spring || "fast",
        delay: o.delay,
      });
      return next;
    }
    // A scripted run that a replay cancels: every wait checks it is still current.
    var STOP = {};
    function runner(play) {
      var current = null;
      // A fresh run cancels the one before it; a click takes over with `start.takeover()`.
      function fresh() {
        if (current) {
          current.alive = false;
          current.timers.forEach(clearTimeout);
        }
        var run = {
          alive: true,
          timers: [],
          sleep: function (ms) {
            return new Promise(function (resolve, reject) {
              run.timers.push(
                setTimeout(function () {
                  if (run.alive) resolve();
                  else reject(STOP);
                }, ms),
              );
            });
          },
          later: function (ms, fn) {
            run.timers.push(setTimeout(function () { if (run.alive) fn(); }, ms));
          },
        };
        current = run;
        return run;
      }
      function start() {
        var run = fresh();
        guard(play(run));
        return run;
      }
      start.takeover = fresh;
      return start;
    }
    // Swallows the stop of a cancelled run; anything else still reaches the console.
    function guard(p) {
      Promise.resolve(p).catch(function (e) {
        if (e !== STOP) console.error(e);
      });
    }
    // The webchat's own glyphs (apps/ingress/public/webchat/icons.js), drawn with currentColor.
    var PATHS = {
      clock: ["M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11Z", "M8 5v3.2l2 1.3"],
      alert: ["M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11Z", "M8 5v3.5", "M8 10.6v.4"],
      check: ["M3.5 8.5l3 3l6-6.5"],
      neutral: ["M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11Z", "M5.5 8h5"],
      chevron: ["M4.5 6.5l3.5 3.5l3.5-3.5"],
      close: ["M4.5 4.5l7 7", "M11.5 4.5l-7 7"],
      display: ["M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11Z", "M8 2.5v11"],
      // From the webchat's mockup (#378): the composer's Pause and Send, the theme, a lost connection, the strip.
      pause: ["M6 4.5v7", "M10 4.5v7"],
      send: ["M8 13V3.5", "M4 7.5l4-4 4 4"],
      monitor: ["M3.5 3h9A1.5 1.5 0 0 1 14 4.5v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 10V4.5A1.5 1.5 0 0 1 3.5 3Z", "M6 14h4", "M8 11.5V14"],
      sun: ["M8 5.2a2.8 2.8 0 1 0 0 5.6a2.8 2.8 0 1 0 0-5.6Z", "M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M3.6 12.4l1-1M11.4 4.6l1-1"],
      moon: ["M13 9.6A5.2 5.2 0 0 1 6.4 3a5.2 5.2 0 1 0 6.6 6.6Z"],
      wifiOff: ["M2 2l12 12", "M5.5 8.6a4 4 0 0 1 4.2-.9", "M3 6.2a7.5 7.5 0 0 1 2.8-1.7", "M10.6 4.6A7.5 7.5 0 0 1 13 6.2", "M7 11a1.5 1.5 0 0 1 2 0"],
      bell: ["M4 11V7.5a4 4 0 0 1 8 0V11l1 1.5H3Z", "M6.5 14h3"],
      // From the §8 research on the comfort controls: text size as letters (Lucide's a-large-small),
      // less motion as a circle with one trail (Material's motion_blur, reduced).
      textSmall: ["M5.48 13.5L8 6.50L10.52 13.5M6.49 10.70H9.51"],
      textLarge: ["M4.04 13.5L8 2.50L11.96 13.5M5.62 9.10H10.38"],
      lessMotion: ["M11 5.25a2.75 2.75 0 1 0 0 5.5a2.75 2.75 0 1 0 0-5.5Z", "M2.75 8h4"],
      // The account's chevron, which opens upward (5.24).
      chevronUp: ["M4.5 9.5L8 6l3.5 3.5"],
      // The agent's editor (5.25, 5.26): the pencil on a mascot, Undo as a U-turn (a circle reads as
      // refresh), Randomize as a die with three pips (a shuffle means reorder), and Master's lock.
      pencil: ["M10.5 2.8l2.4 2.4L6.2 11.9l-3 .8.8-3z", "M9.2 4.1l2.4 2.4"],
      undo: ["M5.5 4L2.5 7l3 3", "M2.5 7h7a3.5 3.5 0 0 1 0 7H8"],
      dice: ["M5 2.5h6A2.5 2.5 0 0 1 13.5 5v6a2.5 2.5 0 0 1-2.5 2.5H5A2.5 2.5 0 0 1 2.5 11V5A2.5 2.5 0 0 1 5 2.5Z", { d: "M5.5 4.5a1 1 0 1 0 0 2a1 1 0 1 0 0-2Z", solid: true }, { d: "M8 7a1 1 0 1 0 0 2a1 1 0 1 0 0-2Z", solid: true }, { d: "M10.5 9.5a1 1 0 1 0 0 2a1 1 0 1 0 0-2Z", solid: true }],
      lock: ["M5 7h6a1.5 1.5 0 0 1 1.5 1.5v3.5A1.5 1.5 0 0 1 11 13.5H5A1.5 1.5 0 0 1 3.5 12V8.5A1.5 1.5 0 0 1 5 7Z", "M5.5 7V5a2.5 2.5 0 0 1 5 0v2"],
      // The editor's sections: an ID card, a page with a heart, a list, two stacked notes and a puzzle
      // piece; the Mascot section is the mascot's own outline (pauseIcon("body")). None is a 5.9 glyph.
      profile: ["M3.5 3.5h9A1.5 1.5 0 0 1 14 5v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11V5a1.5 1.5 0 0 1 1.5-1.5Z", "M5.8 6a1.3 1.3 0 1 0 0 2.6a1.3 1.3 0 1 0 0-2.6Z", "M4 10.4c.5-.9 1.1-1.3 1.8-1.3s1.3.4 1.8 1.3M9.5 7h3M9.5 9.5h3"],
      soul: ["M4 2.5h5.5l3 3v8H4z", "M9.5 2.5v3h3", "M8.2 11.6s-2-1.2-2-2.5a1 1 0 0 1 2-.5a1 1 0 0 1 2 .5c0 1.3-2 2.5-2 2.5z"],
      rules: ["M6.5 4.5h7M6.5 8h7M6.5 11.5h7", { d: "M3.4 3.6a.9.9 0 1 0 0 1.8a.9.9 0 1 0 0-1.8Z", solid: true }, { d: "M3.4 7.1a.9.9 0 1 0 0 1.8a.9.9 0 1 0 0-1.8Z", solid: true }, { d: "M3.4 10.6a.9.9 0 1 0 0 1.8a.9.9 0 1 0 0-1.8Z", solid: true }],
      memory: ["M5.5 3.5h7v7", "M3.5 5.5h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z", "M4.5 8.5h4M4.5 11h3"],
      skills: ["M6.5 3.5h1.7a1.3 1.3 0 0 1 2.6 0h1.7v2.2a1.3 1.3 0 0 1 0 2.6V11h-2.3a1.3 1.3 0 0 0-2.6 0H5.4V8.3a1.3 1.3 0 0 1 0-2.6V3.5z"],
    };
    // More contrast: a rounded square split on its diagonal, never the half-filled circle of "working".
    var CONTRAST = '<rect x="2.75" y="2.75" width="10.5" height="10.5" rx="2.5"/><path d="M13.25 2.75V10.75A2.5 2.5 0 0 1 10.75 13.25H2.75Z" fill="currentColor" stroke="none"/>';
    function icon(name, cls) {
      if (name === "contrast") return '<svg class="k-icon ' + (cls || "") + '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' + CONTRAST + "</svg>";
      return (
        '<svg class="k-icon ' + (cls || "") + '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
        (PATHS[name] || []).map(function (d) { return typeof d === "string" ? '<path pathLength="1" d="' + d + '"/>' : '<path d="' + d.d + '" fill="currentColor" stroke="none"/>'; }).join("") +
        "</svg>"
      );
    }
    // The state glyphs of 5.9: they carry the state beside the label, in every theme and in forced colors.
    var GLYPHS = {
      working: '<circle cx="6" cy="6" r="4.6" fill="none"/><path d="M6 1.4a4.6 4.6 0 010 9.2z" stroke="none"/>',
      waiting: '<path d="M6 1l5 5-5 5-5-5z" stroke="none"/>',
      idle: '<circle cx="6" cy="6" r="4.6" fill="none"/>',
      error: '<path d="M6 1.2l5.2 9.4H.8z" stroke="none"/>',
      noResponse: '<circle cx="6" cy="6" r="4.6" fill="none" stroke-dasharray="2.2 1.8"/>',
      offline: '<circle cx="6" cy="6" r="4.6" fill="none"/><path d="M2.4 9.6L9.6 2.4" fill="none"/>',
    };
    function glyph(state) {
      return '<svg class="k-glyph" viewBox="0 0 12 12" aria-hidden="true">' + (GLYPHS[state] || "") + "</svg>";
    }
    // The mascot's pause as icons: its own outline, as Master's now looks (pointed ears, ADR-0062),
    // mid-hop for Alive, with 5.19's badge for States only, standing on a line for Still (#378, decision 8).
    var BODY = '<path d="M9 6.5h2a6 6 0 0 1 6 6v0a5.5 5.5 0 0 1-5.5 5.5H5a2 2 0 0 1-2-2v-3.5a6 6 0 0 1 6-6Z"/><path d="M8.05 6.79L4.56 8.62C4.41 8.18 4.34 7.65 4.35 6.66L4.48 3.8C4.51 3.49 4.64 3.32 4.86 3.27C5.25 3.2 5.84 3.44 6.04 3.74Z" fill="currentColor" stroke="none"/><path d="M11.95 6.79L15.44 8.62C15.59 8.18 15.66 7.65 15.65 6.66L15.52 3.8C15.49 3.49 15.36 3.32 15.14 3.27C14.75 3.2 14.16 3.44 13.96 3.74Z" fill="currentColor" stroke="none"/><circle cx="8.2" cy="12.4" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12.4" r="1" fill="currentColor" stroke="none"/>';
    var PAUSE_ICONS = {
      alive: '<g transform="translate(-.6 -1.8) rotate(-9 10 12)">' + BODY + '</g><path d="M6.5 19.2h6"/><path d="M17.2 2.4l.8 1.6M19 5.4l-1.6.6"/>',
      states: '<g transform="translate(-1.2 .9) scale(.9)">' + BODY + '</g><circle cx="16.4" cy="4" r="2.6" fill="currentColor" stroke="none"/>',
      still: '<g transform="translate(0 -.4)">' + BODY + '</g><path d="M3 19.2h14"/>',
      // The editor's Mascot section (5.25): the outline at rest.
      body: '<g transform="translate(0 -1.6)">' + BODY + "</g>",
    };
    function pauseIcon(kind) {
      return '<svg class="k-icon m20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">' + PAUSE_ICONS[kind] + "</svg>";
    }
    // Icon buttons name themselves in a tooltip (5.26): the first waits 400 ms, then rises from 4 px and
    // 0.97 with spring-fast; its neighbours within 300 ms show at once, keyboard focus shows one at once and
    // a click's focus none, a press or Escape hides it without moving focus, the pointer can move onto it,
    // it has no timer and leaves in dur-exit, and nothing uses `title`.
    function tooltips(root) {
      var lastHide = 0, timer = null;
      function show(el, now) {
        clearTimeout(timer);
        var tip = el.querySelector(":scope > .k-tip");
        if (!tip) return;
        tip.classList.toggle("instant", !!now);
        if (now) tip.classList.add("on");
        else timer = setTimeout(function () { tip.classList.add("on"); }, 400);
      }
      function hide(el) {
        clearTimeout(timer);
        var tip = el.querySelector(":scope > .k-tip");
        if (tip && tip.classList.contains("on")) lastHide = performance.now();
        if (tip) tip.classList.remove("on");
      }
      (root || document).querySelectorAll("[data-tip]").forEach(function (el) {
        if (!el.querySelector(":scope > .k-tip")) {
          var t = document.createElement("span");
          t.className = "k-tip text-sm";
          t.setAttribute("aria-hidden", "true");
          t.textContent = el.dataset.tip;
          el.append(t);
        }
        el.addEventListener("pointerenter", function (e) { if (e.pointerType !== "touch") show(el, performance.now() - lastHide < 300); });
        el.addEventListener("pointerleave", function () { hide(el); });
        el.addEventListener("focus", function () { if (el.matches(":focus-visible")) show(el, true); });
        el.addEventListener("blur", function () { hide(el); });
        el.addEventListener("click", function () { hide(el); });
        el.addEventListener("keydown", function (e) {
          var tip = el.querySelector(":scope > .k-tip");
          if (e.key === "Escape" && tip && tip.classList.contains("on")) { e.stopPropagation(); hide(el); }
        });
      });
    }
    // A segmented choice: the indicator slides with spring-fast, the arrows move the choice at once,
    // and each option is a radio. `onPick(value, keyboard, button)` runs on every change.
    function segment(box, onPick) {
      var ind = document.createElement("span");
      ind.className = "k-seg-ind";
      ind.setAttribute("aria-hidden", "true");
      box.prepend(ind);
      box.classList.add("has-ind");
      box.setAttribute("role", "radiogroup");
      var btns = Array.prototype.slice.call(box.querySelectorAll(":scope > button"));
      btns.forEach(function (b) { b.setAttribute("role", "radio"); });
      var current = btns.filter(function (b) { return b.getAttribute("aria-checked") === "true"; })[0] || btns[0];
      function place(b, moving) {
        var x = b.offsetLeft, y = b.offsetTop, w = b.offsetWidth, px = ind._x, py = ind._y, pw = ind._w;
        ind.style.transform = "translate(" + x + "px, " + y + "px)";
        ind.style.width = w + "px";
        ind.style.height = b.offsetHeight + "px";
        if (moving && px != null && (px !== x || py !== y)) {
          animate(ind, [{ transform: "translate(" + px + "px, " + py + "px)", width: pw + "px" }, { transform: "translate(" + x + "px, " + y + "px)", width: w + "px" }], { spring: "fast" });
        }
        ind._x = x; ind._y = y; ind._w = w;
      }
      function pick(b, keyboard, quiet) {
        current = b;
        btns.forEach(function (x) { x.setAttribute("aria-checked", String(x === b)); x.tabIndex = x === b ? 0 : -1; });
        place(b, !keyboard);
        if (!quiet && onPick) onPick(b.dataset.v, keyboard, b);
      }
      box.addEventListener("click", function (e) {
        var b = e.target.closest("button");
        if (!b || b.disabled || btns.indexOf(b) < 0 || b === current) return;
        pick(b, e.detail === 0);
      });
      box.addEventListener("keydown", function (e) {
        var k = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (!k) return;
        e.preventDefault();
        var live = btns.filter(function (b) { return !b.disabled; });
        var i = live.indexOf(current), next = live[(i + k + live.length) % live.length];
        if (next) { pick(next, true); next.focus(); }
      });
      btns.forEach(function (b) { b.tabIndex = b === current ? 0 : -1; });
      requestAnimationFrame(function () { place(current, false); });
      return {
        set: function (v) { var b = btns.filter(function (x) { return x.dataset.v === v; })[0]; if (b) pick(b, true, true); },
        refresh: function () { place(current, false); },
        get value() { return current.dataset.v; },
      };
    }
    // Sample agents for the previews. Kelpie keeps Master's default look (5.19, ADR-0049).
    var LOOKS = {
      kelpie: { shape: "mark", color: "kelp", eyes: "big", cheeks: false, head: { type: "ears", variation: "pointed" }, accessory: { type: "none" } },
      agenda: { shape: "pebble", color: "fawn", eyes: "dots", cheeks: true, head: { type: "ears", variation: "floppy" }, accessory: { type: "bow", variation: "tie" } },
      research: { shape: "bubble", color: "tide", eyes: "marbles", cheeks: false, head: { type: "hair", variation: "strands" }, accessory: { type: "glasses", variation: "round" } },
      code: { shape: "block", color: "slate", eyes: "cyclops", cheeks: false, head: { type: "horns", variation: "antennae" }, accessory: { type: "none" } },
      notes: { shape: "cloud", color: "anemone", eyes: "big", cheeks: true, head: { type: "leaves", variation: "kelp" }, accessory: { type: "hat", variation: "beanie" } },
    };
    // A task card shows the shape, the color and the eyes only (5.19).
    function bare(look) {
      return Object.assign({}, look, { cheeks: false, head: { type: "none" }, accessory: { type: "none" } });
    }
    // A pup: the same shape and head, a lighter color, dot eyes and no accessory (5.6).
    function pup(look) {
      return Object.assign({}, look, { color: "pup", eyes: "dots", cheeks: false, accessory: { type: "none" } });
    }
    function lighter(hex, t) {
      var n = parseInt(hex.trim().slice(1), 16);
      var ch = [n >> 16, (n >> 8) & 255, n & 255].map(function (v) { return Math.round(v + (255 - v) * t); });
      return "#" + ch.map(function (v) { return v.toString(16).padStart(2, "0"); }).join("");
    }
    // Puts a mascot in `host`. The pause follows reduced motion: Alive, or Still (5.19).
    function mascot(host, look, px, o) {
      o = o || {};
      var m = new engine.Mascot(host, { mascot: look, px: px, mode: o.mode || "header", quietable: !!o.quietable });
      if (o.state && o.state !== "idle") m.setState(o.state, { activity: o.activity || null, instant: true });
      // A header pup breathes and blinks, and nothing else (5.6): no gestures.
      if (o.calm) {
        m.nextGesture = Infinity;
        (function wink() {
          setTimeout(function () {
            if (!host.isConnected) return;
            if (!reduced()) m.blink();
            wink();
          }, 3000 + Math.random() * 3000);
        })();
      }
      return m;
    }
    function syncMotion() {
      engine.setMotion(reduced() ? "still" : "alive");
    }
    if (mq.addEventListener) mq.addEventListener("change", syncMotion);
    syncMotion();
    return {
      token: token, num: num, reduced: reduced, spring: spring, ease: ease, animate: animate,
      enter: enter, exit: exit, roll: roll, runner: runner, guard: guard, icon: icon, glyph: glyph,
      pauseIcon: pauseIcon, tooltips: tooltips, segment: segment, LOOKS: LOOKS, bare: bare, pup: pup, lighter: lighter, mascot: mascot, syncMotion: syncMotion,
    };
  })();
  window.Kelpie = { mascot: Object.assign({}, states, art, engine), ui: ui };
})();
