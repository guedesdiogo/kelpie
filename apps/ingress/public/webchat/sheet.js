// A phone's sheet (docs/design-system.md 5.15): it stops at 40% and 90% of the height, follows the
// finger, and closes on a flick down. Dragging starts only when its content is at its top. The
// sheet is 90% tall; at its 40% stop it stands lower by the difference.

import { play, reduced, SPRINGS } from "./motion.js";

/** The stops, as parts of the window's height. */
export const STOPS = [0.4, 0.9];
/** A release faster than this, in px per ms, is a flick. */
export const FLICK = 0.5;

export function sheet(
  panel,
  { onClose, height = () => innerHeight, now = () => performance.now() },
) {
  let stop = STOPS[0];
  let drag = null;
  const offsetAt = (at) => (STOPS[1] - at) * height();
  const setOffset = (offset) => {
    panel.style.transform = offset > 0 ? `translateY(${offset}px)` : "";
  };

  function settle(to, from) {
    stop = to;
    const offset = offsetAt(to);
    setOffset(offset);
    if (reduced() || from === undefined) return;
    play(
      panel,
      [{ transform: `translateY(${from}px)` }, { transform: `translateY(${offset}px)` }],
      SPRINGS.slow,
    );
  }

  panel.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button > 0) return;
    const list = panel.querySelector("ul");
    // The list scrolls first: the sheet moves only once it is at its top.
    if (list && list.scrollTop > 0 && !event.target.closest(".handle")) return;
    drag = {
      y: event.clientY,
      at: now(),
      from: offsetAt(stop),
      offset: offsetAt(stop),
      moved: false,
    };
    panel.setPointerCapture?.(event.pointerId);
  });
  panel.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.abs(dy) < 6) return;
    drag.moved = true;
    drag.offset = Math.max(0, drag.from + dy);
    setOffset(drag.offset);
  });
  const release = (event) => {
    if (!drag) return;
    const { moved, offset, from, y, at } = drag;
    drag = null;
    if (!moved) return;
    // A drag isn't a press on the row under the finger.
    panel.addEventListener("click", (click) => click.preventDefault(), {
      once: true,
      capture: true,
    });
    const speed = (event.clientY - y) / Math.max(1, now() - at);
    if (speed > FLICK || offset > offsetAt(STOPS[0]) + height() * 0.15) {
      onClose();
      return;
    }
    if (speed < -FLICK) {
      settle(STOPS[1], offset);
      return;
    }
    const nearest = STOPS.reduce((best, each) =>
      Math.abs(offsetAt(each) - offset) < Math.abs(offsetAt(best) - offset) ? each : best,
    );
    settle(nearest, offset ?? from);
  };
  panel.addEventListener("pointerup", release);
  panel.addEventListener("pointercancel", release);

  return {
    /** Opens at the lower stop. */
    reset: () => settle(STOPS[0]),
    get stop() {
      return stop;
    },
  };
}
