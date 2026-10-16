// The agent's mascot (ADR-0045): a plush figure that stays alive in place. mascot-art.js builds
// its SVG and mascot-states.js says what each state shows and when it may move; this module
// paints the fur, plays the poses and gestures with the Web Animations API, and runs the one
// timer every mascot shares. No library, and nothing per frame repaints the fur.

import { buildMascot, handSpot, SHARED_DEFS } from "./mascot-art.js";
import {
  ACTIVITIES,
  allowed,
  available,
  BREATH,
  breathes,
  draw,
  due,
  gapAfter,
  HAND_POSES,
  LIST_LOCK_MS,
  POSES,
  QUIET_BLINK_MS,
  remember,
  SPRINGS,
  WORKING_STATES,
} from "./mascot-states.js";

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
  element.animate([{ transform: from }, { transform }], {
    duration: spring.duration,
    easing: spring.easing,
  });
}

/** The page's motion setting, after reduced motion (mascot-states.js `effectiveMotion`). */
export function setMotion(motion) {
  if (world.motion === motion) return;
  world.motion = motion;
  for (const mascot of live) mascot.settle();
}

/** The owner is typing: the conversation's mascot only breathes and blinks for a moment. */
export function ownerTyping() {
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
export const furTiming = { started: 0, pieces: 0, ms: 0 };

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

export class Mascot {
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
      work: this.mode !== "still" || WORKING_STATES.has(this.state),
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
    this.shownActivity = null;
    this.applyPose(this.pose(), null);
    const k = (this.px / 100) * Math.min(2, window.devicePixelRatio || 1) * 1.2;
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
    if (WORKING_STATES.has(this.state)) this.showActivity(false);
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
    if (WORKING_STATES.has(this.state)) this.showActivity(false);
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
    return element.animate(keyframes, { ...fits, delay });
  }

  pose() {
    return this.override ? { ...POSES[this.state], ...this.override } : POSES[this.state];
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
    poseTo(this.poseG, `rotate(${pose.tilt}deg) scale(${pose.sx}, ${pose.sy})`, spring);
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
    const [period, depth0] = BREATH[this.state] ?? BREATH.idle;
    const depth = this.mode === "list" ? depth0 * 0.6 : depth0;
    this.breath = this.breathG.animate(
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
      this.bob = this.badgeBob.animate(
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
    this.svg.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 150, easing: "ease-out" });
  }

  /**
   * Shows a state: its pose, then its announcement. `activity` is the task's object at work;
   * `auto` marks a change the mascot made itself, such as dozing off, which is no event.
   */
  setState(next, { activity = null, auto = false, instant = false } = {}) {
    const previous = this.state;
    if (next === previous && activity === this.activity) return;
    if (WORKING_STATES.has(previous)) this.stopWork();
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
      if (WORKING_STATES.has(next)) this.showActivity(false);
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
      this.play(this.squash, [{ transform: "scale(.96, 1.06)" }, { transform: "none" }], {
        ...SPRINGS.pop,
        from: false,
      });
    }
    this.announce(next);
  }

  announce(state) {
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
    if (!WORKING_STATES.has(this.state)) return;
    const next = this.activity ?? "think";
    const swap = () => {
      if (!WORKING_STATES.has(this.state)) return;
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
    this.play(
      this.squash,
      [
        { transform: "none" },
        { transform: "scale(.95, 1.09)", offset: 0.35, easing: "ease-out" },
        { transform: "scale(.95, 1.09)", offset: 0.6 },
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
    this.play(
      this.squash,
      [
        { transform: "none" },
        { transform: "scale(.97, 1.06)", offset: 0.35 },
        { transform: "scale(.97, 1.06)", offset: 0.7 },
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

  hop(height, moment = false) {
    if (world.motion === "still") return;
    const h = height ?? (this.mode === "large" ? 9 : 7);
    this.lastHop = now();
    const duration = moment ? 500 : 440;
    this.play(
      this.hopG,
      [
        { transform: "none" },
        { transform: "none", offset: 0.2, easing: "cubic-bezier(.2,.7,.4,1)" },
        { transform: `translate(0px, ${-h}px)`, offset: 0.52, easing: "cubic-bezier(.6,0,.8,.4)" },
        { transform: "none", offset: 0.84 },
        { transform: "none" },
      ],
      { duration, easing: "linear" },
    );
    this.play(
      this.shadow,
      [
        { transform: "none", opacity: 1 },
        { transform: "none", opacity: 1, offset: 0.2 },
        { transform: "scale(.7, .7)", opacity: 0.45, offset: 0.52 },
        { transform: "none", opacity: 1, offset: 0.84 },
        { transform: "none", opacity: 1 },
      ],
      { duration, easing: "linear", from: false },
    );
    const squash = this.play(
      this.squash,
      [
        { transform: "none" },
        { transform: "scale(1.08, .9)", offset: 0.2 },
        { transform: "scale(.95, 1.07)", offset: 0.4 },
        { transform: "none", offset: 0.66 },
        { transform: "scale(1.08, .9)", offset: 0.86 },
        { transform: "scale(1.08, .9)" },
      ],
      { duration, easing: "ease-in-out", fill: "forwards" },
    );
    squash?.finished.then(
      () =>
        this.play(this.squash, [{ transform: "scale(1.08, .9)" }, { transform: "none" }], {
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
    this.hop(9, true);
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
