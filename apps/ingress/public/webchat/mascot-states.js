// The mascot's states, poses and scheduling (ADR-0045 §6): plain data and pure functions, so they
// run the same in the browser and in tests. mascot.js draws and moves the figure from them.

/** The pause setting (ADR-0045 §6, WCAG 2.2.2): Alive is the default. */
export const MOTIONS = ["alive", "states", "still"];

/** Reduced motion means Still: the setting can't pick Alive or States only then. */
export function effectiveMotion(chosen, reduced) {
  if (reduced) return "still";
  return MOTIONS.includes(chosen) ? chosen : "alive";
}

/** An idle mascot dozes after this long without an event for its agent. */
export const SLEEP_MS = 45_000;
/** "States only" keeps the announcements, and each ends within this long. */
export const ANNOUNCEMENT_MS = 5_000;
/** The approval's pose lasts this long, then the mascot goes back to work (ADR-0045 §6). */
export const APPROVED_MS = 1_100;
/** A confirmation's notice waits for the owner's press until it expires (ADR-0026 §3). */
export const CONFIRMATION_MS = 10 * 60_000;

/**
 * The design system's springs (`docs/design-system.md` §4.2), as WAAPI takes them. A state change
 * uses the moment springs; the repertoire's gestures use the frequent ones.
 */
export const SPRINGS = {
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
export const MOMENTS = new Set(["waiting", "approved", "error"]);

/**
 * What stays on screen in each state, and what reduced motion keeps: where the eyes look, the
 * body's tilt and squash, the eyes' scale and shape, the brows, the mouth, an effect and the
 * bubble beside the head.
 */
export const POSES = {
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
export const WORKING_STATES = new Set(["working", "noResponse"]);
/** The states whose mittens hold something: the task's object, or offline's plug. */
export const HOLDING_STATES = new Set([...WORKING_STATES, "offline"]);

/**
 * The mittens each state keeps, by side; reduced motion keeps them too, so the state still reads.
 * At work, the task's object brings its own mittens (ADR-0045 §10).
 */
export const HAND_POSES = {
  listening: { r: "ear" },
  typing: { l: "typeL", r: "typeR" },
  approved: { l: "thumbL", r: "thumbR" },
  error: { l: "cheekL", r: "cheekR" },
  dozing: { r: "pillowR" },
};

/** What the mittens hold for each activity, and where the eyes look at it. */
export const ACTIVITIES = {
  search: { gaze: [2, 4] },
  vault: { gaze: [2, 4.5] },
  code: { gaze: [2, 4] },
  calendar: { gaze: [2, 4.5] },
  email: { gaze: [3, 3.5] },
  think: { gaze: [0, -3] },
  plug: { gaze: [3, 3.5] },
};

/** A tool's activity, or thinking for a tool without its own object (ADR-0045 §10). */
export function activityOf(value) {
  // The plug is Offline's object, never a tool's.
  return value !== "plug" && Object.hasOwn(ACTIVITIES, value) ? value : "think";
}

/** Breathing in "Alive": its period and depth per state. */
export const BREATH = {
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
export const REPERTOIRES = {
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
export function available(state, mode, figure) {
  return (REPERTOIRES[state] ?? []).filter(
    (option) => (mode !== "list" || option.list) && (!option.need || option.need(figure)),
  );
}

/**
 * Draws a gesture by weight, never one of the last two. With only two to draw from, it never
 * repeats the last one; with one, it plays that one.
 */
export function draw(options, recent, random = Math.random) {
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
export function remember(recent, name) {
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

export function gapAfter(state, mode, random = Math.random) {
  const [low, high] = GAPS[state] ?? GAPS.idle;
  // The roster's rows gesture every 7 to 16 s instead of every 4 to 9 s (ADR-0045 §4).
  const scale = mode === "list" ? 2.2 : mode === "large" ? 0.85 : 1;
  return (low + random() * (high - low)) * scale;
}

/** One gesture at a time across a roster: the next row waits this long. */
export const LIST_LOCK_MS = 2_500;
/** While the owner types, the conversation's mascot only breathes and blinks this often. */
export const QUIET_BLINK_MS = 1_500;

/**
 * What the shared timer does for one mascot at `now` (ADR-0045 §6): nothing in a hidden tab, off
 * screen, or under any setting but Alive; doze an idle mascot after 45 s without an event; blink
 * only while the owner types; else draw a gesture when its rest is over, one roster row at a time.
 */
export function due(mascot, world) {
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
export function breathes(mascot, world) {
  return world.motion === "alive" && mascot.mode !== "still" && mascot.visible && !world.hidden;
}

/**
 * An animation's timing as the setting lets it play: unchanged in "Alive"; in "States only",
 * an announcement cut to the iterations that end within 5 s, or null when none does; null in
 * "Still".
 */
export function allowed(timing, motion) {
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
export function presenceAfter(presence, event) {
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

export const IDLE = idle();

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
export function presenceKeeper(
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
