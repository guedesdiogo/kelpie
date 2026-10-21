// The agent's mascot as its Telegram bot's profile photo (ADR-0046). channel-egress has Browser Run
// open a blank page with the webchat's own engine and this module, which draws the still the bot
// shows and records the loop Telegram plays. The webchat never loads it.
//
// The engine moves the mascot with timers, the Web Animations API and a few CSS transitions, in
// real time. Here a virtual clock moves them frame by frame instead, and each frame is the SVG as
// it stands then, drawn to a canvas: every frame is exact, however long one takes to draw. The
// frames then play in real time into a MediaRecorder, the only H.264 encoder Browser Run's page
// has: it isn't a secure context, so WebCodecs is missing.

import { FRAME } from "./mascot-art.js";

/** The photo's side: Telegram recommends 800 px for a profile video. */
export const PHOTO_PX = 800;
/**
 * The figure's frame (ADR-0063), drawn at 5.6 px a grid unit, the scale the photo has had since
 * ADR-0046. Telegram crops a circle: what a figure shows within the old 100-unit frame, hands
 * included, stays inside it once the figure is centered.
 */
export const FIGURE_PX = Math.round(5.6 * FRAME.size);
/**
 * The loop: one idle breath (mascot-states.js `BREATH.idle`), so it joins up when Telegram plays it
 * again, with a blink, a wave and a blink. Each step is a time, a gesture and its arguments.
 */
export const LOOP = {
  ms: 3600,
  fps: 30,
  steps: [
    [700, "blink"],
    [1300, "wave", "r", 2],
    [3000, "blink"],
  ],
};
const VIDEO_TYPE = "video/mp4;codecs=avc1";
const VIDEO_BITS_PER_SECOND = 2_500_000;
const JPEG_QUALITY = 0.92;
/** A pixel at least this opaque counts as the figure's, its shadow included. */
const ALPHA_SHOWN = 24;
/** How long the fur may take to paint before the photo goes with the flat body. */
const FUR_WAIT_MS = 20_000;

/**
 * A clock that moves only when told to. Started, it stands in for `setTimeout`, `clearTimeout` and
 * `performance.now` on `win`, and holds each new animation at its start; `advance` then runs the
 * timers due and sets every animation to its time. `stop` gives `win` back its own.
 */
export function virtualClock(win) {
  const real = {
    setTimeout: win.setTimeout,
    clearTimeout: win.clearTimeout,
    now: win.performance.now,
    animate: win.Element.prototype.animate,
  };
  const timers = new Map();
  const animations = new Map();
  let base = 0;
  let now = 0;
  let ids = 0;

  /**
   * Sets each animation to the clock, and finishes the ones past their end, as time would. A CSS
   * transition starts on its own when a style changes: the clock holds it from then on.
   */
  function seek() {
    for (const animation of win.document.getAnimations()) {
      if (animations.has(animation) || animation.playState !== "running") continue;
      animation.pause();
      animations.set(animation, now);
    }
    for (const [animation, start] of animations) {
      if (animation.playState === "idle") {
        animations.delete(animation);
        continue;
      }
      const t = now - start;
      if (t >= animation.effect.getComputedTiming().endTime) {
        animation.finish();
        animations.delete(animation);
      } else {
        animation.currentTime = t;
      }
    }
  }

  /** Two turns of the microtask queue, for what an animation's `finished` starts. */
  const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  return {
    get now() {
      return now;
    },
    start() {
      base = real.now.call(win.performance);
      now = 0;
      win.setTimeout = (run, ms = 0, ...args) => {
        const id = `clock-${++ids}`;
        timers.set(id, { at: now + Math.max(0, Number(ms) || 0), run: () => run(...args) });
        return id;
      };
      win.clearTimeout = (id) => {
        if (!timers.delete(id)) real.clearTimeout.call(win, id);
      };
      win.performance.now = () => base + now;
      win.Element.prototype.animate = function (...args) {
        const animation = real.animate.apply(this, args);
        animation.pause();
        animations.set(animation, now);
        return animation;
      };
    },
    /** Runs every timer due by `to`, in order, then sets the animations to `to`. */
    async advance(to) {
      for (;;) {
        let due = null;
        for (const [id, timer] of timers) {
          if (timer.at <= to && (!due || timer.at < due.at)) due = { id, ...timer };
        }
        if (!due) break;
        now = due.at;
        timers.delete(due.id);
        seek();
        due.run();
        seek();
        await settle();
      }
      now = to;
      seek();
      await settle();
      seek();
    },
    stop() {
      win.setTimeout = real.setTimeout;
      win.clearTimeout = real.clearTimeout;
      win.performance.now = real.now;
      win.Element.prototype.animate = real.animate;
    },
  };
}

