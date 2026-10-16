import { describe, expect, it } from "vitest";
import engine from "../public/webchat/mascot.js?raw";
import {
  centered,
  FIGURE_PX,
  LOOP,
  PHOTO_PX,
  virtualClock,
} from "../public/webchat/mascot-photo.js";
import { BREATH } from "../public/webchat/mascot-states.js";

// The bot's photo (ADR-0046): Browser Run draws it, frame by frame, on a virtual clock. The drawing
// itself needs a real browser; issue #368 has what it looked like there.

/** An animation that keeps the time it is set to, as a held Web Animation does. */
class HeldAnimation {
  currentTime = 0;
  playState = "running";
  constructor(readonly endTime: number) {}
  get effect() {
    return { getComputedTiming: () => ({ endTime: this.endTime }) };
  }
  pause() {
    this.playState = "paused";
  }
  finish() {
    this.currentTime = this.endTime;
    this.playState = "finished";
  }
  cancel() {
    this.playState = "idle";
  }
}

/** The parts of a window the clock stands in for, recording what reaches the real ones. */
function fakeWindow() {
  const real = { timers: [] as number[], cleared: [] as unknown[] };
  const own = {
    setTimeout: (_run: unknown, ms: number, ..._args: unknown[]) => real.timers.push(ms),
    clearTimeout: (id: unknown) => {
      real.cleared.push(id);
    },
    now: () => 1_000,
    animate: (endTime: number) => new HeldAnimation(endTime),
  };
  /** What the document runs on its own, as a CSS transition does when a style changes. */
  const running: HeldAnimation[] = [];
  const win = {
    setTimeout: own.setTimeout,
    clearTimeout: own.clearTimeout,
    performance: { now: own.now },
    Element: { prototype: { animate: own.animate } },
    document: { getAnimations: () => running },
  };
  return { win, real, own, running };
}

describe("The photo's clock", () => {
  it("runs the timers due, in order, at their own time", async () => {
    const { win, real } = fakeWindow();
    const clock = virtualClock(win);
    const ran: [string, number][] = [];
    clock.start();
    win.setTimeout(() => ran.push(["late", win.performance.now()]), 300);
    win.setTimeout(() => {
      ran.push(["early", win.performance.now()]);
      // A timer a timer sets runs in the same step when it is due by then.
      win.setTimeout(() => ran.push(["chained", win.performance.now()]), 50);
    }, 100);
    win.setTimeout((word: string) => ran.push([word, win.performance.now()]), -5, "now");
    await clock.advance(50);
    expect(ran).toEqual([["now", 1_000]]);
    await clock.advance(200);
    expect(ran.slice(1)).toEqual([
      ["early", 1_100],
      ["chained", 1_150],
    ]);
    expect(clock.now).toBe(200);
    await clock.advance(400);
    expect(ran.at(-1)).toEqual(["late", 1_300]);
    expect(real.timers).toEqual([]);
  });

  it("cancels its own timers, and hands the others to the window's", async () => {
    const { win, real } = fakeWindow();
    const clock = virtualClock(win);
    clock.start();
    let ran = false;
    const id = win.setTimeout(() => {
      ran = true;
    }, 10);
    win.clearTimeout(id);
    win.clearTimeout(42);
    await clock.advance(100);
    expect(ran).toBe(false);
    expect(real.cleared).toEqual([42]);
  });

  it("holds each animation at the clock's time, and finishes it at its end", async () => {
    const { win } = fakeWindow();
    const clock = virtualClock(win);
    clock.start();
    const animate = win.Element.prototype.animate as (endTime: number) => HeldAnimation;
    const blink = animate(200);
    expect(blink.playState).toBe("paused");
    await clock.advance(120);
    expect(blink.currentTime).toBe(120);
    const later = animate(500);
    const dropped = animate(500);
    dropped.cancel();
    await clock.advance(250);
    expect(blink.playState).toBe("finished");
    expect(later.currentTime).toBe(130);
    expect(dropped.currentTime).toBe(0);
    // A finished one is let go: the clock no longer moves it.
    blink.currentTime = 7;
    await clock.advance(300);
    expect(blink.currentTime).toBe(7);
  });

  it("holds a CSS transition from when it starts, as it holds an animation", async () => {
    const { win, running } = fakeWindow();
    const clock = virtualClock(win);
    clock.start();
    // A gesture at 100 ms changes a style, and the hand fades in over 150 ms.
    const fade = new HeldAnimation(150);
    win.setTimeout(() => running.push(fade), 100);
    await clock.advance(200);
    expect(fade.playState).toBe("paused");
    expect(fade.currentTime).toBe(100);
    await clock.advance(300);
    expect(fade.playState).toBe("finished");
  });

  it("gives the window back its own when it stops", () => {
    const { win, own } = fakeWindow();
    const clock = virtualClock(win);
    clock.start();
    expect(win.setTimeout).not.toBe(own.setTimeout);
    clock.stop();
    expect(win.setTimeout).toBe(own.setTimeout);
    expect(win.clearTimeout).toBe(own.clearTimeout);
    expect(win.performance.now).toBe(own.now);
    expect(win.Element.prototype.animate).toBe(own.animate);
  });
});

describe("The photo's loop", () => {
  it("lasts one idle breath, so it joins up when Telegram plays it again", () => {
    expect(LOOP.ms).toBe(BREATH.idle[0]);
    for (const [at] of LOOP.steps) expect(at).toBeLessThan(LOOP.ms);
  });

  it("plays only gestures the engine has", () => {
    for (const [, gesture] of LOOP.steps) {
      expect(engine).toMatch(new RegExp(`^  ${gesture}\\(`, "m"));
    }
  });

  it("keeps the figure's box inside the circle Telegram crops", () => {
    expect((FIGURE_PX / 2) * Math.SQRT2).toBeLessThanOrEqual(PHOTO_PX / 2);
  });
});

describe("The photo's framing", () => {
  /** A box `width` by `height` with an opaque rectangle and faint pixels around it. */
  function box(width: number, height: number, [x0, y0, x1, y1]: [number, number, number, number]) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let row = 0; row < height; row++) {
      for (let column = 0; column < width; column++) {
        const inside = column >= x0 && column <= x1 && row >= y0 && row <= y1;
        data[(row * width + column) * 4 + 3] = inside ? 255 : 10;
      }
    }
    return { data, width, height };
  }

  it("puts what the figure shows, not its box, in the middle", () => {
    // Shown from (10, 40) to (29, 79) in a 100 px box: its middle is (20, 60).
    expect(centered(box(100, 100, [10, 40, 29, 79]))).toEqual([
      PHOTO_PX / 2 - 20,
      PHOTO_PX / 2 - 60,
    ]);
  });

  it("leaves an empty box in the middle", () => {
    expect(centered(box(FIGURE_PX, FIGURE_PX, [1, 1, 0, 0]))).toEqual([
      (PHOTO_PX - FIGURE_PX) / 2,
      (PHOTO_PX - FIGURE_PX) / 2,
    ]);
  });
});
