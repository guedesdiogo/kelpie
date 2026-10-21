// Kelpie's logo (ADR-0049, ADR-0062): Master's mascot as a silhouette, the `mark` shape with the
// pointed ears the mascot engine draws. This draws every brand file from that geometry, then renders
// the webchat's PNG and ICO icons with headless Chrome. Run it after changing the logo or the ear,
// and commit what it writes:
//
//   node scripts/brand-icons.mjs
//
// It finds Chrome on the PATH (google-chrome, chromium) or in $CHROME. The design system's logo
// section (docs/design-system.md §5.23) holds the rules these files follow.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pointedEarOutlines } from "../apps/ingress/public/webchat/mascot-art.js";

/** The brand's colors: --accent and --on-accent, light and dark (docs/design-system.md §1). */
const KELP = "#0A7469";
const ON_KELP = "#F0FAF8";
const KELP_DARK = "#3BC3AE";
const ON_KELP_DARK = "#03201B";
/** --warm, light and dark: the dot that says an agent waits for the owner (§5.9). */
const WARM = "#915708";
const WARM_DARK = "#EEAE4A";

const n = (value) => String(Math.round(value * 1000) / 1000);

/** A rectangle with its own radius at each corner, clockwise: top left, top right, bottom right, bottom left. */
function rounded(x, y, w, h, [a, b, c, d]) {
  return [
    `M${n(x + a)},${n(y)}H${n(x + w - b)}A${n(b)},${n(b)} 0 0 1 ${n(x + w)},${n(y + b)}`,
    `V${n(y + h - c)}A${n(c)},${n(c)} 0 0 1 ${n(x + w - c)},${n(y + h)}`,
    `H${n(x + d)}A${n(d)},${n(d)} 0 0 1 ${n(x)},${n(y + h - d)}`,
    `V${n(y + a)}A${n(a)},${n(a)} 0 0 1 ${n(x + a)},${n(y)}Z`,
  ].join("");
}

