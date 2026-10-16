// How the webchat moves (docs/design-system.md §4). Springs are the design system's `linear()`
// easings, played with the Web Animations API, which the page's policy allows. Under reduced
// motion, from the system or the less-motion switch, movement becomes a fade of at most
// `--dur-fade` (rule 10). What the keyboard opens appears at once (§4.1).

import { SPRINGS } from "./mascot-states.js";

export { SPRINGS };

/** §4.3, in ms and as CSS easings. */
export const DUR = { press: 100, fade: 150, exit: 120, exitMoment: 170 };
export const EASE = {
  standard: "cubic-bezier(0.2, 0, 0, 1)",
  fade: "cubic-bezier(0, 0, 0.2, 1)",
  exit: "cubic-bezier(0.4, 0, 1, 1)",
};
export const RISE = 8;
export const SCALE_IN = 0.97;
/** A reply's text fades in this long after its bubble starts growing (5.1). */
export const REPLY_TEXT_DELAY = 70;

/** Whether motion is reduced: boot.js keeps `data-reduced` on <html>. */
export const reduced = () => document.documentElement.hasAttribute("data-reduced");

let viaKeyboard = false;
addEventListener("keydown", () => (viaKeyboard = true), true);
addEventListener("pointerdown", () => (viaKeyboard = false), true);

/** Whether the latest input was a key, so what it opens or moves appears at once. */
export const fromKeyboard = () => viaKeyboard;

/**
 * Plays an animation, or nothing where the browser can't or the tab is hidden: a paused timeline
 * would otherwise leave content at its first frame (§6).
 */
export function play(element, keyframes, options) {
  if (typeof element.animate !== "function" || document.hidden) return null;
  const animation = element.animate(keyframes, options);
  // A cancelled animation rejects its `finished`; whoever needs it handles that.
  animation.finished?.catch(() => {});
  return animation;
}

/** A fade in, the reduced-motion form of every entry. */
export function fadeIn(element, delay = 0) {
  return play(element, [{ opacity: 0 }, { opacity: 1 }], {
    duration: DUR.fade,
    easing: EASE.fade,
    delay,
    fill: "backwards",
  });
}

/**
 * An entry: rises and scales in with a spring, from `origin`, or fades under reduced motion. It
 * plays once, when the element first appears; a later update never replays it.
 */
export function enter(
  element,
  { spring = SPRINGS.base, rise = RISE, scale = SCALE_IN, origin } = {},
) {
  if (reduced()) return fadeIn(element);
  if (origin) element.style.transformOrigin = origin;
  return play(
    element,
    [
      { opacity: 0, transform: `translateY(${rise}px) scale(${scale})` },
      { opacity: 1, transform: "none" },
    ],
    { duration: spring.duration, easing: spring.easing },
  );
}

/** Leaves faster than it came (rule 9), then is removed. */
export async function leave(element, { moment = false } = {}) {
  const animation = play(element, [{ opacity: 1 }, { opacity: 0 }], {
    duration: moment ? DUR.exitMoment : DUR.exit,
    easing: EASE.exit,
    fill: "forwards",
  });
  try {
    await animation?.finished;
  } catch {
    // Cancelled: it leaves at once.
  }
  element.remove();
}

/**
 * An element that changes size in place, as a reply does when it takes the typing bubble's place
 * (5.1, one of the contained sizes §4.4 allows): from `before` to its size now.
 */
export function resize(element, before, spring = SPRINGS.base) {
  if (reduced() || !before) return null;
  const after = element.getBoundingClientRect();
  if (after.width === before.width && after.height === before.height) return null;
  return play(
    element,
    [
      { width: `${before.width}px`, height: `${before.height}px` },
      { width: `${after.width}px`, height: `${after.height}px` },
    ],
    { duration: spring.duration, easing: spring.easing },
  );
}

/** Hides an element after its exit, unless it was shown again meanwhile. */
export function hideAfterExit(element) {
  if (element.hidden) return;
  element.dataset.leaving = "";
  const done = () => {
    if (element.dataset.leaving === undefined) return;
    delete element.dataset.leaving;
    element.hidden = true;
  };
  const animation = play(element, [{ opacity: 1 }, { opacity: 0 }], {
    duration: DUR.exit,
    easing: EASE.exit,
  });
  if (animation) animation.finished.then(done, done);
  else done();
}

/** Where a spring's `linear()` easing is at `t`, from 0 to 1. */
export function springAt(spring, t) {
  const points = spring.easing.match(/-?\d+(?:\.\d+)?/g).map(Number);
  const x = Math.min(1, Math.max(0, t)) * (points.length - 1);
  const index = Math.floor(x);
  if (index >= points.length - 1) return points.at(-1);
  return points[index] + (points[index + 1] - points[index]) * (x - index);
}

/** Scrolls to the end with `--spring-base`, or jumps there under reduced motion (5.10). */
export function scrollToEnd(scroller, spring = SPRINGS.base) {
  const from = scroller.scrollTop;
  const to = scroller.scrollHeight - scroller.clientHeight;
  if (reduced() || to <= from || document.hidden) {
    scroller.scrollTop = scroller.scrollHeight;
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const t = (now - start) / spring.duration;
    scroller.scrollTop = from + (to - from) * springAt(spring, t);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
