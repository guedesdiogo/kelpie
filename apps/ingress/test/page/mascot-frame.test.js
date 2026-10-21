import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Mascot, setMotion } from "../../public/webchat/mascot.js";
import { FRAME } from "../../public/webchat/mascot-art.js";
import { GROUND, HEADROOM, stillStretch } from "../../public/webchat/mascot-states.js";

// The mascot's frame as the engine plays it (ADR-0063): every Web Animation the engine starts is
// recorded, and each motion that lifts the figure is followed through its time, keyframe by
// keyframe and easing by easing, to the highest the figure's top goes.

vi.hoisted(() => {
  // Before mascot.js loads, so the one timer it starts for every mascot is a fake one too.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});

const BEZIERS = {
  linear: [0, 0, 1, 1],
  "ease-in-out": [0.42, 0, 0.58, 1],
  "ease-out": [0, 0, 0.58, 1],
};

/** A CSS easing as a function of time, as the browser plays it. */
function easing(name = "linear") {
  const [x1, y1, x2, y2] = BEZIERS[name] ?? name.match(/-?[\d.]+/g).map(Number);
  const at = (s, a, b) => 3 * (1 - s) ** 2 * s * a + 3 * (1 - s) * s * s * b + s ** 3;
  return (x) => {
    let [lo, hi] = [0, 1];
    for (let i = 0; i < 40; i++) {
      const s = (lo + hi) / 2;
      if (at(s, x1, x2) < x) lo = s;
      else hi = s;
    }
    return at((lo + hi) / 2, y1, y2);
  };
}

/** How far a transform lifts the figure, and how much it stretches it upward. */
function lifted(transform = "none") {
  const up = /translate\(\s*-?[\d.]+px,\s*(-?[\d.]+)px\)/.exec(transform);
  const scale = /scale\(\s*[\d.]+,\s*([\d.]+)\)/.exec(transform);
  return [up ? -Number(up[1]) : 0, scale ? Number(scale[1]) : 1];
}

/** A recorded animation's lift and stretch at `t` ms, its keyframes eased as WAAPI eases them. */
function at({ keyframes, options }, t) {
  const p = easing(options.easing)(Math.min(1, Math.max(0, t / options.duration)));
  const offsets = keyframes.map((frame, i) => frame.offset ?? (i === 0 ? 0 : 1));
  for (let i = 1; i < keyframes.length; i++) {
    if (p > offsets[i]) continue;
    const local = (p - offsets[i - 1]) / (offsets[i] - offsets[i - 1] || 1);
    const k = easing(keyframes[i - 1].easing)(local);
    const [from, to] = [lifted(keyframes[i - 1].transform), lifted(keyframes[i].transform)];
    return [from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k];
  }
  return lifted(keyframes.at(-1).transform);
}

const LOOKS = {
  master: { shape: "mark", head: { type: "ears", variation: "pointed" } },
  bare: { shape: "mark", head: { type: "none" } },
  antennae: { shape: "drop", head: { type: "horns", variation: "antennae" } },
  kelp: { shape: "drop", head: { type: "leaves", variation: "kelp" } },
  hat: { shape: "buoy", head: { type: "none" }, accessory: { type: "hat", variation: "top" } },
};
const look = (name) => ({
  color: "kelp",
  eyes: "big",
  cheeks: false,
  accessory: { type: "none" },
  ...LOOKS[name],
});

let played = [];
beforeEach(() => {
  played = [];
  setMotion("alive");
  vi.spyOn(Element.prototype, "animate").mockImplementation(function (keyframes, options) {
    played.push({ element: this, keyframes, options });
    // Never finished, so the landing's squash doesn't follow.
    return { finished: new Promise(() => {}), cancel() {}, pause() {} };
  });
  if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];
});
afterEach(() => {
  vi.restoreAllMocks();
  setMotion("still");
  document.body.innerHTML = "";
});

/** A mascot in `state`, the motion `run` plays on it, and the highest its top went. */
function play(name, state, run, { px = 160, mode = "large" } = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const mascot = new Mascot(host, { mascot: look(name), px, mode, state });
  mascot.setState(state, { instant: true });
  played = [];
  const top = run(mascot);
  const track = (element) => played.findLast((call) => call.element === element);
  const lift = track(mascot.hopG);
  const squash = track(mascot.squash);
  const stretch = stillStretch(state, mode);
  let highest = Number.POSITIVE_INFINITY;
  let rise = 0;
  const end = Math.max(lift?.options.duration ?? 0, squash?.options.duration ?? 0);
  for (let t = 0; t <= end; t++) {
    const [up] = lift ? at(lift, t) : [0, 1];
    const [, sy] = squash ? at(squash, t) : [0, 1];
    rise = Math.max(rise, up);
    highest = Math.min(highest, GROUND - (GROUND - top) * stretch * sy - up);
  }
  return { mascot, highest, rise, ceiling: mascot.frame.y + HEADROOM };
}

describe("the mascot's frame, as the engine plays it (ADR-0063)", () => {
  it("frames the figure in the frame's viewBox", () => {
    const { mascot } = play("master", "idle", (m) => m.top());
    expect(mascot.svg.getAttribute("viewBox")).toBe("4 2 112 112");
    expect(mascot.frame).toBe(FRAME);
  });

  it("plays a full hop where the figure has room", () => {
    const { highest, rise, ceiling } = play("bare", "approved", (m) => {
      m.hop(15, true);
      return m.top();
    });
    expect(rise).toBeCloseTo(15);
    expect(highest).toBeGreaterThanOrEqual(ceiling);
  });

  it("cuts each hop to the room above the figure, and still hops", () => {
    for (const name of ["master", "antennae", "hat"]) {
      for (const [state, height] of [
        ["approved", 15],
        ["waiting", 11],
        ["idle", 12],
        ["idle", 7],
      ]) {
        const { highest, rise, ceiling } = play(name, state, (m) => {
          m.hop(height, true);
          return m.top();
        });
        expect(highest, `${name} ${state} ${height}`).toBeGreaterThanOrEqual(ceiling - 1e-6);
        expect(rise, `${name} ${state} ${height}`).toBeLessThan(height);
        expect(rise, `${name} ${state} ${height}`).toBeGreaterThan(0);
      }
    }
    // Master keeps about half of Approved's jump.
    const master = play("master", "approved", (m) => {
      m.hop(15, true);
      return m.top();
    });
    expect(master.rise / 15).toBeGreaterThan(0.45);
  });

  it("counts the mittens a call for help raises above the head", () => {
    // Bare, the mittens have room to spare; with a tall head or a hat, they set the hop.
    for (const name of ["bare", "master", "antennae", "hat"]) {
      const { mascot, highest, ceiling } = play(name, "error", (m) => {
        m.callHelp();
        return m.raised(22);
      });
      // Master's ears stand higher than its raised mittens; the others' mittens set their top.
      const above = mascot.raised(0) < mascot.top();
      expect(above, name).toBe(name !== "master");
      // Each mitten waves outward, which lifts its tip.
      if (above) expect(mascot.raised(22), name).toBeLessThan(mascot.raised(0));
      expect(highest, name).toBeGreaterThanOrEqual(ceiling - 1e-6);
    }
  });

  it("has no mittens to raise in a roster row", () => {
    const { mascot } = play("antennae", "error", (m) => m.top(), { px: 36, mode: "list" });
    expect(mascot.raised(22)).toBe(mascot.top());
  });

  it("cuts the stretch, with its raised mittens, to the room above them", () => {
    for (const name of ["master", "antennae", "kelp"]) {
      const { highest, ceiling } = play(name, "idle", (m) => {
        m.stretch();
        return m.raised();
      });
      expect(highest, name).toBeGreaterThanOrEqual(ceiling - 1e-6);
    }
  });

  it("drops a new head in from no higher than the room above it", () => {
    const { mascot } = play("kelp", "idle", (m) => {
      m.restyle({ ...look("kelp"), head: { type: "horns", variation: "one" } }, "head");
      return m.top();
    });
    const drops = played.filter((call) => call.element.classList?.contains("m-head"));
    expect(drops.length).toBeGreaterThan(0);
    for (const { keyframes } of drops) {
      const [up] = lifted(keyframes[0].transform);
      const stretch = stillStretch("idle", "large");
      expect(GROUND - (GROUND - mascot.top()) * stretch - up).toBeGreaterThanOrEqual(
        mascot.frame.y + HEADROOM - 1e-6,
      );
    }
  });
});
