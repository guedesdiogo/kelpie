import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Mascot, setMotion } from "../../public/webchat/mascot.js";
import { buildMascot, EYES, MARGIN, SHAPES, sizeOf } from "../../public/webchat/mascot-art.js";

// What shows beside the mascot, as the engine plays it (ADR-0065): the speech bubble, the badge,
// the thought bubbles, the sparks and the "z"s float beside the figure, past its frame, over the
// margin its host keeps. Every Web Animation the engine starts is recorded, and each effect is
// followed through its keyframes and easings, and those of the groups that hold it.

vi.hoisted(() => {
  // Before mascot.js loads, so the one timer it starts for every mascot is a fake one too.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});

// Read from disk: this project's Vitest empties CSS imports, `?raw` included.
const styles = readFileSync(
  join(fileURLToPath(import.meta.url), "../../../public/webchat/mascot.css"),
  "utf8",
);

/** A number the stylesheet sets in `rule`, so a change there reaches this test. */
function fromStyles(rule, property) {
  const body = styles.match(
    new RegExp(`${rule.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`),
  )?.[1];
  const value = body?.match(new RegExp(`${property}: ([^;]+);`))?.[1];
  if (value === undefined) throw new Error(`mascot.css has no ${property} in ${rule}`);
  return value.trim();
}
const STROKE = {
  bub: Number(fromStyles(".mascot .bub", "stroke-width")),
  badge: Number(fromStyles(".mascot .bd-c", "stroke-width")),
  speech: Number(fromStyles(".mascot .bub3d", "stroke-width")),
  silent: Number(fromStyles('.mascot[data-badge="silent"] .bd-c', "stroke-width")),
  ring: Number(fromStyles(".mascot .bd-ring", "stroke-width")),
};
const BADGE_SCALE = fromStyles('.mascot[data-size="s"] .m-bdw', "transform");
/** Where each group turns and scales: its fill box, at these shares, or the view box's point. */
const ORIGINS = [
  [".bd-bob", fromStyles(".mascot .bd-bob", "transform-origin")],
  [".speech .bd-dot", fromStyles(".mascot .speech .bd-dot", "transform-origin")],
  [".m-bdw, .bub, .star-a, .zz, .bd-dot, .bd-ring", "center"],
  [".g", fromStyles(".mascot .g", "transform-origin")],
];
// A bold "z": its ink about 0.62 of its size, wide and tall, from its baseline up.
const Z_INK = 0.62;

// ── Matrices and transforms ──
const mul = (a, b) => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];
const ID = [1, 0, 0, 1, 0, 0];
/** A transform list as functions: [name, numbers], read once per text. */
const parsed = new Map();
function functions(text = "none") {
  if (!text || text === "none") return [];
  if (!parsed.has(text)) {
    parsed.set(
      text,
      [...text.matchAll(/(\w+)\(([^)]*)\)/g)].map(([, name, args]) => [
        name,
        args
          .split(/[\s,]+/)
          .filter(Boolean)
          .map(Number.parseFloat),
      ]),
    );
  }
  return parsed.get(text);
}
function matrixOf(list) {
  let m = ID;
  for (const [name, n] of list) {
    if (name === "translate") m = mul(m, [1, 0, 0, 1, n[0], n[1] ?? 0]);
    else if (name === "scale") m = mul(m, [n[0], 0, 0, n[1] ?? n[0], 0, 0]);
    else if (name === "rotate") {
      const r = (n[0] * Math.PI) / 180;
      m = mul(m, [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]);
    } else throw new Error(`no ${name}() here`);
  }
  return m;
}
/** Two transform lists mixed as CSS mixes them, function by function; "none" is their identity. */
function mix(a, b, k) {
  const identity = (name) => (name === "scale" ? [1, 1] : [0, 0]);
  const [from, to] = [functions(a), functions(b)];
  const names = (from.length ? from : to).map(([name]) => name);
  if (from.length && to.length && from.map(([n]) => n).join() !== to.map(([n]) => n).join()) {
    throw new Error(`can't mix ${a} with ${b}`);
  }
  return names.map((name, i) => {
    const x = from[i]?.[1] ?? identity(name);
    const y = to[i]?.[1] ?? identity(name);
    const n = Math.max(x.length, y.length);
    const at = (list, j) => list[j] ?? (name === "scale" ? list[0] : 0);
    return [name, Array.from({ length: n }, (_, j) => at(x, j) + (at(y, j) - at(x, j)) * k)];
  });
}

