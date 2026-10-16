// The webchat's few glyphs, drawn with createElementNS: no markup is parsed. Each is decorative
// (`aria-hidden`); the text beside it carries the meaning, so color never does alone (§1).

const SVG = "http://www.w3.org/2000/svg";

const PATHS = {
  // A clock: held (5.1) and queued (5.12).
  clock: ["M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11Z", "M8 5v3.2l2 1.3"],
  // A refusal or a failure: a circle with a bar.
  alert: ["M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11Z", "M8 5v3.5", "M8 10.6v.4"],
  check: ["M3.5 8.5l3 3l6-6.5"],
  // A neutral receipt: a dash in a circle.
  neutral: ["M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11Z", "M5.5 8h5"],
  chevron: ["M4.5 6.5l3.5 3.5l3.5-3.5"],
  // The composer's Send and Pause (the lab's "Mensagens em ritmo humano").
  up: ["M8 13V3.5", "M4 7.5l4-4l4 4"],
  pause: ["M6 4.5v7", "M10 4.5v7"],
  // A lost connection (the review's "Caiu a conexão") and an agent waiting for the owner.
  wifiOff: [
    "M2 2l12 12",
    "M5.5 8.6a4 4 0 0 1 4.2-.9",
    "M3 6.2a7.5 7.5 0 0 1 2.8-1.7",
    "M10.6 4.6A7.5 7.5 0 0 1 13 6.2",
    "M7 11a1.5 1.5 0 0 1 2 0",
  ],
  bell: ["M4 11V7.5a4 4 0 0 1 8 0V11l1 1.5H3Z", "M6.5 14h3"],
  close: ["M4.5 4.5l7 7", "M11.5 4.5l-7 7"],
  // The Display menu: a half-filled circle.
  display: ["M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11Z", "M8 2.5v11"],
  chevronUp: ["M4.5 9.5L8 6l3.5 3.5"],
  // The theme, as icons (decision 8): the system's screen, the sun and the moon.
  monitor: [
    "M3.5 3h9A1.5 1.5 0 0 1 14 4.5v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 10V4.5A1.5 1.5 0 0 1 3.5 3Z",
    "M6 14h4",
    "M8 11.5V14",
  ],
  sun: [
    "M8 5.2a2.8 2.8 0 1 0 0 5.6a2.8 2.8 0 1 0 0-5.6Z",
    "M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M3.6 12.4l1-1M11.4 4.6l1-1",
  ],
  moon: ["M13 9.6A5.2 5.2 0 0 1 6.4 3a5.2 5.2 0 1 0 6.6 6.6Z"],
  // The comfort switches (the design system's §8 research): less motion, a circle with one trail;
  // more contrast, a rounded square split on its diagonal, never the half-filled circle of working.
  lessMotion: ["M11 5.25a2.75 2.75 0 1 0 0 5.5a2.75 2.75 0 1 0 0-5.5Z", "M2.75 8h4"],
  contrast: [
    "M5.25 2.75h5.5a2.5 2.5 0 0 1 2.5 2.5v5.5a2.5 2.5 0 0 1-2.5 2.5h-5.5a2.5 2.5 0 0 1-2.5-2.5v-5.5a2.5 2.5 0 0 1 2.5-2.5Z",
    { d: "M13.25 2.75V10.75A2.5 2.5 0 0 1 10.75 13.25H2.75Z", solid: true },
  ],
};

/**
 * The mascot's outline on a 20 px grid, as the main mascot now looks: round ears (ADR-0049), its
 * ears and eyes filled. The shapes of its motion setting, as the design system draws them.
 */
const BODY = [
  [
    "path",
    { d: "M9 6.5h2a6 6 0 0 1 6 6v0a5.5 5.5 0 0 1-5.5 5.5H5a2 2 0 0 1-2-2v-3.5a6 6 0 0 1 6-6Z" },
  ],
  ["circle", { cx: 5.9, cy: 5.1, r: 2, class: "solid" }],
  ["circle", { cx: 14.1, cy: 5.1, r: 2, class: "solid" }],
  ["circle", { cx: 8.2, cy: 12.4, r: 1, class: "solid" }],
  ["circle", { cx: 12, cy: 12.4, r: 1, class: "solid" }],
];

/**
 * The mascot's motion setting (decision 8, owner 2026-10-16): mid-hop for Alive, with 5.19's
 * badge for States only, standing on a line for Still.
 */
const OUTLINES = {
  alive: [
    ["g", { transform: "translate(-.6 -1.8) rotate(-9 10 12)" }, BODY],
    ["path", { d: "M6.5 19.2h6" }],
    ["path", { d: "M17.2 2.4l.8 1.6M19 5.4l-1.6.6" }],
  ],
  states: [
    ["g", { transform: "translate(-1.2 .9) scale(.9)" }, BODY],
    ["circle", { cx: 16.4, cy: 4, r: 2.6, class: "solid" }],
  ],
  still: [
    ["g", { transform: "translate(0 -.4)" }, BODY],
    ["path", { d: "M3 19.2h14" }],
  ],
};

function draw(parent, shapes) {
  for (const [tag, attributes, children] of shapes) {
    const shape = document.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attributes)) shape.setAttribute(key, String(value));
    if (children) draw(shape, children);
    parent.append(shape);
  }
}

export function outline(name) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("class", `icon icon-m20 icon-${name}`);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  draw(svg, OUTLINES[name] ?? []);
  return svg;
}

export function icon(name, className = "icon") {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", `${className} icon-${name}`);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const part of PATHS[name] ?? []) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", typeof part === "string" ? part : part.d);
    if (part.solid) path.setAttribute("class", "solid");
    svg.append(path);
  }
  return svg;
}
