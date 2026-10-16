// The mascot's figure as data (ADR-0045 §2, §3, §10): shapes, eyes, heads, accessories, mittens,
// the task's objects and the bubbles, built as one SVG string for any combination. The ids are
// @kelpie/config's. Soft parts are "pieces": mascot.js paints their fur once per piece and size,
// and until then their flat vectors show.
//
// The page's content policy refuses inline style attributes, so nothing here writes one: colors
// are presentation attributes or classes in mascot.css, and mascot.js sets what varies through
// the CSSOM.

/** The ink of the eyes and lines, and the mix the fur's shades come from. */
const INK = "#0C2523";

const rgb = (hex) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));

/** `a` mixed toward `b` by `t`, in sRGB, so a painted fur layer needs no CSS. */
export function mix(a, b, t) {
  const to = rgb(b);
  const channels = rgb(a).map((value, i) => Math.round(value + (to[i] - value) * t));
  return `#${channels.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

/** The body's shades from its color token's value. */
export function palette(hex) {
  const body = hex.toLowerCase();
  return {
    body,
    light: mix(body, "#ffffff", 0.2),
    edge: mix(body, INK, 0.22),
    dark: mix(body, INK, 0.34),
    darkish: mix(body, INK, 0.2),
  };
}

/** A rectangle with its own radius at each corner: top left, top right, bottom right, bottom left. */
const rounded = (x, y, w, h, [a, b, c, d]) =>
  `M${x + a},${y} H${x + w - b} A${b},${b} 0 0 1 ${x + w},${y + b} V${y + h - c} A${c},${c} 0 0 1 ${x + w - c},${y + h} H${x + d} A${d},${d} 0 0 1 ${x},${y + h - d} V${y + a} A${a},${a} 0 0 1 ${x + a},${y} Z`;
const ellipse = (cx, cy, rx, ry) =>
  `M${cx - rx},${cy} a${rx},${ry} 0 1,0 ${2 * rx},0 a${rx},${ry} 0 1,0 ${-2 * rx},0 Z`;
const circle = (cx, cy, r) => ellipse(cx, cy, r, r);

/**
 * Shapes drawn on a 120 grid and framed at 10,14 100×100, so the body fills about 72%; the ground
 * is at y 108. Anchors: the face, the eyes' spread, the top of the head, the ears (x, y, angle),
 * the hat (x, y, width) and the collar.
 */
export const SHAPES = {
  mark: {
    d: rounded(24, 36, 72, 72, [36, 36, 36, 11.5]),
    face: [61, 70],
    spread: 14,
    top: [60, 36],
    ears: [
      [41, 45, -18],
      [79, 45, 18],
    ],
    hat: [60, 44, 46],
    collar: [58, 92],
  },
  bubble: {
    d: "M21,73 A39,35 0 1,1 99,73 A39,35 0 1,1 21,73 Z",
    face: [60, 72],
    spread: 15,
    top: [60, 38],
    ears: [
      [40, 47, -20],
      [80, 47, 20],
    ],
    hat: [60, 46, 50],
    collar: [60, 93],
  },
  drop: {
    d: "M60,22 C64,36 96,52 96,74 A36,34 0 0 1 24,74 C24,52 56,36 60,22 Z",
    face: [60, 79],
    spread: 13,
    mouth: 11,
    top: [60, 23],
    ears: [
      [46, 49, -26],
      [74, 49, 26],
    ],
    hat: [60, 42, 30],
    collar: [60, 98],
  },
  pebble: {
    d: "M60,42 C88,42 101,54 101,76 C101,98 88,108 60,108 C32,108 19,98 19,76 C19,54 32,42 60,42 Z",
    face: [60, 76],
    spread: 16,
    top: [60, 42],
    ears: [
      [38, 51, -16],
      [82, 51, 16],
    ],
    hat: [60, 48, 50],
    collar: [60, 95],
  },
  buoy: {
    d: rounded(31, 28, 58, 80, [29, 29, 24, 24]),
    face: [60, 62],
    spread: 12,
    top: [60, 28],
    ears: [
      [44, 36, -12],
      [76, 36, 12],
    ],
    hat: [60, 36, 40],
    collar: [60, 86],
  },
  jellyfish: {
    d: "M22,72 C22,49 39,36 60,36 C81,36 98,49 98,72 V100 Q85.33,116 72.67,100 Q60,116 47.33,100 Q34.67,116 22,100 Z",
    face: [60, 68],
    spread: 15,
    top: [60, 36],
    ears: [
      [40, 45, -20],
      [80, 45, 20],
    ],
    hat: [60, 44, 46],
    collar: [60, 89],
  },
  cloud: {
    d: "M32,108 C22,108 18,100 19,92 C12,88 12,76 20,72 C18,60 28,52 39,55 C42,44 52,39 61,40 C71,40 79,46 81,55 C92,53 101,61 99,72 C107,77 107,90 100,94 C101,103 95,108 88,108 Z",
    face: [60, 78],
    spread: 15,
    top: [61, 41],
    ears: [
      [39, 58, -28],
      [82, 58, 28],
    ],
    hat: [61, 47, 40],
    collar: [60, 97],
  },
  dune: {
    d: "M60,32 C66,32 70,36 74,43 L96,90 C100,99 95,108 85,108 L35,108 C25,108 20,99 24,90 L46,43 C50,36 54,32 60,32 Z",
    face: [60, 80],
    spread: 13,
    mouth: 11,
    top: [60, 33],
    ears: [
      [49, 46, -22],
      [71, 46, 22],
    ],
    hat: [60, 44, 28],
    collar: [60, 97],
  },
  star: {
    d: "M52.7,36.7 Q60,21.8 67.3,36.7 Q74.7,51.6 91.1,54 Q107.6,56.4 95.7,67.9 Q83.8,79.5 86.6,95.9 Q89.4,112.3 74.7,104.5 Q60,96.8 45.3,104.5 Q30.6,112.3 33.4,95.9 Q36.2,79.5 24.3,67.9 Q12.4,56.4 28.9,54 Q45.3,51.6 52.7,36.7 Z",
    face: [60, 70],
    spread: 11,
    mouth: 12,
    top: [60, 31],
    ears: [
      [51, 42, -16],
      [69, 42, 16],
    ],
    hat: [60, 40, 22],
    collar: [60, 85],
  },
  heart: {
    d: "M60,108 C40,96 20,82 20,62 C20,49 30,41 41,41 C50,41 56,47 60,54 C64,47 70,41 79,41 C90,41 100,49 100,62 C100,82 80,96 60,108 Z",
    face: [60, 64],
    spread: 14,
    mouth: 12,
    top: [60, 52],
    ears: [
      [38, 48, -18],
      [82, 48, 18],
    ],
    hat: [60, 50, 40],
    collar: [60, 86],
  },
  bean: {
    d: "M30,60 C38,46 54,48 62,50 C72,52 80,44 92,52 C104,60 104,96 84,104 C70,110 46,110 32,104 C14,96 18,72 30,60 Z",
    face: [58, 79],
    spread: 15,
    top: [60, 49],
    ears: [
      [38, 58, -22],
      [84, 55, 20],
    ],
    hat: [62, 52, 44],
    collar: [60, 99],
  },
  block: {
    d: rounded(22, 40, 76, 68, [18, 18, 16, 16]),
    face: [60, 72],
    spread: 16,
    top: [60, 40],
    ears: [
      [34, 47, -10],
      [86, 47, 10],
    ],
    hat: [60, 44, 56],
    collar: [60, 97],
  },
};

/** The body colors' token names; their values are `--mascot-*` in mascot.css. */
export const COLORS = [
  "kelp",
  "lagoon",
  "tide",
  "sky",
  "indigo",
  "anemone",
  "pink",
  "fawn",
  "cocoa",
  "moss",
  "lime",
  "slate",
];

const pupil = (r, h) =>
  `<g class="m-pupil"><circle class="eink" r="${r}"/><circle class="wht" cx="${-r * 0.34}" cy="${-r * 0.38}" r="${h}"/><circle class="wht" cx="${r * 0.36}" cy="${r * 0.34}" r="${h * 0.4}" opacity=".7"/></g>`;
/** The crease of shadow where an eye meets the fur, and the highlight that stays on the eyeball. */
const crease = (rx, ry) => `<ellipse class="eao" rx="${rx * 1.32}" ry="${ry * 1.32}"/>`;
const gloss = (rx, ry) =>
  `<ellipse class="espec" cx="${-rx * 0.34}" cy="${-ry * 0.4}" rx="${rx * 0.5}" ry="${ry * 0.38}" transform="rotate(-28 ${-rx * 0.34} ${-ry * 0.4})"/>`;
const STAR =
  "M-1,-5.2 Q0,-7.6 1,-5.2 Q2,-2.8 4.6,-2.5 Q7.2,-2.3 5.2,-.6 Q3.2,1.1 3.9,3.6 Q4.5,6.1 2.2,4.8 Q0,3.4 -2.2,4.8 Q-4.5,6.1 -3.9,3.6 Q-3.2,1.1 -5.2,-.6 Q-7.2,-2.3 -4.6,-2.5 Q-2,-2.8 -1,-5.2 Z";

/** Eyes: their half height, and whether there is one, it sits on top, or it has a pupil. */
export const EYES = {
  dots: {
    height: 5.6,
    draw: () =>
      `${crease(4.6, 5.6)}<ellipse class="eink" rx="4.6" ry="5.6"/>${gloss(4.6, 5.6)}<circle class="wht" cx="-1.5" cy="-2.4" r="1.1"/>`,
  },
  pills: {
    height: 7.5,
    draw: () =>
      `${crease(3.8, 7.6)}<rect class="eink" x="-3.4" y="-7.5" width="6.8" height="15" rx="3.4"/><rect class="wht" x="-2.1" y="-6" width="1.5" height="4.2" rx=".75" opacity=".9"/>`,
  },
  shine: {
    height: 6.5,
    draw: () =>
      `${crease(6.5, 6.5)}<circle class="eink" r="6.5"/>${gloss(6.5, 6.5)}<circle class="wht" cx="-2.2" cy="-2.5" r="1.9"/><circle class="wht" cx="2.3" cy="2.4" r=".8" opacity=".7"/>`,
  },
  marbles: {
    height: 8,
    pupil: true,
    draw: () => `${crease(8, 8)}<circle class="scl" r="8"/>${pupil(4.2, 1.3)}${gloss(8, 8)}`,
  },
  cyclops: {
    height: 12.5,
    one: true,
    pupil: true,
    draw: () =>
      `${crease(12.5, 12.5)}<circle class="scl" r="12.5"/>${pupil(6.6, 2.1)}${gloss(12.5, 12.5)}`,
  },
  "half-moon": {
    height: 5,
    draw: () =>
      `${crease(6.5, 4.5)}<path class="eink" d="M-6.5,-1.5 H6.5 A6.5,6.5 0 0 1 -6.5,-1.5 Z"/><circle class="wht" cx="-2.6" cy="1.4" r="1.3"/>`,
  },
  frog: {
    height: 9.5,
    top: true,
    wide: 4,
    pupil: true,
    draw: () =>
      `${crease(9.5, 9.5)}<circle class="scl" r="9.5"/>${pupil(4.8, 1.5)}${gloss(9.5, 9.5)}`,
  },
  stars: {
    height: 6.4,
    draw: () =>
      `${crease(6.2, 6.2)}<path class="eink" d="${STAR}"/><circle class="wht" cx="-1.4" cy="-1.6" r="1.1"/>`,
  },
  big: {
    height: 8,
    draw: () =>
      `${crease(5.8, 8)}<ellipse class="eink" rx="5.8" ry="8"/>${gloss(5.8, 8)}<circle class="wht" cx="-2" cy="-3.4" r="2.2"/><circle class="wht" cx="2" cy="3" r="1" opacity=".75"/>`,
  },
  buttons: {
    height: 6.2,
    draw: () =>
      `${crease(6.2, 6.2)}<circle class="eink" r="6.2"/><circle class="btn-r" r="4.3"/>${[
        [-1.5, -1.5],
        [1.5, -1.5],
        [-1.5, 1.5],
        [1.5, 1.5],
      ]
        .map(([x, y]) => `<circle class="btn-h" cx="${x}" cy="${y}" r=".95"/>`)
        .join("")}${gloss(6.2, 6.2)}`,
  },
};

/** What sits on the head, and the accessories: each type with its variations. */
export const HEADS = {
  none: [],
  ears: ["pointed", "floppy", "round"],
  horns: ["two", "one", "antennae"],
  hair: ["strands", "curl", "mohawk"],
  leaves: ["one", "two", "kelp"],
};
export const ACCESSORIES = {
  none: [],
  glasses: ["round", "dark"],
  bow: ["tie", "head"],
  hat: ["beret", "top", "beanie"],
  belt: ["belt", "collar"],
};

const LEAVES = {
  one: ["M0,8 C-2,0 -1,-8 3,-16 C9,-10 8,-2 0,8 Z"],
  two: ["M-1,8 C-3,-1 -9,-5 -7,-17 C0,-12 3,-3 -1,8 Z", "M1,8 C2,0 8,-3 11,-11 C4,-10 0,-4 1,8 Z"],
  kelp: ["M-2,8 C-6,0 2,-6 -2,-14 C-6,-22 2,-28 6,-34 C8,-26 2,-22 5,-14 C8,-6 2,0 3,8 Z"],
};
const LEAF_BOX = { one: [-7, -21, 19, 32], two: [-12, -22, 27, 33], kelp: [-10, -38, 20, 49] };
const LEAF_VEIN = {
  one: '<path class="vein" d="M.6,6 Q2.4,-3 3,-13"/>',
  two: '<path class="vein" d="M-1.2,6 Q-3.4,-4 -6.4,-14 M1.4,6 Q3.6,-2 9,-9"/>',
  kelp: '<path class="vein" d="M.4,6 Q2,-6 -.6,-14 Q-2.4,-22 4,-31"/>',
};

const MITT =
  "M-4.6,-5.6 C-4.6,-9 4.6,-9 4.6,-5.6 V3.4 C4.6,7.4 -4.6,7.4 -4.6,3.4 Z M3.4,-1.6 C7.6,-3 9.6,1.8 5,3.8 Z";

/** The badge's icon per activity, at roster size. */
const ICONS = {
  search: '<circle cx="-1.2" cy="-1.2" r="3.6"/><path d="M1.6,1.6 L5,5"/>',
  vault: '<path d="M-4.5,4.5 L3,-3 L5,-1 L-2.5,6.5 Z"/>',
  code: '<path d="M-2,-4.5 L-6,0 L-2,4.5 M2,-4.5 L6,0 L2,4.5"/>',
  calendar: '<rect x="-5" y="-4" width="10" height="9" rx="1.4"/><path d="M-5,-1 H5"/>',
  email: '<rect x="-6" y="-4" width="12" height="8" rx="1.2"/><path d="M-6,-3.5 L0,1 L6,-3.5"/>',
  think: '<path class="dots" d="M-4,0 h.01 M0,0 h.01 M4,0 h.01"/>',
};

/**
 * Whether the page can draw this mascot: every axis one of its own options. The runtime validated
 * it already; a frame that isn't one is ignored, so nothing unknown reaches the markup.
 */
export function isDrawable(mascot) {
  if (typeof mascot !== "object" || mascot === null) return false;
  const part = (types, value) => {
    if (typeof value !== "object" || value === null || !Object.hasOwn(types, value.type)) {
      return false;
    }
    const variations = types[value.type];
    return variations.length === 0
      ? value.variation === undefined
      : variations.includes(value.variation);
  };
  return (
    Object.hasOwn(SHAPES, mascot.shape) &&
    COLORS.includes(mascot.color) &&
    Object.hasOwn(EYES, mascot.eyes) &&
    typeof mascot.cheeks === "boolean" &&
    part(HEADS, mascot.head) &&
    part(ACCESSORIES, mascot.accessory)
  );
}

/** The mascot's size class: the roster's 36 px, the header's 48 px, or the 160 px of a profile. */
export function sizeOf(px) {
  if (px <= 40) return "s";
  return px <= 88 ? "m" : "l";
}

/**
 * The SVG of one mascot, and its fur pieces: each piece's flat shapes, the box it is painted in,
 * the fur's flow and its strand length. `work` adds the task's objects, `hands` the mittens.
 */
export function buildMascot(mascot, { uid, px, hex, work = true, hands = true }) {
  const shape = SHAPES[mascot.shape];
  const eye = EYES[mascot.eyes];
  const color = palette(hex);
  const size = sizeOf(px);
  const [fx, fy] = shape.face;
  const [tx, ty] = shape.top;
  const k = eye.one ? 1.6 : 1;
  const strokeK = eye.one ? 1.3 : 1;
  const eyeY = eye.top ? ty + 13 : fy;
  const spread = shape.spread + (eye.wide ?? 0);
  const eyes = eye.one
    ? [[fx, eyeY - 2]]
    : [
        [fx - spread, eyeY],
        [fx + spread, eyeY],
      ];
  const pieces = [];
  const flat = (part) =>
    part.width
      ? `<path d="${part.d}" fill="none" stroke="${part.fill}" stroke-width="${part.width}" stroke-linecap="round"/>`
      : `<path d="${part.d}" fill="${part.gradient ? `url(#mg${uid})` : part.fill}"${part.alpha === undefined ? "" : ` fill-opacity="${part.alpha}"`}/>`;
  const piece = (shapes, box, flow, length) => {
    pieces.push({ shapes, box, flow, length });
    return `<g class="fp" data-piece="${pieces.length - 1}"><g class="fpv">${shapes.map(flat).join("")}</g><image class="fpi" x="${box[0]}" y="${box[1]}" width="${box[2]}" height="${box[3]}" preserveAspectRatio="none" display="none"/></g>`;
  };
  const atEars = (draw) => shape.ears.map(([x, y, a]) => draw(x, y, a)).join("");
  const head = mascot.head.type;
  const headVariation = mascot.head.variation;
  const accessory = mascot.accessory.type;
  const accessoryVariation = mascot.accessory.variation;
  // A hat hides what sits in the middle of the head.
  const hat = accessory === "hat";
  let backHard = "";
  let backEars = "";
  let frontEars = "";
  let mohawk = null;
  if (head === "ears" && headVariation === "pointed") {
    backEars = atEars(
      (x, y, a) =>
        `<g transform="translate(${x} ${y}) rotate(${a})"><g class="m-ear">${piece(
          [
            { d: "M-10,8 Q-7,-13 0,-21 Q7,-13 10,8 Z", fill: color.body },
            { d: "M-5,5 Q-3,-7 0,-13 Q3,-7 5,5 Z", fill: color.dark, alpha: 0.45 },
          ],
          [-16, -28, 32, 42],
          [0, -0.7],
          0.85,
        )}</g></g>`,
    );
  }
  if (head === "ears" && headVariation === "round") {
    backEars = atEars(
      (x, y, a) =>
        `<g transform="translate(${x + Math.sign(a) * 3} ${y - 3})"><g class="m-ear">${piece(
          [
            { d: circle(0, 0, 10.5), fill: color.body },
            { d: circle(0, 1, 5.5), fill: color.dark, alpha: 0.45 },
          ],
          [-17, -17, 34, 34],
          [0, 0.2],
          0.85,
        )}</g></g>`,
    );
  }
  if (head === "ears" && headVariation === "floppy") {
    frontEars = atEars(
      (x, y, a) =>
        `<g transform="translate(${x} ${y + 2}) scale(${a < 0 ? 1 : -1} 1)"><g class="m-ear m-flop">${piece(
          [
            {
              d: "M4,-4 C-6,-6 -15,2 -15,14 C-15,24 -9,30 -4,26 C0,22 2,12 6,4 Z",
              fill: color.darkish,
            },
          ],
          [-21, -10, 31, 42],
          [0, 0.7],
          0.85,
        )}</g></g>`,
    );
  }
  if (head === "horns" && headVariation === "two") {
    backHard = atEars(
      (x, y, a) =>
        `<g transform="translate(${x + Math.sign(a) * 2} ${y + 2}) rotate(${a * 0.7}) scale(${a < 0 ? -1 : 1} 1)"><path class="horn" d="M-5.5,6 Q-5,-6 1,-15 Q5,-5 5.5,6 Z"/><path class="hornl" d="M-4.6,1.4 Q0,3 4.8,1.4 M-3.8,-4 Q.4,-2.8 4,-4.2 M-2.4,-9 Q.8,-8.2 3,-9.4"/><path class="hornhi" d="M-2.8,4 Q-3,-5.5 .4,-12"/></g>`,
    );
  }
  if (!hat) {
    if (head === "horns" && headVariation === "one") {
      backHard = `<g transform="translate(${tx} ${ty + 4})"><path class="horn" d="M-6,6 Q-3,-8 0,-22 Q3,-8 6,6 Z"/><path class="hornl" d="M-4.6,-1 Q0,.4 4.8,-3 M-3.2,-8 Q.4,-6.8 3.6,-10 M-1.8,-14.6 Q.6,-13.8 2.4,-16.4"/><path class="hornhi" d="M-3.6,4 Q-2.6,-8 -.6,-17"/></g>`;
    }
    if (head === "horns" && headVariation === "antennae") {
      backHard = [-1, 1]
        .map(
          (s) =>
            `<g transform="translate(${tx + s * 9} ${ty + 6})"><g class="m-ant"><path class="ant" d="M0,4 Q${s * 2},-8 ${s * 7},-16"/><path class="anthi" d="M${-s * 0.6},3 Q${s * 1.2},-8 ${s * 6.2},-15"/><circle cx="${s * 7}" cy="-17" r="4.4" fill="url(#mg${uid})"/><g transform="translate(${s * 7} -17)">${gloss(4.4, 4.4)}</g><circle class="wht" cx="${s * 7 - 1.5}" cy="-18.6" r="1.1"/></g></g>`,
        )
        .join("");
    }
    if (head === "hair" && headVariation === "strands") {
      backHard = `<g transform="translate(${tx} ${ty})"><g class="m-leaf">${piece(
        [
          { d: "M-7,8 Q-9,-3 -14,-6", width: 4.8, fill: color.darkish },
          { d: "M0,8 Q-1,-5 3,-12", width: 4.8, fill: color.darkish },
          { d: "M7,8 Q10,-2 15,-3", width: 4.8, fill: color.darkish },
        ],
        [-19, -17, 38, 30],
        [0, -0.5],
        0.5,
      )}</g></g>`;
    }
    if (head === "hair" && headVariation === "curl") {
      backHard = `<g transform="translate(${tx} ${ty})"><g class="m-leaf">${piece(
        [
          {
            d: "M0,8 C-1,-2 2,-10 9,-11 C15,-12 17,-5 13,-2 C9,1 5,-3 8,-6",
            width: 4.6,
            fill: color.darkish,
          },
        ],
        [-6, -16, 26, 28],
        [0, -0.4],
        0.5,
      )}</g></g>`;
    }
    if (head === "hair" && headVariation === "mohawk") {
      const points = [
        [-16, 10],
        [-13, -5],
        [-8, 6],
        [-4, -9],
        [0, 5],
        [4, -9],
        [8, 6],
        [13, -5],
        [16, 10],
      ];
      mohawk = {
        d: `M${points.map(([x, y]) => `${tx + x},${ty + y}`).join(" L")} Z`,
        fill: color.darkish,
      };
    }
    if (head === "leaves") {
      const leaf = mix("#3D8B5A", color.body, 0.3);
      backHard = `<g transform="translate(${tx} ${ty})"><g class="m-leaf">${piece(
        LEAVES[headVariation].map((d) => ({ d, fill: leaf })),
        LEAF_BOX[headVariation],
        [0, -0.6],
        0.45,
      )}${LEAF_VEIN[headVariation]}</g></g>`;
    }
  }
  const body = piece(
    [
      ...(mohawk ? [mohawk] : []),
      { d: shape.d, fill: color.body, gradient: true },
      // The frog's eyes sit on bumps of the body.
      ...(mascot.eyes === "frog"
        ? eyes.map(([x, y]) => ({ d: circle(x, y + 1, 12.5), fill: color.body }))
        : []),
    ],
    [0, 0, 120, 120],
    [0, 0.55],
  );
  const [cx, cy] = shape.collar;
  let lower = "";
  let glasses = "";
  let onTop = "";
  const band = (y) =>
    `<g clip-path="url(#mc${uid})"><path class="strap" d="M0,${y - 4} Q60,${y + 3} 120,${y - 4} V${y + 2.5} Q60,${y + 9.5} 0,${y + 2.5} Z"/><path class="strap-hl" d="M0,${y - 3.4} Q60,${y + 3.6} 120,${y - 3.4}"/><path class="stitch" d="M0,${y - 0.7} Q60,${y + 6.3} 120,${y - 0.7}"/></g>`;
  if (accessory === "belt" && accessoryVariation === "collar") {
    lower = `${band(cy)}<circle class="ring" cx="${cx}" cy="${cy + 6}" r="2"/><ellipse class="csh" cx="${cx + 0.8}" cy="${cy + 13}" rx="5.6" ry="3.4"/><circle class="tagc" cx="${cx}" cy="${cy + 11}" r="4.6"/><g transform="translate(${cx} ${cy + 11})">${gloss(4.6, 4.6)}</g>`;
  }
  if (accessory === "belt" && accessoryVariation === "belt") {
    lower = `${band(cy + 3)}<rect class="buckle" x="${cx - 5}" y="${cy + 1.3}" width="10" height="9" rx="1.6"/><path class="hl" d="M${cx - 3.6},${cy + 2.6} H${cx + 2}"/>`;
  }
  if (accessory === "bow" && accessoryVariation === "tie") {
    lower = `<g transform="translate(${cx} ${cy + 3})"><ellipse class="csh" cx="1" cy="5" rx="14" ry="3.6"/><path class="gloss" d="M0,0 L-11,-6.5 Q-13.5,0 -11,6.5 Z"/><path class="gloss" d="M0,0 L11,-6.5 Q13.5,0 11,6.5 Z"/><path class="hl" d="M-9.6,-4 Q-11.2,-.6 -10.2,2.6 M9.4,-4.4 Q10.6,-2 10.2,0"/><rect class="gloss" x="-3" y="-3.4" width="6" height="6.8" rx="2"/><path class="hl" d="M-1.4,-2.2 H1.2"/></g>`;
  }
  if (accessory === "bow" && accessoryVariation === "head") {
    const [x, y] = shape.ears[0];
    onTop = `<g transform="translate(${x + 3} ${y + 3}) rotate(-20)"><g class="bow"><ellipse class="csh" cx="1" cy="5" rx="13" ry="3.4"/><path class="satin" d="M0,0 C-5,-9 -15,-8 -13,0 C-12,7 -4,5 0,0 Z"/><path class="satin" d="M0,0 C5,-9 15,-8 13,0 C12,7 4,5 0,0 Z"/><path class="hl" d="M-11.4,-2 Q-9.6,-6.4 -5,-5.6 M11.4,-2 Q9.6,-6.4 5,-5.6"/><circle class="knot" r="2.8"/><circle class="wht" cx="-.8" cy="-.9" r=".7" opacity=".7"/></g></g>`;
  }
  if (hat) {
    // Hats are felt and knit, so they are painted like the plush.
    const [hx, hy, hw] = shape.hat;
    const felt = "#2C3332";
    const knit = mix(color.body, INK, 0.55);
    const knitBand = mix(color.body, INK, 0.4);
    if (accessoryVariation === "beret") {
      onTop = `<g transform="translate(${hx} ${hy}) rotate(-12)"><ellipse class="csh" cx="-1" cy="${hw * 0.14}" rx="${hw * 0.52}" ry="${hw * 0.1}"/>${piece(
        [
          { d: ellipse(-2, -3, hw * 0.56, hw * 0.2), fill: felt },
          {
            d: `M-1.8,${-2 - hw * 0.2} L-1.6,${-6.5 - hw * 0.2} Q0,${-8 - hw * 0.2} 1.6,${-6.5 - hw * 0.2} L1.8,${-2 - hw * 0.2} Z`,
            fill: felt,
          },
        ],
        [-hw * 0.62 - 4, -hw * 0.2 - 12, hw * 1.24 + 8, hw * 0.4 + 18],
        [0, 0.2],
        0.45,
      )}</g>`;
    }
    if (accessoryVariation === "top") {
      onTop = `<g transform="translate(${hx} ${hy})"><ellipse class="csh" cx="0" cy="3.4" rx="${hw * 0.52}" ry="3.2"/>${piece(
        [
          { d: rounded(-hw * 0.3, -22, hw * 0.6, 22, [2.5, 2.5, 0, 0]), fill: felt },
          { d: ellipse(0, 0, hw * 0.5, 3.4), fill: felt },
          { d: rounded(-hw * 0.3, -7.5, hw * 0.6, 5, [0, 0, 0, 0]), fill: color.light },
        ],
        [-hw * 0.55 - 3, -26, hw * 1.1 + 6, 33],
        [0, 0.2],
        0.3,
      )}</g>`;
    }
    if (accessoryVariation === "beanie") {
      onTop = `<g transform="translate(${hx} ${hy})"><ellipse class="csh" cx="0" cy="6" rx="${hw * 0.52}" ry="2.8"/>${piece(
        [
          {
            d: `M${-hw * 0.52},3 C${-hw * 0.52},${-hw * 0.5} ${hw * 0.52},${-hw * 0.5} ${hw * 0.52},3 Z`,
            fill: knit,
          },
          { d: rounded(-hw * 0.55, -1, hw * 1.1, 7, [3.5, 3.5, 3.5, 3.5]), fill: knitBand },
          { d: circle(0, -hw * 0.38 - 3, Math.max(4, hw * 0.1)), fill: color.light },
        ],
        [-hw * 0.6 - 3, -hw * 0.5 - 10, hw * 1.2 + 6, hw * 0.5 + 20],
        [0, 0.2],
        0.55,
      )}</g>`;
    }
  }
  if (accessory === "glasses") {
    const r = eye.height + 3.6;
    const lens = accessoryVariation === "dark" ? "lens-d" : "lens";
    glasses =
      eyes
        .map(
          ([x, y]) =>
            `<ellipse class="csh" cx="${x + 1.2}" cy="${y + r * 0.75}" rx="${r * 0.95}" ry="${r * 0.4}"/>`,
        )
        .join("") +
      eyes
        .map(
          ([x, y]) =>
            `<circle class="${lens}" cx="${x}" cy="${y}" r="${r}"/><path class="hl" d="M${x - r * 0.62},${y - r * 0.1} Q${x - r * 0.5},${y - r * 0.62} ${x - r * 0.02},${y - r * 0.7}"/><path class="hl thin" d="M${x + r * 0.3},${y + r * 0.55} Q${x + r * 0.55},${y + r * 0.3} ${x + r * 0.62},${y}"/>`,
        )
        .join("");
    if (!eye.one) {
      glasses += `<path class="frame" d="M${eyes[0][0] + r},${eyes[0][1] - 1} Q${fx},${eyes[0][1] - 5} ${eyes[1][0] - r},${eyes[1][1] - 1}"/>`;
    }
    glasses = `<g class="m-glasses">${glasses}</g>`;
  }
  const handColor = mix(color.body, "#ffffff", 0.3);
  const mittShadow = '<ellipse class="csh" cx="1.5" cy="6.5" rx="8.5" ry="3.6"/>';
  const mittPiece = () => piece([{ d: MITT, fill: handColor }], [-9, -12, 20, 22], [0, 0.35], 0.5);
  const mitt = (x, y, a, flip) =>
    `<g class="mitt" transform="translate(${x} ${y}) rotate(${a})${flip ? " scale(-1 1)" : ""}">${mittShadow}${mittPiece()}</g>`;
  const workSvg =
    !work || size === "s"
      ? ""
      : `<g transform="translate(${fx + 23} ${fy + 27}) scale(1.4)"><g class="m-work">${[
          `<g class="act act-search"><g class="aw w-lens"><path class="p-handle" d="M4.8,4.8 L10.5,10.5"/><circle class="p-glass" r="7"/><path class="p-glint" d="M-4,-2 Q-3,-4.6 -.4,-5"/>${mitt(12, 12.5, -40)}</g></g>`,
          `<g class="act act-vault"><ellipse class="csh" cx="1" cy="12" rx="13" ry="3"/><g transform="rotate(-6)"><rect class="p-paper" x="-9" y="-11" width="18" height="22" rx="2"/>${[
            [-5, -5, 5],
            [-5, 0, 5],
            [-5, 5, 2],
          ]
            .map(([x0, y0, x1]) => `<path class="p-line" pathLength="1" d="M${x0},${y0} H${x1}"/>`)
            .join(
              "",
            )}</g>${mitt(-10, 10, 25, true)}<g class="aw w-pen"><g transform="translate(3 -4) rotate(32)"><rect class="p-pencil" x="-1.7" y="-12" width="3.4" height="12" rx="1"/><path class="p-tip" d="M-1.7,0 L0,3.6 L1.7,0 Z"/></g>${mitt(10, -6, -30)}</g></g>`,
          `<g class="act act-code"><ellipse class="csh" cx="1" cy="12" rx="13" ry="3"/><rect class="p-screen" x="-10" y="-10" width="20" height="14" rx="1.6"/>${[
            [-7, -6, 2],
            [-5, -3, 5],
            [-7, 0, 0],
          ]
            .map(([x0, y0, x1]) => `<path class="p-code" pathLength="1" d="M${x0},${y0} H${x1}"/>`)
            .join(
              "",
            )}<path class="p-base" d="M-13,4.5 H13 L11,8.5 H-11 Z"/><g class="aw w-kl">${mitt(-6, 10, 15, true)}</g><g class="aw w-kr">${mitt(6, 10, -15)}</g></g>`,
          `<g class="act act-calendar"><ellipse class="csh" cx="1" cy="12" rx="13" ry="3"/><g class="aw w-page"><rect class="p-paper" x="-9" y="-10" width="18" height="20" rx="2"/><path class="p-band" d="M-9,-6 V-8 Q-9,-10 -7,-10 H7 Q9,-10 9,-8 V-6 Z"/>${[
            -5, 0, 5,
          ]
            .map((x0) =>
              [-1, 3, 7]
                .map(
                  (y0) =>
                    `<rect class="p-cell" x="${x0 - 1.4}" y="${y0 - 1.4}" width="2.8" height="2.8" rx=".6"/>`,
                )
                .join(""),
            )
            .join(
              "",
            )}<path class="p-check" pathLength="1" d="M-4,2.5 L-1,5.5 L5,-1.5"/></g>${mitt(-11, -5, -15, true)}<g class="aw w-stamp">${mitt(10, 0, -20)}</g></g>`,
          `<g class="act act-email"><ellipse class="csh" cx="1" cy="12" rx="13" ry="3"/><g class="aw w-env"><rect class="p-paper" x="-9" y="-6" width="18" height="12" rx="1.5"/><path class="p-flap" d="M-9,-5.5 L0,1 L9,-5.5"/></g><g class="aw w-er">${mitt(11, 5, -25)}</g></g>`,
        ].join("")}</g></g>`;
  const handsSvg =
    hands && size !== "s"
      ? ["l", "r"]
          .map(
            (side) =>
              `<g class="hand hand-${side}"><g class="hg"><g${side === "l" ? ' transform="scale(-1 1)"' : ""}>${mittShadow}${mittPiece()}</g></g></g>`,
          )
          .join("")
      : "";
  const cheekAt = eye.one
    ? [
        [fx - 18, fy + 11],
        [fx + 18, fy + 11],
      ]
    : [
        [fx - spread - 8, eyeY + 8],
        [fx + spread + 8, eyeY + 8],
      ];
  const cheeks = mascot.cheeks
    ? cheekAt.map(([x, y]) => `<ellipse class="chk" cx="${x}" cy="${y}" rx="7" ry="4.6"/>`).join("")
    : "";
  const shadowR = eye.height * k * (eye.one ? 0.7 : 1);
  const eyeSvg = eyes
    .map(
      ([x, y]) =>
        `<g transform="translate(${x} ${y})"><g class="m-eyeW"><g class="m-eyeP"><g class="m-blink"><g class="e-open sw"><ellipse class="esh" cx=".6" cy="1.8" rx="${shadowR + 2.6}" ry="${shadowR + 2}"/>${eye.draw()}</g><path class="e-happy sw stk" stroke-width="${3 * strokeK}" d="M${-6.5 * k},${2.5 * k} Q0,${-6 * k} ${6.5 * k},${2.5 * k}"/><path class="e-closed sw stk" stroke-width="${2.8 * strokeK}" d="M${-6.5 * k},0 Q0,${4.5 * k} ${6.5 * k},0"/></g></g></g></g>`,
    )
    .join("");
  const brows = eyes
    .map(
      ([x, y]) =>
        `<g transform="translate(${x} ${y - eye.height - (eye.one ? 7 : 6)})"><g class="m-brow"><path class="stk" stroke-width="3.2" d="M${eye.one ? -8 : -5},0 H${eye.one ? 8 : 5}"/></g></g>`,
    )
    .join("");
  const mouthY = fy + (eye.one ? 15 : (shape.mouth ?? 13));
  const mouth = `<g class="m-mouth" transform="translate(${fx} ${mouthY})"><g class="mo-o-w"><ellipse class="mo-o sw ink" rx="2.8" ry="3.3"/></g><path class="mo-smile sw stk" stroke-width="2.8" d="M-5.5,-1.5 Q0,4.5 5.5,-1.5"/><path class="mo-wave sw stk" stroke-width="2.6" d="M-6,0.5 Q-3,-2.5 0,0.5 T6,0.5"/></g>`;
  const effects =
    `<g class="fx-bub sw">${[
      [24, -3, 3.2],
      [32, -14, 4.4],
      [39, -27, 5.6],
    ]
      .map(([dx, dy, r]) => `<circle class="bub" cx="${tx + dx}" cy="${ty + dy}" r="${r}"/>`)
      .join("")}</g>` +
    `<g class="fx-spark sw">${[
      [-32, 6, 1],
      [33, -4, 0.8],
      [2, -17, 0.7],
    ]
      .map(
        ([dx, dy, s]) =>
          `<g transform="translate(${tx + dx} ${ty + dy}) scale(${s})"><g class="star-a"><path class="star" d="M0,-8 Q1.4,-1.4 8,0 Q1.4,1.4 0,8 Q-1.4,1.4 -8,0 Q-1.4,-1.4 0,-8 Z"/></g></g>`,
      )
      .join("")}</g>` +
    `<g class="fx-zzz sw"><text class="zz" x="${tx + 22}" y="${ty - 2}" font-size="15">z</text><text class="zz" x="${tx + 32}" y="${ty - 12}" font-size="11">z</text></g>` +
    `<g transform="translate(${fx + spread + 9} ${eyeY - 9})"><path class="drop" d="M0,-6 C3,-2 4.5,1 4.5,3 A4.5,4.5 0 0 1 -4.5,3 C-4.5,1 -3,-2 0,-6 Z"/></g>`;
  // At 36 px a glossy badge stands in for the bubble (ADR-0045 §9).
  const badge =
    size === "s"
      ? `<g transform="translate(99 98)"><g class="m-bdw"><circle class="bd-ring" r="12"/><g class="bd-dot"><circle class="bd-c" r="12"/><ellipse class="bd-hl" cx="-4" cy="-5" rx="4.6" ry="2.6" transform="rotate(-25 -4 -5)"/><text class="bd-g" y="5.6" text-anchor="middle"></text><g class="bd-ico">${Object.entries(
          ICONS,
        )
          .map(([name, d]) => `<g class="ico ico-${name}">${d}</g>`)
          .join("")}</g></g></g></g>`
      : `<g transform="translate(${fx + spread + 25} ${ty - 9}) scale(${size === "m" ? 1.6 : 1.4})"><g class="m-bdw speech"><g class="bd-bob"><g class="bd-dot"><path class="bd-c bub3d" d="M0,-11 C7,-11 11,-7 11,-2 C11,3.5 7,7 1,7 L-5,11.5 L-3.6,6.2 C-8.5,5 -11,2 -11,-2 C-11,-7 -7,-11 0,-11 Z"/><ellipse class="bd-hl" cx="-4.6" cy="-6.2" rx="4.4" ry="2.1" transform="rotate(-20 -4.6 -6.2)"/><text class="bd-g" y="3" text-anchor="middle"></text></g></g></g></g>`;
  const html =
    `<svg class="mascot" viewBox="10 14 100 100" width="${px}" height="${px}" data-size="${size}" data-eyes="open" data-mouth="none" data-brows="none" data-fx="none" data-badge="none" aria-hidden="true" focusable="false">` +
    `<defs><clipPath id="mc${uid}"><path d="${shape.d}"/></clipPath><radialGradient id="mg${uid}" cx=".36" cy=".3" r=".85"><stop offset="0" stop-color="${color.light}"/><stop offset=".55" stop-color="${color.body}"/><stop offset="1" stop-color="${color.edge}"/></radialGradient></defs>` +
    '<ellipse class="m-shadow" cx="60" cy="111" rx="30" ry="3.6"/>' +
    `<g class="m-hop g"><g class="m-breath g"><g class="m-sq g"><g class="m-pose g">${backHard}${backEars}${body}${frontEars}${lower}` +
    `<g class="m-face">${cheeks}${eyeSvg}${glasses}<g class="m-brows">${brows}</g>${mouth}</g>${workSvg}${onTop}${handsSvg}${effects}</g></g></g></g>` +
    `${badge}</svg>`;
  return {
    html,
    pieces,
    size,
    anchors: { fx, fy, spread, tx, ty, ear: head === "ears" ? shape.ears[1] : null },
  };
}

/** Where a mitten goes, as [x, y, rotation, scale] on the 120 grid; the left one is mirrored. */
export function handSpot(name, { fx, fy, spread: es, tx, ty, ear }) {
  const s = 1.4;
  const spots = {
    dockL: [fx - es - 8, fy + 20, 25, 0.3],
    dockR: [fx + es + 8, fy + 20, -25, 0.3],
    waveR: [fx + es + 18, fy - 6, 8, s],
    waveL: [fx - es - 18, fy - 6, -8, s],
    upR: [fx + es + 12, ty - 2, -12, s],
    upL: [fx - es - 12, ty - 2, 12, s],
    ear: ear ? [ear[0] + 9, ear[1] + 9, -35, s] : [fx + es + 15, fy - 7, -35, s],
    thumbR: [fx + es + 16, fy + 9, -90, s],
    thumbL: [fx - es - 16, fy + 9, 90, s],
    cheekR: [fx + es + 8, fy + 10, -18, s],
    cheekL: [fx - es - 8, fy + 10, 18, s],
    pillowR: [fx + es + 7, fy + 15, -100, s],
    typeR: [fx + 9, fy + 25, 175, s * 0.9],
    typeL: [fx - 9, fy + 25, -175, s * 0.9],
    mouthR: [fx + 2, fy + 15, -25, s * 0.9],
    headR: [tx + 15, ty + 9, -45, s],
    browR: [fx + es + 12, fy - 13, -80, s],
    browSweep: [fx - es + 4, fy - 14, -80, s],
    eyeR: [fx + es + 2, fy + 3, -30, s * 0.9],
    eyeL: [fx - es - 2, fy + 3, 30, s * 0.9],
    chinR: [fx + 4, fy + 20, -100, s],
    pleaseR: [fx + 4, fy + 19, -20, s],
    pleaseL: [fx - 4, fy + 19, 20, s],
    cardL: [fx - es - 15, fy + 15, -60, s],
    clapR: [fx + 8, fy + 22, -10, s],
    clapL: [fx - 8, fy + 22, 10, s],
  };
  return spots[name] ?? null;
}

/**
 * The gradients every mascot shares, once per page. Their stops take their colors from classes
 * in mascot.css where a theme token sets them.
 */
export const SHARED_DEFS = `<defs>
<radialGradient id="kg-sclera" cx=".38" cy=".3" r=".8"><stop offset="0" stop-color="#FFFFFF"/><stop offset=".45" stop-color="#F4F6F5"/><stop offset=".8" stop-color="#D2DAD8"/><stop offset="1" stop-color="#A7B3B0"/></radialGradient>
<radialGradient id="kg-bead" cx=".34" cy=".28" r=".85"><stop offset="0" stop-color="#5A6060"/><stop offset=".42" stop-color="#151818"/><stop offset="1" stop-color="#000000"/></radialGradient>
<radialGradient id="kg-ao"><stop offset=".7" stop-color="#0C2523" stop-opacity="0"/><stop offset=".82" stop-color="#0C2523" stop-opacity=".42"/><stop offset="1" stop-color="#0C2523" stop-opacity="0"/></radialGradient>
<radialGradient id="kg-esh"><stop offset=".55" stop-color="#0C2523" stop-opacity=".32"/><stop offset="1" stop-color="#0C2523" stop-opacity="0"/></radialGradient>
<radialGradient id="kg-spec"><stop offset="0" stop-color="#FFFFFF" stop-opacity=".75"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>
<radialGradient id="kg-wait" cx=".35" cy=".28" r=".85"><stop offset="0" class="kg-warm-1"/><stop offset=".55" class="kg-warm-2"/><stop offset="1" class="kg-warm-3"/></radialGradient>
<radialGradient id="kg-err" cx=".35" cy=".28" r=".85"><stop offset="0" class="kg-danger-1"/><stop offset=".55" class="kg-danger-2"/><stop offset="1" class="kg-danger-3"/></radialGradient>
<radialGradient id="kg-acc" cx=".35" cy=".28" r=".85"><stop offset="0" class="kg-accent-1"/><stop offset=".55" class="kg-accent-2"/><stop offset="1" class="kg-accent-3"/></radialGradient>
<radialGradient id="kg-shadow"><stop offset=".25" stop-color="#0C2523" stop-opacity=".38"/><stop offset="1" stop-color="#0C2523" stop-opacity="0"/></radialGradient>
<radialGradient id="kg-gloss" cx=".32" cy=".28" r=".85"><stop offset="0" stop-color="#5B6866"/><stop offset=".45" stop-color="#1A2120"/><stop offset="1" stop-color="#030505"/></radialGradient>
<radialGradient id="kg-metal" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#FFFFFF"/><stop offset=".5" stop-color="#D3DCDA"/><stop offset="1" stop-color="#7F8E8B"/></radialGradient>
<radialGradient id="kg-satin" cx=".4" cy=".3" r=".8"><stop offset="0" stop-color="#FFC2D5"/><stop offset=".5" stop-color="#E8709A"/><stop offset="1" stop-color="#A3365E"/></radialGradient>
<linearGradient id="kg-lens" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFFFFF" stop-opacity=".5"/><stop offset=".45" stop-color="#FFFFFF" stop-opacity=".1"/><stop offset=".55" stop-color="#FFFFFF" stop-opacity=".26"/><stop offset="1" stop-color="#FFFFFF" stop-opacity=".04"/></linearGradient>
<linearGradient id="kg-lensd" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4C5856"/><stop offset=".5" stop-color="#121918"/><stop offset="1" stop-color="#000000"/></linearGradient>
<linearGradient id="kg-frame" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#55605E"/><stop offset="1" stop-color="#080B0A"/></linearGradient>
<linearGradient id="kg-strap" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3D4B49"/><stop offset=".5" stop-color="#17211F"/><stop offset="1" stop-color="#070C0B"/></linearGradient>
<radialGradient id="kg-blush"><stop offset="0" stop-color="#F06A86" stop-opacity=".55"/><stop offset="1" stop-color="#F06A86" stop-opacity="0"/></radialGradient>
<linearGradient id="kg-horn" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#FBF5E8"/><stop offset=".5" stop-color="#E8D9B8"/><stop offset="1" stop-color="#AE956A"/></linearGradient>
<linearGradient id="kg-paper" x1="0" y1="0" x2=".3" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#DCE4E2"/></linearGradient>
<linearGradient id="kg-screen" x1="0" y1="0" x2=".4" y2="1"><stop offset="0" stop-color="#24504A"/><stop offset="1" stop-color="#081A18"/></linearGradient>
<linearGradient id="kg-alu" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#EEF2F1"/><stop offset="1" stop-color="#9AA8A5"/></linearGradient>
<linearGradient id="kg-pencil" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#6FA6CC"/><stop offset=".5" stop-color="#3F7FA8"/><stop offset="1" stop-color="#255A7C"/></linearGradient>
</defs>`;