// ── Easings and keyframes, as WAAPI plays them ──
const BEZIERS = {
  linear: [0, 0, 1, 1],
  ease: [0.25, 0.1, 0.25, 1],
  "ease-in-out": [0.42, 0, 0.58, 1],
  "ease-out": [0, 0, 0.58, 1],
  "ease-in": [0.42, 0, 1, 1],
};
function easing(name = "linear") {
  // A spring's easing overshoots, so a step past its keyframe goes on past it.
  if (name === "linear") return (x) => x;
  if (name.startsWith("linear(")) {
    const points = name.slice(7, -1).split(",").map(Number.parseFloat);
    return (x) => {
      const at = x * (points.length - 1);
      const i = Math.min(points.length - 2, Math.floor(at));
      return points[i] + (points[i + 1] - points[i]) * (at - i);
    };
  }
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
/** A property's keyframes, each at its offset: the missing offsets spread out as WAAPI does. */
function track(keyframes, property) {
  const offsets = keyframes.map((frame) => frame.offset);
  offsets[0] ??= 0;
  offsets[offsets.length - 1] ??= 1;
  for (let i = 1; i < offsets.length - 1; i++) {
    if (offsets[i] !== undefined) continue;
    let j = i;
    while (offsets[j] === undefined) j++;
    for (let k = i; k < j; k++)
      offsets[k] = offsets[i - 1] + ((offsets[j] - offsets[i - 1]) * (k - i + 1)) / (j - i + 1);
  }
  return keyframes
    .map((frame, i) => ({ offset: offsets[i], value: frame[property], easing: frame.easing }))
    .filter((frame) => frame.value !== undefined);
}
/** A track's value at eased progress `p`, past either end along its first or last step. */
function valueAt(frames, p, mixer) {
  if (frames.length === 1) return frames[0].value;
  let i = frames.findIndex((frame, j) => j > 0 && p <= frame.offset);
  if (i < 0) i = frames.length - 1;
  const [a, b] = [frames[i - 1], frames[i]];
  const local = (p - a.offset) / (b.offset - a.offset || 1);
  return mixer(a.value, b.value, easing(a.easing)(local));
}
/** A recorded animation's tracks, once. */
function tracksOf(call) {
  call.tracks ??= {
    transform: track(call.keyframes, "transform"),
    opacity: track(call.keyframes, "opacity"),
    ease: easing(call.options.easing),
  };
  return call.tracks;
}
/**
 * A recorded animation `t` ms after it started, as WAAPI plays it: its delay, iterations, direction
 * and fill. [transform list or null, opacity or null], or null while it has no effect.
 */
function stateAt(call, t) {
  const {
    duration = 0,
    delay = 0,
    iterations = 1,
    direction = "normal",
    fill = "auto",
  } = call.options;
  const local = t - delay;
  let [iteration, progress] = [0, 0];
  if (local < 0) {
    if (fill !== "backwards" && fill !== "both") return null;
  } else if (local >= duration * iterations) {
    if (fill !== "forwards" && fill !== "both") return null;
    [iteration, progress] = [iterations - 1, 1];
  } else {
    iteration = Math.floor(local / duration);
    progress = local / duration - iteration;
  }
  if (direction === "alternate" && iteration % 2 === 1) progress = 1 - progress;
  const { transform, opacity, ease } = tracksOf(call);
  const p = ease(progress);
  return [
    transform.length ? valueAt(transform, p, mix) : null,
    opacity.length
      ? valueAt(opacity, p, (a, b, k) => Number(a) + (Number(b) - Number(a)) * k)
      : null,
  ];
}
/** How long a recorded animation plays: a loop counts one cycle, there and back if it alternates. */
const spanOf = ({ options: o }) =>
  (o.delay ?? 0) +
  (o.duration ?? 0) *
    (Number.isFinite(o.iterations ?? 1)
      ? (o.iterations ?? 1)
      : o.direction === "alternate"
        ? 2
        : 1);
const loops = (call) => !Number.isFinite(call.options.iterations ?? 1);

// ── Geometry ──
/** Points along an outline, sampled: absolute M, L, C, Q and Z, the commands the effects use. */
function outline(d) {
  const points = [];
  let [x, y] = [0, 0];
  for (const [, cmd, args] of d.matchAll(/([A-Za-z])([^A-Za-z]*)/g)) {
    const n = args
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    if (cmd === "M" || cmd === "L") [x, y] = n;
    else if (cmd === "C" || cmd === "Q") {
      const c =
        cmd === "C"
          ? [
              [x, y],
              [n[0], n[1]],
              [n[2], n[3]],
              [n[4], n[5]],
            ]
          : [
              [x, y],
              [n[0], n[1]],
              [n[2], n[3]],
            ];
      for (let t = 0.1; t <= 1.0001; t += 0.1) {
        const s = 1 - t;
        const w =
          c.length === 4
            ? [s ** 3, 3 * s * s * t, 3 * s * t * t, t ** 3]
            : [s * s, 2 * s * t, t * t];
        points.push([
          w.reduce((sum, k, j) => sum + k * c[j][0], 0),
          w.reduce((sum, k, j) => sum + k * c[j][1], 0),
        ]);
      }
      [x, y] = c.at(-1);
    } else if (cmd !== "Z") throw new Error(`an effect drew ${cmd}, which this test can't follow`);
    points.push([x, y]);
  }
  return points;
}
/** An element's own points, and how far its stroke reaches past them. */
function shapeOf(el, svg) {
  const num = (name) => Number(el.getAttribute(name) ?? 0);
  if (el.tagName.toLowerCase() === "circle") {
    const [cx, cy, r] = [num("cx"), num("cy"), num("r")];
    const reach = el.classList.contains("bub")
      ? STROKE.bub / 2
      : el.classList.contains("bd-ring")
        ? STROKE.ring / 2
        : STROKE.badge / 2;
    return {
      points: Array.from({ length: 36 }, (_, i) => [
        cx + r * Math.cos((i * Math.PI) / 18),
        cy + r * Math.sin((i * Math.PI) / 18),
      ]),
      reach,
    };
  }
  if (el.tagName.toLowerCase() === "text") {
    const [x, y, f] = [num("x"), num("y"), num("font-size")];
    return {
      points: [
        [x, y - Z_INK * f],
        [x + Z_INK * f, y - Z_INK * f],
        [x, y],
        [x + Z_INK * f, y],
      ],
      reach: 0,
    };
  }
  const silent = svg.dataset.badge === "silent";
  const reach = el.classList.contains("bub3d") ? (silent ? STROKE.silent : STROKE.speech) / 2 : 0;
  return { points: outline(el.getAttribute("d")), reach };
}
/** The effects' own shapes; the glyphs, highlights and icons inside them never reach past them. */
const SHAPES_DRAWN = ".bd-c, .bd-ring, .bub, .star, .zz";
/** The fill box of an element, in its own coordinates: its shapes, through its children's transforms. */
function fillBox(el, svg) {
  const pts = [];
  const walk = (node, m) => {
    if (node.matches(SHAPES_DRAWN)) {
      for (const [x, y] of shapeOf(node, svg).points)
        pts.push([m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
      return;
    }
    for (const child of node.children) {
      if (child.tagName.toLowerCase() === "g" || child.matches(SHAPES_DRAWN)) {
        walk(child, mul(m, matrixOf(functions(child.getAttribute("transform") ?? "none"))));
      }
    }
  };
  walk(el, ID);
  const xs = pts.map(([x]) => x);
  const ys = pts.map(([, y]) => y);
  return [
    Math.min(...xs),
    Math.min(...ys),
    Math.max(...xs) - Math.min(...xs),
    Math.max(...ys) - Math.min(...ys),
  ];
}
/** Where an element's CSS transform turns about, in its own coordinates. */
function originOf(el, svg) {
  const [, rule] = ORIGINS.find(([selector]) => el.matches(selector)) ?? [null, null];
  if (!rule) return [0, 0];
  if (rule.endsWith("px")) return rule.split(/\s+/).map(Number.parseFloat);
  const [bx, by, bw, bh] = fillBox(el, svg);
  const [ox, oy] = rule === "center" ? [50, 50] : rule.split(/\s+/).map(Number.parseFloat);
  return [bx + (bw * ox) / 100, by + (bh * oy) / 100];
}
const about = ([ox, oy], m) => mul(mul([1, 0, 0, 1, ox, oy], m), [1, 0, 0, 1, -ox, -oy]);

// ── Recording ──
let played = [];
beforeEach(() => {
  played = [];
  setMotion("alive");
  vi.spyOn(Element.prototype, "animate").mockImplementation(function (keyframes, options) {
    played.push({
      element: this,
      keyframes,
      options: typeof options === "number" ? { duration: options } : { ...options },
    });
    return { finished: new Promise(() => {}), cancel() {}, pause() {} };
  });
  if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];
});
afterEach(() => {
  vi.restoreAllMocks();
  setMotion("still");
  document.body.innerHTML = "";
});

/**
 * How far an effect's element reaches on each side of the svg's grid, as it plays: what the state
 * change starts, on one clock, then a later motion at every phase of the loops already running.
 * Each element takes the last animation started on it, since the engine's play() and poseTo()
 * cancel the one before. What fades counts only while it is 25% opaque.
 */
function reachOf(el, svg, change, later) {
  const { points, reach } = shapeOf(el, svg);
  const chain = [];
  for (let node = el; node !== svg; node = node.parentNode) chain.unshift(node);
  const nodes = chain.map((node) => {
    const rest = node.style.transform
      ? functions(node.style.transform)
      : node.matches(".m-bdw") && svg.dataset.size === "s"
        ? functions(BADGE_SCALE)
        : [];
    const attr = matrixOf(functions(node.getAttribute("transform") ?? "none"));
    const origin = originOf(node, svg);
    /** The node's matrix and opacity in `state`, or at rest. */
    const place = (state) => {
      const [list, alpha] = state ?? [null, null];
      return [mul(attr, about(origin, matrixOf(list ?? rest))), alpha ?? 1];
    };
    return {
      place,
      change: change.findLast((call) => call.element === node),
      later: later.findLast((call) => call.element === node),
    };
  });
  const e = { top: Infinity, right: -Infinity, bottom: -Infinity, left: Infinity };
  /** The chain at one moment, from each node's place. */
  const measure = (places) => {
    let m = ID;
    let opacity = 1;
    for (const [matrix, alpha] of places) {
      m = mul(m, matrix);
      opacity *= alpha;
    }
    if (opacity < 0.25) return;
    const grow = reach * Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
    for (const [x, y] of points) {
      const [X, Y] = [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
      e.top = Math.min(e.top, Y - grow);
      e.bottom = Math.max(e.bottom, Y + grow);
      e.left = Math.min(e.left, X - grow);
      e.right = Math.max(e.right, X + grow);
    }
  };
  /** A node's places along a clock: every `step` ms from 0 to `end`. */
  const along = (node, call, end, step) =>
    Array.from({ length: Math.floor(end / step) + 1 }, (_, k) =>
      node.place(call ? stateAt(call, k * step) : null),
    );
  // At rest, as Still shows it.
  measure(nodes.map((node) => node.place(null)));
  // The state change, every 8 ms, for as long as what moves this effect plays.
  const end = Math.max(
    0,
    ...nodes.filter((node) => node.change).map((node) => spanOf(node.change)),
  );
  const first = nodes.map((node) => along(node, node.change, end, 8));
  for (let k = 0; k < first[0].length; k++) measure(first.map((places) => places[k]));
  // A later motion, every 16 ms, once the change has settled, at every phase of the loops on this
  // effect, 48 ms apart.
  if (later.length) {
    const cycle = ({ options: o }) =>
      (o.delay ?? 0) + (o.duration ?? 0) * (o.direction === "alternate" ? 2 : 1);
    const period = Math.max(
      0,
      ...nodes
        .filter((node) => node.change && loops(node.change))
        .map((node) => cycle(node.change)),
    );
    const span = Math.max(0, ...later.map(spanOf));
    const second = nodes.map((node) => {
      if (node.later) return { at: along(node, node.later, span, 16), loop: false };
      if (node.change && loops(node.change))
        return { at: along(node, node.change, period + span, 16), loop: true };
      const settled = node.place(
        node.change ? stateAt(node.change, Number.POSITIVE_INFINITY) : null,
      );
      return { at: [settled], fixed: true };
    });
    for (let phase = 0; phase * 16 <= period; phase += 3) {
      for (let k = 0; k * 16 <= span; k++) {
        measure(second.map(({ at, loop, fixed }) => (fixed ? at[0] : at[loop ? phase + k : k])));
      }
    }
  }
  return e;
}

const look = (shape, eyes = "big") => ({
  shape,
  color: "kelp",
  eyes,
  cheeks: false,
  head: { type: "none" },
  accessory: { type: "none" },
});
const MODES = { 36: "list", 48: "header", 160: "large" };
/** A live mascot in its host. */
function mascotOf(mascotLook, px) {
  const host = document.createElement("div");
  document.body.append(host);
  return new Mascot(host, { mascot: mascotLook, px, mode: MODES[px], state: "idle" });
}
/**
 * A mascot from idle into `state`: what that change plays, and what `then` plays after it, if
 * anything.
 */
function play(mascotLook, px, state, then, mascot = mascotOf(mascotLook, px)) {
  mascot.setState("idle", { instant: true });
  played = [];
  if (state === "thinking") mascot.setState("working", { activity: "think" });
  else mascot.setState(state);
  const change = played;
  played = [];
  then?.(mascot);
  const later = played;
  played = [...change, ...later];
  return { mascot, change, later };
}
/** The effects a state shows, by what draws them. */
const SHOWS = {
  waiting: ".speech .bd-c, .m-bdw:not(.speech) .bd-c, .bd-ring",
  error: ".speech .bd-c, .m-bdw:not(.speech) .bd-c, .bd-ring",
  noResponse: ".speech .bd-c, .m-bdw:not(.speech) .bd-c",
  offline: ".speech .bd-c, .m-bdw:not(.speech) .bd-c",
  approved: ".star",
  thinking: ".bub",
  dozing: ".zz",
};
const MOTIONS = {
  waiting: (m) => m.pulse(),
  error: (m) => m.pulse(),
};

/** How far each side reaches past the frame, worst over what `state` shows. */
function pastFrame({ mascot, change, later }, state) {
  const { svg, frame } = mascot;
  const past = { top: -Infinity, right: -Infinity, bottom: -Infinity, left: -Infinity };
  const shown = [...svg.querySelectorAll(SHOWS[state])];
  // A renamed part would otherwise go unchecked.
  expect(shown.length, state).toBeGreaterThan(0);
  for (const el of shown) {
    // The roster's 36 px shows no "z", and the badge only there.
    if (el.matches(".zz") && svg.dataset.size === "s") continue;
    const e = reachOf(el, svg, change, later);
    past.top = Math.max(past.top, frame.y - e.top);
    past.left = Math.max(past.left, frame.x - e.left);
    past.right = Math.max(past.right, e.right - frame.x - frame.size);
    past.bottom = Math.max(past.bottom, e.bottom - frame.y - frame.size);
  }
  return past;
}

describe("what shows beside the mascot, as the engine plays it (ADR-0065)", () => {
  it("draws the thought bubbles, the sparks and the z in a layer outside the hop", () => {
    const { svg } = play(look("mark"), 48, "approved").mascot;
    for (const effect of [".fx-bub", ".fx-spark", ".fx-zzz"]) {
      expect(svg.querySelector(`.m-fx > ${effect}`), effect).not.toBeNull();
      expect(svg.querySelector(`.m-hop ${effect}`), effect).toBeNull();
    }
    // The bubble and the badge sit beside the figure too; the sweat drop stays on its face.
    expect(svg.querySelector(".m-hop .m-bdw")).toBeNull();
    expect(svg.querySelector(".m-pose .drop")).not.toBeNull();
  });

  it("gives that layer the state's pose, and none of the figure's hops", () => {
    const { mascot } = play(look("drop"), 48, "approved", (m) => m.hop(15, true));
    const fx = mascot.svg.querySelector(".m-fx");
    expect(fx.style.transform).toBe(mascot.poseG.style.transform);
    expect(fx.style.transform).toContain("scale(1, 1.02)");
    const effects = [...mascot.svg.querySelectorAll(".m-fx *, .m-bdw *")];
    for (const call of played) {
      if (call.element === fx || effects.includes(call.element)) continue;
      // Nothing else that plays holds an effect: the hop, the squash, the breath, the mittens.
      for (const el of effects)
        expect(call.element.contains(el), call.element.getAttribute("class")).toBe(false);
    }
    expect(played.some((call) => call.element === mascot.hopG)).toBe(true);
  });

  // Every shape, every eye that moves the bubble, at each size: seconds of geometry.
  it("keeps every effect inside its frame and the margin, at rest and through its own motion", {
    timeout: 90_000,
  }, () => {
    const most = {};
    const beyond = [];
    const seen = new Set();
    for (const px of [36, 48, 160]) {
      const size = sizeOf(px);
      const margin = MARGIN[size];
      for (const shape of Object.keys(SHAPES)) {
        for (const eyes of ["big", ...Object.keys(EYES).filter((name) => name !== "big")]) {
          // The eyes move only the bubble, and only eyes that put it somewhere new add anything.
          const html = buildMascot(look(shape, eyes), { uid: 0, px, hex: "#2e9e8e" }).html;
          const at = `${px} ${shape} ${html.match(/<g transform="([^"]*)"><g class="m-bdw/)[1]}`;
          if (seen.has(at)) continue;
          seen.add(at);
          const mascot = mascotOf(look(shape, eyes), px);
          for (const state of Object.keys(SHOWS)) {
            // The thought bubbles, the sparks and the "z" sit on the head, wherever the eyes are.
            if (eyes !== "big" && !SHOWS[state].includes("speech")) continue;
            const run = play(null, px, state, MOTIONS[state], mascot);
            const past = pastFrame(run, state);
            const where = `${shape} ${eyes} ${state} ${px}`;
            for (const side of ["top", "right", "bottom"]) {
              if (past[side] > margin[side])
                beyond.push(`${where}: ${side} ${past[side].toFixed(2)}`);
              most[`${size}.${side}`] = Math.max(most[`${size}.${side}`] ?? 0, past[side]);
            }
            if (past.left > 0) beyond.push(`${where}: left ${past.left.toFixed(2)}`);
          }
          document.body.innerHTML = "";
        }
      }
    }
    expect(beyond).toEqual([]);
    // The margin is the most they reach, up to the next half unit: the room the hosts keep is needed.
    const needed = Object.fromEntries(
      Object.entries(MARGIN).map(([size, sides]) => [
        size,
        Object.fromEntries(
          Object.keys(sides).map((side) => [
            side,
            Math.ceil((most[`${size}.${side}`] ?? 0) * 2) / 2,
          ]),
        ),
      ]),
    );
    expect(MARGIN).toEqual(needed);
  });
});
