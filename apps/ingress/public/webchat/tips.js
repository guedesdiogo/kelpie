// Icon buttons say their name in a tooltip (the research on #378 and #379): the first waits
// 400 ms, a neighbour within 300 ms shows at once and unanimated, the keyboard's focus shows one at
// once, and Escape hides it without moving focus. A click's focus shows none. The tip is for the
// eye: the button's `aria-label` names it, and nothing uses `title` (WCAG 1.4.13).

import { DUR, EASE, fromKeyboard, play, reduced, SPRINGS } from "./motion.js";

/** The first tooltip waits this long. */
export const FIRST_TIP_MS = 400;
/** Within this long of one hiding, the next shows at once. */
export const PEER_TIP_MS = 300;

/** The button whose tip shows, and when the latest one hid. */
let shownOn = null;
let hiddenAt = Number.NEGATIVE_INFINITY;
const timers = new WeakMap();

const tipOf = (button) => button.querySelector(":scope > .tip");

function show(button, { instant }) {
  clearTimeout(timers.get(button));
  if (shownOn && shownOn !== button) hide(shownOn, { quiet: true });
  shownOn = button;
  const tip = tipOf(button);
  if (!tip || tip.dataset.shown !== undefined) return;
  tip.dataset.shown = "";
  if (instant || reduced()) return;
  play(
    tip,
    [
      { opacity: 0, transform: "translateY(4px) scale(0.97)" },
      { opacity: 1, transform: "none" },
    ],
    SPRINGS.fast,
  );
}

function hide(button, { quiet = false } = {}) {
  clearTimeout(timers.get(button));
  const tip = tipOf(button);
  if (shownOn === button) shownOn = null;
  if (!tip || tip.dataset.shown === undefined) return;
  delete tip.dataset.shown;
  hiddenAt = Date.now();
  if (quiet || reduced()) return;
  play(tip, [{ opacity: 1 }, { opacity: 0 }], { duration: DUR.exit, easing: EASE.exit });
}

/** Gives every `[data-tip]` button under `root` its tooltip, from its label; again to update. */
export function tips(root) {
  for (const button of root.querySelectorAll("[data-tip]")) {
    let tip = tipOf(button);
    if (!tip) {
      tip = document.createElement("span");
      tip.className = "tip";
      tip.setAttribute("aria-hidden", "true");
      button.append(tip);
    }
    // A tip may say more than the name: an empty Send says why it waits.
    tip.textContent = button.dataset.tip || (button.getAttribute("aria-label") ?? "");
    // Its shortcut, in Geist Mono inside the tip: "Edit ⌘E" (#381).
    if (button.dataset.kbd) {
      const kbd = document.createElement("kbd");
      kbd.textContent = button.dataset.kbd;
      tip.append(kbd);
    }
    if (timers.has(button)) continue;
    timers.set(button, null);
    button.addEventListener("pointerenter", () => {
      if (shownOn || Date.now() - hiddenAt <= PEER_TIP_MS) {
        show(button, { instant: true });
        return;
      }
      timers.set(
        button,
        setTimeout(() => show(button, { instant: false }), FIRST_TIP_MS),
      );
    });
    button.addEventListener("pointerleave", () => hide(button));
    button.addEventListener("focus", () => {
      if (fromKeyboard()) show(button, { instant: true });
    });
    button.addEventListener("blur", () => hide(button, { quiet: true }));
    button.addEventListener("click", () => hide(button, { quiet: true }));
    button.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && tipOf(button)?.dataset.shown !== undefined) {
        event.stopPropagation();
        hide(button, { quiet: true });
      }
    });
  }
}
