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
