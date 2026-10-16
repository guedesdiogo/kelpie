import { beforeEach, describe, expect, it, vi } from "vitest";
import { sheet } from "../../public/webchat/sheet.js";

// A phone's sheet (5.15): it stops at 40% and 90%, follows the finger, closes on a flick down, and
// moves only once its list is at its top.

const HEIGHT = 1_000;
let panel;
let list;
let clock;
let closed;
let control;

const pointer = (type, y, target = panel) =>
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, clientY: y, pointerType: "touch" }));

/** A drag from `from` to `to` over `ms`. */
function drag(from, to, ms) {
  pointer("pointerdown", from);
  clock += ms / 2;
  pointer("pointermove", (from + to) / 2);
  clock += ms / 2;
  pointer("pointermove", to);
  pointer("pointerup", to);
}

beforeEach(() => {
  document.body.innerHTML =
    '<nav class="switcher"><span class="handle"></span><ul><li><a href="?agent=a">A</a></li></ul></nav>';
  panel = document.querySelector("nav");
  list = panel.querySelector("ul");
  clock = 0;
  closed = vi.fn();
  control = sheet(panel, { onClose: closed, height: () => HEIGHT, now: () => clock });
  control.reset();
});

describe("a phone's sheet", () => {
  it("opens at its 40% stop", () => {
    expect(control.stop).toBe(0.4);
    expect(panel.style.transform).toBe("translateY(500px)");
  });

  it("goes to 90% on a flick up, and settles at the nearest stop after a slow drag", () => {
    drag(600, 400, 100);
    expect(control.stop).toBe(0.9);
    expect(panel.style.transform).toBe("");
    drag(400, 650, 2_000);
    expect(control.stop).toBe(0.4);
    expect(closed).not.toHaveBeenCalled();
  });

  it("closes on a flick down, or dragged well below its lower stop", () => {
    drag(600, 700, 100);
    expect(closed).toHaveBeenCalledOnce();
    control.reset();
    drag(600, 800, 4_000);
    expect(closed).toHaveBeenCalledTimes(2);
  });

  it("follows the finger, but not a tap, and a drag isn't a press", () => {
    pointer("pointerdown", 600);
    pointer("pointermove", 603);
    expect(panel.style.transform).toBe("translateY(500px)");
    clock += 500;
    pointer("pointermove", 640);
    expect(panel.style.transform).toBe("translateY(540px)");
    pointer("pointerup", 640);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    panel.querySelector("a").dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
  });

  it("lets a scrolled list scroll, unless the drag starts on the handle", () => {
    list.scrollTop = 40;
    Object.defineProperty(list, "scrollTop", { value: 40, configurable: true });
    drag(600, 700, 100);
    expect(closed).not.toHaveBeenCalled();
    const handle = panel.querySelector(".handle");
    pointer("pointerdown", 600, handle);
    clock += 50;
    pointer("pointermove", 700, handle);
    pointer("pointerup", 700, handle);
    expect(closed).toHaveBeenCalledOnce();
  });
});
