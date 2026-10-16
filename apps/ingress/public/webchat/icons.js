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
};

export function icon(name, className = "icon") {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", `${className} icon-${name}`);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const d of PATHS[name] ?? []) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}
