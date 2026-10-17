// A label that changes rolls (5.2): the old words leave upward and the new ones rise.

import { DUR, EASE, fadeIn, play, reduced, SPRINGS } from "./motion.js";

export function rollText(text) {
  const span = document.createElement("span");
  span.className = "roll";
  span.textContent = text;
  return span;
}

/** A label that changes rolls: the old one leaves upward, the new one rises (5.2). */
export function roll(container, text) {
  const old = container.querySelector(":scope > .roll:last-child");
  if (old?.textContent === text) return;
  const next = rollText(text);
  container.append(next);
  if (!old) return;
  if (reduced()) {
    old.remove();
    fadeIn(next);
    return;
  }
  old.classList.add("leaving");
  const leaving = play(
    old,
    [
      { opacity: 1, transform: "translateY(0)" },
      { opacity: 0, transform: "translateY(-75%)" },
    ],
    { duration: DUR.exit, easing: EASE.exit, fill: "forwards" },
  );
  if (leaving)
    leaving.finished.then(
      () => old.remove(),
      () => old.remove(),
    );
  else old.remove();
  play(
    next,
    [
      { opacity: 0, transform: "translateY(75%)" },
      { opacity: 1, transform: "none" },
    ],
    SPRINGS.fast,
  );
}
