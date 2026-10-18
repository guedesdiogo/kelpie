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
  // The agent's editor (#379, the lab "O editor do agente em movimento"): the pencil on a mascot,
  // Undo as a U-turn, never a circle that reads as refresh, and Randomize as a die with three pips.
  pencil: ["M10.5 2.8l2.4 2.4L6.2 11.9l-3 .8.8-3z", "M9.2 4.1l2.4 2.4"],
  undo: ["M5.5 4L2.5 7l3 3", "M2.5 7h7a3.5 3.5 0 0 1 0 7H8"],
  dice: [
    "M5 2.5h6A2.5 2.5 0 0 1 13.5 5v6a2.5 2.5 0 0 1-2.5 2.5H5A2.5 2.5 0 0 1 2.5 11V5A2.5 2.5 0 0 1 5 2.5Z",
    { d: "M5.5 4.5a1 1 0 1 0 0 2a1 1 0 1 0 0-2Z", solid: true },
    { d: "M8 7a1 1 0 1 0 0 2a1 1 0 1 0 0-2Z", solid: true },
    { d: "M10.5 9.5a1 1 0 1 0 0 2a1 1 0 1 0 0-2Z", solid: true },
  ],
  lock: [
    "M5 7h6a1.5 1.5 0 0 1 1.5 1.5v3.5A1.5 1.5 0 0 1 11 13.5H5A1.5 1.5 0 0 1 3.5 12V8.5A1.5 1.5 0 0 1 5 7Z",
    "M5.5 7V5a2.5 2.5 0 0 1 5 0v2",
  ],
  // The editor's sections: an ID card, a page with a heart, a list, two stacked notes and a puzzle
  // piece. None is a lone diamond, triangle, or hollow or dashed circle: those are 5.9's glyphs.
  profile: [
    "M3.5 3.5h9A1.5 1.5 0 0 1 14 5v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11V5a1.5 1.5 0 0 1 1.5-1.5Z",
    "M5.8 6a1.3 1.3 0 1 0 0 2.6a1.3 1.3 0 1 0 0-2.6Z",
    "M4 10.4c.5-.9 1.1-1.3 1.8-1.3s1.3.4 1.8 1.3M9.5 7h3M9.5 9.5h3",
  ],
  soul: [
    "M4 2.5h5.5l3 3v8H4z",
    "M9.5 2.5v3h3",
    "M8.2 11.6s-2-1.2-2-2.5a1 1 0 0 1 2-.5a1 1 0 0 1 2 .5c0 1.3-2 2.5-2 2.5z",
  ],
  rules: [
    "M6.5 4.5h7M6.5 8h7M6.5 11.5h7",
    { d: "M3.4 3.6a.9.9 0 1 0 0 1.8a.9.9 0 1 0 0-1.8Z", solid: true },
    { d: "M3.4 7.1a.9.9 0 1 0 0 1.8a.9.9 0 1 0 0-1.8Z", solid: true },
    { d: "M3.4 10.6a.9.9 0 1 0 0 1.8a.9.9 0 1 0 0-1.8Z", solid: true },
  ],
  memory: [
    "M5.5 3.5h7v7",
    "M3.5 5.5h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z",
    "M4.5 8.5h4M4.5 11h3",
  ],
  skills: [
    "M6.5 3.5h1.7a1.3 1.3 0 0 1 2.6 0h1.7v2.2a1.3 1.3 0 0 1 0 2.6V11h-2.3a1.3 1.3 0 0 0-2.6 0H5.4V8.3a1.3 1.3 0 0 1 0-2.6V3.5z",
  ],
  // The agent's files (#381, the lab's interactions 4 and 5): Visualizar is a book and Editar a
  // pencil on its line, two segments, never one glyph that flips (Obsidian's, avoided). The
  // install's sources: a link, a file and a pasted page.
  book: [
    "M8 4.3C6.5 3.3 4.5 3 2.5 3.3v9c2-.3 4 0 5.5 1c1.5-1 3.5-1.3 5.5-1v-9C11.5 3 9.5 3.3 8 4.3Z",
    "M8 4.3v9",
  ],
  pencilLine: ["M10.5 2.8l2.4 2.4L6.2 11.9l-3 .8.8-3z", "M9.2 4.1l2.4 2.4", "M8.5 14h5"],
  link: [
    "M6.5 9.5l3-3",
    "M7.2 4.6l1-1a2.6 2.6 0 0 1 3.7 3.7l-1 1",
    "M8.8 11.4l-1 1a2.6 2.6 0 0 1-3.7-3.7l1-1",
  ],
  file: ["M4 2.5h5.5l3 3v8H4z", "M9.5 2.5v3h3"],
  paste: [
    "M10.5 3.5h1A1.5 1.5 0 0 1 13 5v7.5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 12.5V5a1.5 1.5 0 0 1 1.5-1.5h1",
    "M6.5 2.5h3a1 1 0 0 1 1 1v.5a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-.5a1 1 0 0 1 1-1Z",
  ],
  plus: ["M8 3.5v9", "M3.5 8h9"],
  chevronRight: ["M6.5 4.5L10 8l-3.5 3.5"],
  chevronLeft: ["M9.5 4.5L6 8l3.5 3.5"],
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
  // The editor's Mascot section (#379): the mascot's own outline, at rest.
  body: [["g", { transform: "translate(0 -1.6)" }, BODY]],
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