/**
 * Draws `mascot` with `engine` (mascot.js) in `host`: the still, a JPG, and the loop, an MP4, or
 * null when this browser can't record one. `css` is mascot.css, and `background` fills the square.
 */
export async function drawPhoto({ engine, host, mascot, css, background }) {
  engine.setMotion("alive");
  const figure = new engine.Mascot(host, { mascot, px: FIGURE_PX, mode: "large", state: "idle" });
  figure.nextGesture = Number.POSITIVE_INFINITY;
  await furPainted(host);
  // The first frame of the page, when the mascot starts to breathe on its own, goes by first.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  for (const animation of document.getAnimations()) animation.cancel();

  const frame = await framer(host, css, background);
  const clock = virtualClock(window);
  const count = Math.round((LOOP.ms / 1000) * LOOP.fps);
  const frames = [];
  clock.start();
  try {
    figure.lastEvent = performance.now();
    figure.breathe();
    for (const [at, gesture, ...args] of LOOP.steps) setTimeout(() => figure[gesture](...args), at);
    for (let i = 0; i < count; i++) {
      await clock.advance((i * 1000) / LOOP.fps);
      frames.push(await frame());
    }
  } catch (error) {
    // Without its first frame there is no photo; without a later one, the still goes alone.
    if (frames.length === 0) throw error;
  } finally {
    clock.stop();
  }
  let loop = null;
  if (frames.length === count) loop = await record(frames).catch(() => null);
  return { still: frames[0], loop };
}

/** Waits for every piece's fur, or `FUR_WAIT_MS`: a piece that isn't there keeps its flat body. */
async function furPainted(host) {
  const pieces = host.querySelectorAll(".fp").length;
  const until = performance.now() + FUR_WAIT_MS;
  while (performance.now() < until) {
    const painted = [...host.querySelectorAll(".fp .fpi")].filter((image) =>
      image.getAttribute("href"),
    ).length;
    if (painted >= pieces) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * What draws one frame: the mascot's SVG as it stands, with each animated element's transform and
 * opacity written in, the parts not shown left out, and its fur, styles and gradients carried
 * along, as an image on `background`. A JPG of the square. The figure at rest, shadow included, is
 * centered: the SVG's box leaves room above it for what the webchat shows there.
 */
async function framer(host, css, background) {
  const svg = host.querySelector("svg");
  const furs = new Map();
  for (const image of svg.querySelectorAll(".fpi")) {
    const href = image.getAttribute("href");
    if (href?.startsWith("blob:") && !furs.has(href)) furs.set(href, await dataUrl(href));
  }
  const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
  // The photo is the light theme: the figure's colors are the same in both.
  style.textContent = css.replace(/@media \(prefers-color-scheme: dark\) \{[\s\S]*?\n\}\n/g, "");
  const defs = [...document.querySelectorAll(".mascot-defs defs")];

  /** The SVG as it stands now, as an image. */
  const image = async () => {
    const copy = svg.cloneNode(true);
    const from = svg.querySelectorAll("*");
    const to = copy.querySelectorAll("*");
    for (let i = from.length - 1; i >= 0; i--) {
      const computed = getComputedStyle(from[i]);
      if (computed.display === "none" || computed.visibility === "hidden") {
        to[i].remove();
        continue;
      }
      if (from[i].getAnimations().length === 0) continue;
      to[i].style.transform = computed.transform;
      to[i].style.opacity = computed.opacity;
    }
    for (const fur of copy.querySelectorAll(".fpi")) {
      const href = furs.get(fur.getAttribute("href"));
      if (href) fur.setAttribute("href", href);
    }
    copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    copy.setAttribute("width", String(FIGURE_PX));
    copy.setAttribute("height", String(FIGURE_PX));
    for (const node of defs) copy.prepend(node.cloneNode(true));
    copy.prepend(style.cloneNode(true));
    const link = URL.createObjectURL(
      new Blob([new XMLSerializer().serializeToString(copy)], { type: "image/svg+xml" }),
    );
    try {
      const drawn = new Image();
      drawn.src = link;
      await drawn.decode();
      return drawn;
    } finally {
      URL.revokeObjectURL(link);
    }
  };

  const canvas = document.createElement("canvas");
  canvas.width = PHOTO_PX;
  canvas.height = PHOTO_PX;
  const g = canvas.getContext("2d", { willReadFrequently: true });
  g.drawImage(await image(), 0, 0, FIGURE_PX, FIGURE_PX);
  const [x, y] = centered(g.getImageData(0, 0, FIGURE_PX, FIGURE_PX));

  return async () => {
    const drawn = await image();
    g.fillStyle = background;
    g.fillRect(0, 0, PHOTO_PX, PHOTO_PX);
    g.drawImage(drawn, x, y, FIGURE_PX, FIGURE_PX);
    return new Promise((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("frame"))),
        "image/jpeg",
        JPEG_QUALITY,
      ),
    );
  };
}