/** The points of a path whose commands all take absolute "x,y" pairs (M, L, C). */
const points = (d) => [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map(([, x, y]) => [+x, +y]);

/** The path with each point moved by `move`. */
const moved = (d, move) =>
  d.replace(/(-?[\d.]+),(-?[\d.]+)/g, (_, x, y) => move(+x, +y).map(n).join(","));

/**
 * The path drawn clockwise, so it joins the body under the nonzero rule: the engine mirrors the
 * left ear into the right one, which reverses its direction.
 */
function clockwise(d) {
  const at = points(d);
  const area = at.reduce((sum, [x, y], i) => {
    const [nx, ny] = at[(i + 1) % at.length];
    return sum + x * ny - nx * y;
  }, 0);
  if (area > 0) return d;
  const segments = [...d.matchAll(/([LC])([^LCZ]*)/g)].map(([, command, args]) => [
    command,
    args.trim().split(/\s+/),
  ]);
  let from = d.match(/^M([^\s LC]+)/)[1];
  const reversed = segments.map(([command, pairs]) => {
    const segment = { command, from, pairs };
    from = pairs.at(-1);
    return segment;
  });
  return `M${from}${reversed
    .reverse()
    .map(({ command, from: start, pairs }) =>
      command === "L" ? ` L${start}` : ` C${pairs[1]} ${pairs[0]} ${start}`,
    )
    .join("")} Z`;
}

/**
 * Master's pointed ears on the engine's 120 grid (ADR-0062), and the middle of each one's base: the
 * inner base is the outline's first point, the outer base its fourth.
 */
const RAW_EARS = pointedEarOutlines("mark");
const EARS = RAW_EARS.map(clockwise);
const BASES = RAW_EARS.map((d) => {
  const at = points(d);
  return [(at[0][0] + at[3][0]) / 2, (at[0][1] + at[3][1]) / 2];
});

/**
 * The mark on a 64 box, from the mascot engine's 120 grid (apps/ingress/public/webchat/mascot-art.js):
 * the `mark` shape is 24..96 × 36..108 with corners 36, 36, 36 and 11.5, and the ears' outline,
 * control points included, reaches up to FIGURE_TOP. It is drawn 50 wide and centred on the box:
 * MARK says where, for every file that places it.
 */
const FIGURE_TOP = Math.min(...EARS.flatMap((d) => points(d).map(([, y]) => y)));
const MARK = (() => {
  const k = 50 / 72;
  const height = (108 - FIGURE_TOP) * k;
  return { k, left: 7, top: (64 - height) / 2, width: 50, height };
})();

function mark() {
  const { k } = MARK;
  const x = (v) => MARK.left + (v - 24) * k;
  const y = (v) => MARK.top + (v - FIGURE_TOP) * k;
  return [
    rounded(x(24), y(36), 72 * k, 72 * k, [36 * k, 36 * k, 36 * k, 11.5 * k]),
    ...EARS.map((d) => moved(d, (px, py) => [x(px), y(py)])),
  ].join("");
}

/**
 * The favicon's own drawings, one per size: the body on whole pixels, and the ears grown about the
 * middle of their base, 10% at 32 px and 25% at 16 px, or they vanish (Dropbox and GitHub keep
 * separate small masters the same way).
 */
function small(size, grow) {
  const k = (size === 32 ? 20 : 10) / 72;
  const [left, top] = size === 32 ? [6, 7] : [3, 4];
  const ears = EARS.map((d, i) => {
    const [bx, by] = BASES[i];
    return moved(d, (px, py) => [
      left + (bx + (px - bx) * grow - 24) * k,
      top + (by + (py - by) * grow - 36) * k,
    ]);
  });
  const body =
    size === 32 ? rounded(6, 7, 20, 20, [10, 10, 10, 3.2]) : rounded(3, 4, 10, 10, [5, 5, 5, 1.6]);
  return [body, ...ears].join("");
}
const SMALL = { 32: small(32, 1.1), 16: small(16, 1.25) };

/**
 * "Kelpie" in Bricolage Grotesque at 680, the brand's display weight: the outlines of Fontsource
 * 5.3.0's latin file (SIL Open Font License), instanced at wght 680, 1000 units to the em, y down
 * from the baseline. Letters sit 30 units apart less than their advance (tracking −0.03em), and
 * K and e kern by −19.6, as the browser sets them.
 */
const GLYPHS = {
  K: [
    685,
    "M74 0V-660H214.2V-363Q265.2 -384.4 310.3 -417.2Q355.4 -450 391.5 -489.8Q427.6 -529.6 452.4 -573.1Q477.2 -616.6 489.2 -660H650Q635.8 -610.4 607.2 -561.9Q578.6 -513.4 539.6 -470.4Q500.6 -427.4 456.8 -394.2Q413 -361 368 -341.4V-327Q415.2 -326.8 451.9 -316Q488.6 -305.2 517.4 -282.9Q546.2 -260.6 568.3 -227Q590.4 -193.4 607 -146.6L659.6 0H500.4L466.4 -117.8Q451.4 -167.6 428.4 -197.7Q405.4 -227.8 368.2 -242Q331 -256.2 272.6 -256.2H214.2V0Z",
  ],
  e: [
    580,
    "M309.4 13.6Q244.8 13.6 194.4 -4.2Q144 -22 108.9 -56.2Q73.8 -90.4 55.8 -139.9Q37.8 -189.4 37.8 -252.8Q37.8 -315.2 55.6 -367.6Q73.4 -420 106.7 -458.3Q140 -496.6 188.9 -517.5Q237.8 -538.4 299.2 -538.4Q359.6 -538.4 406.1 -518.9Q452.6 -499.4 483.4 -460.8Q514.2 -422.2 529.2 -365.9Q544.2 -309.6 540 -236L129.2 -233V-310.4L458.8 -313.4L409.6 -273.6Q416 -327.6 401.9 -362Q387.8 -396.4 360.7 -412.8Q333.6 -429.2 300.6 -429.2Q262.2 -429.2 233.4 -408.7Q204.6 -388.2 188.4 -349.5Q172.2 -310.8 172.2 -255.2Q172.2 -170.2 209.3 -129.7Q246.4 -89.2 309 -89.2Q337.6 -89.2 357.2 -96.7Q376.8 -104.2 389.8 -116.3Q402.8 -128.4 410.6 -143.6Q418.4 -158.8 423 -174.2L544.8 -147.6Q536.2 -110.8 518.6 -81.3Q501 -51.8 472.1 -30.3Q443.2 -8.8 403.3 2.4Q363.4 13.6 309.4 13.6Z",
  ],
  l: [273, "M67 0V-714.2H204.8V0Z"],
  p: [
    636,
    "M67 166.8V-258V-524.8H184L184 -380L201 -378.4Q210.8 -430.8 233.4 -466.5Q256 -502.2 291.7 -520.3Q327.4 -538.4 374.8 -538.4Q445.2 -538.4 494.8 -503.9Q544.4 -469.4 570.4 -406.8Q596.4 -344.2 596.4 -259.4Q596.4 -181.6 572.8 -119.8Q549.2 -58 502.1 -22.2Q455 13.6 383.6 13.6Q333 13.6 298.6 -5.4Q264.2 -24.4 241.5 -59.1Q218.8 -93.8 204 -142H185.8Q191.8 -114.8 196.3 -86.4Q200.8 -58 204 -31.3Q207.2 -4.6 207.2 20V166.8ZM335.4 -99Q371.8 -99 397.3 -119.2Q422.8 -139.4 436.7 -175.6Q450.6 -211.8 450.6 -259.4Q450.6 -309.8 436.2 -345.9Q421.8 -382 395.2 -402Q368.6 -422 332.6 -422Q300 -422 276.3 -407.6Q252.6 -393.2 237.2 -369.9Q221.8 -346.6 214.4 -320.1Q207 -293.6 207 -269.4V-250.2Q207 -231 212.3 -210.3Q217.6 -189.6 228.3 -169.9Q239 -150.2 254.3 -134Q269.6 -117.8 290.1 -108.4Q310.6 -99 335.4 -99Z",
  ],
  i: [
    275,
    "M67.2 0V-524.8H207.2V0ZM137.5 -603.6Q96.1 -603.6 74.1 -621.2Q52 -638.8 52 -671.6Q52 -705.9 74 -723.6Q96 -741.2 137.5 -741.2Q180 -741.2 202 -723.6Q224 -706 224 -672.6Q224 -638.8 201.9 -621.2Q179.8 -603.6 137.5 -603.6Z",
  ],
};

/** The word's glyphs placed on one line, and its width, in font units. */
function wordmark() {
  const text = "Kelpie";
  let x = 0;
  const paths = [...text].map((letter, i) => {
    const [advance, d] = GLYPHS[letter];
    const placed = `<path transform="translate(${n(x)} 0)" d="${d}"/>`;
    x += advance - 30 + (text.slice(i, i + 2) === "Ke" ? -19.6 : 0);
    return placed;
  });
  return { paths: paths.join(""), width: x + 30 };
}

/**
 * The lockup: the mark 1.3 cap heights tall, centred on the cap band, then the word. A cap is 660
 * units; the gap from the mark to the K's stem is 0.5 cap.
 */
function lockup(color) {
  const cap = 660;
  const figure = 1.3 * cap;
  const scale = figure / MARK.height;
  const markWidth = MARK.width * scale;
  const top = -cap / 2 - figure / 2;
  const word = wordmark();
  const wordX = markWidth + 0.5 * cap - 74;
  const width = Math.ceil(wordX + word.width);
  // The p's descender reaches 166.8 below the baseline, lower than the mark.
  const bottom = Math.max(top + figure, 166.8);
  const pad = 20;
  const box = [-pad, Math.floor(top - pad), width + 2 * pad, Math.ceil(bottom - top + 2 * pad)];
  const markY = top - MARK.top * scale;
  return svg(
    box.join(" "),
    `<g fill="${color}"><path transform="translate(${n(-MARK.left * scale)} ${n(markY)}) scale(${n(scale)})" d="${mark()}"/><g transform="translate(${n(wordX)} 0)">${word.paths}</g></g>`,
  );
}

/** An SVG file, labelled with the brand's name wherever it shows. */
function svg(viewBox, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" role="img" aria-label="Kelpie">${body}</svg>\n`;
}

/** The favicon: an opaque kelp tile, since Safari ignores the dark block inside an SVG favicon. */
function favicon(size, dark = true) {
  const style = dark
    ? `<style>.t{fill:${KELP}}.g{fill:${ON_KELP}}@media (prefers-color-scheme:dark){.t{fill:${KELP_DARK}}.g{fill:${ON_KELP_DARK}}}</style>`
    : "";
  const tile = dark
    ? `<rect class="t" width="${size}" height="${size}" rx="${n(size * 0.22)}"/><path class="g" d="${SMALL[size]}"/>`
    : `<rect width="${size}" height="${size}" rx="${n(size * 0.22)}" fill="${KELP}"/><path fill="${ON_KELP}" d="${SMALL[size]}"/>`;
  return svg(`0 0 ${size} ${size}`, `${style}${tile}`);
}

/**
 * The 32 px favicon while an agent waits for the owner (§5.9): the same tile, with a --warm dot
 * in the bottom-right corner, where the 36 px badge sits, so both ears stay clear. --warm on
 * --accent measures about 1:1, so a 2 px --on-accent ring sets the dot apart (5.53 and 8.80).
 */
function faviconWaiting() {
  const style = `<style>.t{fill:${KELP}}.g{fill:${ON_KELP}}.w{fill:${WARM}}@media (prefers-color-scheme:dark){.t{fill:${KELP_DARK}}.g{fill:${ON_KELP_DARK}}.w{fill:${WARM_DARK}}}</style>`;
  const tile = `<rect class="t" width="32" height="32" rx="${n(32 * 0.22)}"/><path class="g" d="${SMALL[32]}"/>`;
  const dot = `<circle class="g" cx="25" cy="25" r="7"/><circle class="w" cx="25" cy="25" r="5"/>`;
  return svg("0 0 32 32", `${style}${tile}${dot}`);
}

/**
 * A home-screen icon on a 100 box: the mark `fill` of the box tall, centred on a kelp tile.
 * `square` is for iOS, which masks it; `rounded` for the manifest's `any`; `maskable` keeps the
 * figure inside the 40% circle Android may crop to.
 */
function appIcon(shape, fill) {
  const scale = (fill * 100) / MARK.height;
  // The figure is centred on the 64 box, so its middle is (32, 32).
  const offset = 50 - 32 * scale;
  const tile =
    shape === "rounded"
      ? `<rect width="100" height="100" rx="22.4" fill="${KELP}"/>`
      : `<rect width="100" height="100" fill="${KELP}"/>`;
  return svg(
    "0 0 100 100",
    `${tile}<path transform="translate(${n(offset)} ${n(offset)}) scale(${n(scale)})" fill="${ON_KELP}" d="${mark()}"/>`,
  );
}

/** Renders `svgText` at `width` × `height` px in headless Chrome, and returns the PNG's bytes. */
function render(svgText, width, height) {
  const image = `data:image/svg+xml;base64,${Buffer.from(svgText).toString("base64")}`;
  const page = `<!doctype html><pre id="o"></pre><script>
const img = new Image();
img.onload = () => {
  const c = document.createElement("canvas");
  c.width = ${width}; c.height = ${height};
  c.getContext("2d").drawImage(img, 0, 0, ${width}, ${height});
  document.getElementById("o").textContent = c.toDataURL("image/png");
};
img.src = "${image}";
</script>`;
  const chrome = findChrome();
  const dom = execFileSync(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--force-color-profile=srgb",
      "--virtual-time-budget=3000",
      "--dump-dom",
      `data:text/html;base64,${Buffer.from(page).toString("base64")}`,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60_000 },
  );
  const found = dom.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/);
  if (!found) throw new Error(`Chrome drew no ${width}×${height} image`);
  return Buffer.from(found[1], "base64");
}

