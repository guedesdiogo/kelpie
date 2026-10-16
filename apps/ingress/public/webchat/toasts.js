// Toasts (docs/design-system.md §5.13): only for what finished out of sight. They sit at the
// bottom center, at most three stacked, and a polite live region announces each one. A toast
// stays 5 s, an error until it is dismissed; the timer pauses on hover, on focus and while the
// tab is hidden, and a thin bar shows the time left.

import { enter, leave, play, reduced } from "./motion.js";

export const TOAST_MS = 5_000;
const MOST = 3;

const defaultTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (timer) => clearTimeout(timer),
};

export class Toasts {
  #region;
  #texts;
  #timers;
  #now;
  #shown = [];

  constructor(region, { texts, timers = defaultTimers, now = Date.now }) {
    this.#region = region;
    this.#texts = texts;
    this.#timers = timers;
    this.#now = now;
    document.addEventListener("visibilitychange", () => {
      for (const toast of this.#shown) this.#hold(toast, "hidden", document.hidden);
    });
  }

  /** A toast with `text`; `action` is a `{ label, run }` button; an error stays until dismissed. */
  show({ text, error = false, action = null }) {
    const element = document.createElement("div");
    element.className = "toast";
    if (error) element.dataset.error = "";
    const words = document.createElement("p");
    words.textContent = text;
    element.append(words);
    const toast = { element, error, left: TOAST_MS, holds: new Set(), timer: null, bar: null };
    if (action) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = action.label;
      button.addEventListener("click", () => {
        action.run();
        this.dismiss(toast);
      });
      element.append(button);
    }
    if (error) {
      const dismiss = document.createElement("button");
      dismiss.type = "button";
      dismiss.textContent = this.#texts.dismiss;
      dismiss.addEventListener("click", () => this.dismiss(toast));
      element.append(dismiss);
    } else {
      toast.bar = document.createElement("span");
      toast.bar.className = "left";
      toast.bar.setAttribute("aria-hidden", "true");
      element.append(toast.bar);
    }
    element.addEventListener("pointerenter", () => this.#hold(toast, "pointer", true));
    element.addEventListener("pointerleave", () => this.#hold(toast, "pointer", false));
    element.addEventListener("focusin", () => this.#hold(toast, "focus", true));
    element.addEventListener("focusout", () => this.#hold(toast, "focus", false));
    this.#region.append(element);
    this.#shown.unshift(toast);
    while (this.#shown.length > MOST) this.dismiss(this.#shown.at(-1));
    this.#stack();
    enter(element);
    if (document.hidden) toast.holds.add("hidden");
    this.#run(toast);
    return toast;
  }

  dismiss(toast) {
    const index = this.#shown.indexOf(toast);
    if (index === -1) return;
    this.#shown.splice(index, 1);
    this.#timers.clear(toast.timer);
    this.#stack();
    leave(toast.element);
  }

  /** Each lower toast is scaled by 1 − 0.05 per step; reduced motion keeps no offset. */
  #stack() {
    this.#shown.forEach((toast, step) => {
      toast.element.style.zIndex = String(MOST - step);
      toast.element.style.transform =
        step === 0 || reduced() ? "" : `translateY(${-6 * step}px) scale(${1 - 0.05 * step})`;
    });
  }

  #run(toast) {
    if (toast.error || toast.holds.size > 0) return;
    toast.startedAt = this.#now();
    toast.timer = this.#timers.set(() => this.dismiss(toast), toast.left);
    toast.animation = play(
      toast.bar,
      [{ transform: `scaleX(${toast.left / TOAST_MS})` }, { transform: "scaleX(0)" }],
      { duration: toast.left, easing: "linear", fill: "forwards" },
    );
  }

  #hold(toast, reason, on) {
    if (toast.error) return;
    const held = toast.holds.size > 0;
    if (on) toast.holds.add(reason);
    else toast.holds.delete(reason);
    if (!held && toast.holds.size > 0) {
      this.#timers.clear(toast.timer);
      toast.left = Math.max(0, toast.left - (this.#now() - toast.startedAt));
      toast.animation?.pause();
    } else if (held && toast.holds.size === 0) {
      this.#run(toast);
    }
  }
}