/**
 * Where to draw the figure's box so what it shows sits in the middle of the photo: the bounds of
 * its pixels that aren't transparent, the faint fur tips and the shadow included. An empty box
 * stays where it is, in the middle.
 */
export function centered({ data, width, height }) {
  let [left, top, right, bottom] = [width, height, -1, -1];
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      if (data[(row * width + column) * 4 + 3] < ALPHA_SHOWN) continue;
      left = Math.min(left, column);
      right = Math.max(right, column);
      top = Math.min(top, row);
      bottom = Math.max(bottom, row);
    }
  }
  const middle = PHOTO_PX / 2;
  if (right < 0) return [middle - width / 2, middle - height / 2];
  return [Math.round(middle - (left + right + 1) / 2), Math.round(middle - (top + bottom + 1) / 2)];
}

/**
 * Plays the frames in real time into a MediaRecorder, as an H.264 MP4. Null when this browser
 * can't record that. A few frames are decoded ahead, so none is late, and each is let go once
 * drawn or skipped.
 */
async function record(frames) {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported(VIDEO_TYPE)) {
    return null;
  }
  const canvas = document.createElement("canvas");
  canvas.width = PHOTO_PX;
  canvas.height = PHOTO_PX;
  const g = canvas.getContext("2d");
  const decoded = frames.map(() => null);
  const bitmap = (i) => {
    decoded[i] ??= createImageBitmap(frames[i]);
    return decoded[i];
  };
  const release = (i) => {
    decoded[i]?.then(
      (image) => image.close(),
      () => {},
    );
    decoded[i] = null;
  };
  const show = async (i) => {
    for (let ahead = i + 1; ahead < Math.min(frames.length, i + 6); ahead++) bitmap(ahead);
    g.drawImage(await bitmap(i), 0, 0);
    release(i);
  };
  await show(0);
  const recorder = new MediaRecorder(canvas.captureStream(LOOP.fps), {
    mimeType: VIDEO_TYPE,
    videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
  });
  const parts = [];
  recorder.ondataavailable = (event) => parts.push(event.data);
  const stopped = new Promise((resolve) => {
    recorder.onstop = resolve;
  });
  recorder.start();
  const started = performance.now();
  let shown = 0;
  for (;;) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const due = Math.floor(((performance.now() - started) / 1000) * LOOP.fps);
    if (due >= frames.length) break;
    if (due <= shown) continue;
    for (let skipped = shown + 1; skipped < due; skipped++) release(skipped);
    shown = due;
    await show(shown);
  }
  recorder.stop();
  await stopped;
  for (let i = shown + 1; i < frames.length; i++) release(i);
  return new Blob(parts, { type: "video/mp4" });
}

/** A blob URL's contents as a data URL, which an SVG drawn as an image can load. */
async function dataUrl(href) {
  const blob = await (await fetch(href)).blob();
  return toDataUrl(blob);
}

const toDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

/** A blob as base64, for the page's answer. */
export async function toBase64(blob) {
  return (await toDataUrl(blob)).split(",")[1] ?? "";
}