function findChrome() {
  for (const name of [process.env.CHROME, "google-chrome", "chromium", "chromium-browser"]) {
    if (!name) continue;
    try {
      execFileSync(name, ["--version"], { stdio: "ignore" });
      return name;
    } catch {}
  }
  throw new Error("Chrome wasn't found: set $CHROME to its path");
}

/** An ICO file that holds each PNG as one image, the way every current browser reads it. */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const at = 6 + 16 * i;
    header.writeUInt8(size % 256, at);
    header.writeUInt8(size % 256, at + 1);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map(({ png }) => png)]);
}

const BRAND = "docs/brand";
const WEBCHAT = "apps/ingress/public/webchat";
const files = {
  [`${BRAND}/kelpie-mark.svg`]: svg("0 0 64 64", `<path fill="${KELP}" d="${mark()}"/>`),
  [`${BRAND}/kelpie-lockup-light.svg`]: lockup(KELP),
  [`${BRAND}/kelpie-lockup-dark.svg`]: lockup(KELP_DARK),
  [`${BRAND}/favicon-16.svg`]: favicon(16, false),
  [`${BRAND}/app-icon.svg`]: appIcon("square", 0.62),
  [`${BRAND}/app-icon-rounded.svg`]: appIcon("rounded", 0.62),
  [`${BRAND}/app-icon-maskable.svg`]: appIcon("square", 0.5),
  [`${WEBCHAT}/icon.svg`]: favicon(32),
  [`${WEBCHAT}/icon-waiting.svg`]: faviconWaiting(),
};
for (const [path, text] of Object.entries(files)) writeFileSync(path, text);

writeFileSync(
  `${WEBCHAT}/favicon.ico`,
  ico([
    { size: 16, png: render(files[`${BRAND}/favicon-16.svg`], 16, 16) },
    { size: 32, png: render(favicon(32, false), 32, 32) },
  ]),
);
writeFileSync(`${WEBCHAT}/apple-touch-icon.png`, render(files[`${BRAND}/app-icon.svg`], 180, 180));
for (const size of [192, 512]) {
  writeFileSync(
    `${WEBCHAT}/icon-${size}.png`,
    render(files[`${BRAND}/app-icon-rounded.svg`], size, size),
  );
}
writeFileSync(
  `${WEBCHAT}/icon-maskable-512.png`,
  render(files[`${BRAND}/app-icon-maskable.svg`], 512, 512),
);
/**
 * The logo drawn inline, where a page shows it without loading the files: the webchat's sidebar, and
 * the design system's Logo and Sidebar previews. Each copy is rewritten from the files above so none
 * drifts, and a page whose markup no longer has the expected copies stops the script.
 */
function rewrite(path, edits) {
  let text = readFileSync(path, "utf8");
  for (const [pattern, replace, count] of edits) {
    const found = text.match(new RegExp(pattern.source, "g"))?.length ?? 0;
    if (found !== count)
      throw new Error(`${path}: expected ${count} of ${pattern}, found ${found}`);
    text = text.replace(new RegExp(pattern.source, "g"), replace);
  }
  writeFileSync(path, text);
}
const tile = (() => {
  const scale = 62 / MARK.height;
  return `translate(${n(50 - 32 * scale)} ${n(50 - 32 * scale)}) scale(${n(scale)})`;
})();
const lock = lockup(KELP).match(/viewBox="([^"]+)"[^>]*><g fill="[^"]+">([\s\S]*)<\/g><\/svg>/);
const DS = "tools/design-system/project/components";
// The sidebar's lockup sizes the mark's 64 box so the figure itself is 1.3 cap heights tall.
const capHeights = [
  /(block-size: calc\(1\.3cap \* 64 \/ )[\d.]+\)/,
  (_, open) => `${open}${n(MARK.height)})`,
  1,
];
rewrite(`${WEBCHAT}/style.css`, [capHeights]);
rewrite("tools/design-system/src/css/Sidebar.css", [capHeights]);
rewrite(`${WEBCHAT}/index.html`, [
  [/(<svg class="brand-mark"[^>]*><path d=")[^"]*"/, (_, open) => `${open}${mark()}"`, 1],
]);
rewrite(`${DS}/Sidebar/preview.html`, [
  [
    /(<a class="k-brand"[^>]*><svg viewBox="0 0 64 64"[^>]*><path d=")[^"]*"/,
    (_, open) => `${open}${mark()}"`,
    1,
  ],
]);
rewrite(`${DS}/Logo/preview.html`, [
  [
    /(<svg class="k-logo-lock"[^>]*viewBox=")[^"]*("[^>]*>)[\s\S]*?<\/svg>/,
    (_, open, rest) => `${open}${lock[1]}${rest}<g class="t">${lock[2]}</g></svg>`,
    1,
  ],
  [
    /(<svg class="k-logo-mark"[^>]*><path class="t" d=")[^"]*"/,
    (_, open) => `${open}${mark()}"`,
    3,
  ],
  [
    /(<svg class="k-fav s64"[^>]*><rect[^>]*\/>)<path[^>]*\/>/,
    (_, open) => `${open}<path transform="${tile}" class="m" d="${mark()}"/>`,
    1,
  ],
  [
    /(<svg class="k-fav s16"[^>]*><rect[^>]*\/><path class="m" d=")[^"]*"/,
    (_, open) => `${open}${SMALL[16]}"`,
    1,
  ],
]);

console.log(`Wrote ${Object.keys(files).length + 5} brand files, and the logo's inline copies.`);
