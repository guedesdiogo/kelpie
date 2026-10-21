// The webchat's icons (ADR-0049): the page links the logo's favicon, home-screen icon and
// manifest, and each file is what its link says. scripts/brand-icons.mjs draws them. The sidebar's
// lockup inlines the mark, which must stay the one in docs/brand/.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import PAGE from "../../public/webchat/index.html?raw";

/** The Worker's static files. The page's DOM has its own URL, so the path is Node's. */
const PUBLIC = join(fileURLToPath(import.meta.url), "../../../public");

/** A file the webchat serves, by its path on the site. */
const served = (path) => {
  expect(path.startsWith("/webchat/"), path).toBe(true);
  return readFileSync(join(PUBLIC, path));
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** A PNG's width and height, from its IHDR chunk. */
function pngSize(bytes) {
  expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
}

const page = new DOMParser().parseFromString(PAGE, "text/html");
const links = (rel) => [...page.head.querySelectorAll(`link[rel="${rel}"]`)];

/** The logo's mark as scripts/brand-icons.mjs writes it, on the 64 box. */
const MARK = readFileSync(join(PUBLIC, "../../../docs/brand/kelpie-mark.svg"), "utf8");

/** A token's light and dark values in tokens.css, lowercased. */
function token(name) {
  // Read from disk: this project's Vitest empties CSS imports, `?raw` included.
  const tokens = served("/webchat/tokens.css").toString("utf8");
  const values = [...tokens.matchAll(new RegExp(`${name}: (#[0-9a-f]{6});`, "g"))];
  // The light block comes first, then the dark one.
  expect(values.length, name).toBeGreaterThanOrEqual(2);
  return { light: values[0][1], dark: values[1][1] };
}

/** The fill a CSS rule for `selector` sets in `css`, lowercased. */
const fill = (css, selector) =>
  css.match(new RegExp(`\\${selector}\\s*\\{[^}]*fill:\\s*(#[0-9a-fA-F]{6})`))?.[1].toLowerCase();

describe("the webchat's icons (ADR-0049)", () => {
  it("links an SVG favicon, an ICO for the rest, the home-screen icon and the manifest", () => {
    expect(
      links("icon").map((link) => [
        link.getAttribute("href"),
        link.getAttribute("sizes"),
        link.getAttribute("type"),
      ]),
    ).toEqual([
      // sizes on the ICO keeps Chrome from preferring it to the SVG.
      ["/webchat/favicon.ico", "32x32", null],
      ["/webchat/icon.svg", null, "image/svg+xml"],
    ]);
    expect(links("apple-touch-icon").map((link) => link.getAttribute("href"))).toEqual([
      "/webchat/apple-touch-icon.png",
    ]);
    const [manifest] = links("manifest");
    expect(manifest?.getAttribute("href")).toBe("/webchat/manifest.webmanifest");
    // Access guards /webchat/: without the login's cookie, the manifest's request gets the login.
    expect(manifest?.getAttribute("crossorigin")).toBe("use-credentials");
  });

  it("keeps a 16 and a 32 px PNG in the ICO", () => {
    const ico = served("/webchat/favicon.ico");
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([0, 1, 2]);
    const images = [0, 1].map((i) => {
      const at = 6 + 16 * i;
      const size = ico.readUInt8(at);
      const png = ico.subarray(
        ico.readUInt32LE(at + 12),
        ico.readUInt32LE(at + 12) + ico.readUInt32LE(at + 8),
      );
      return [size, pngSize(png)];
    });
    expect(images).toEqual([
      [16, "16x16"],
      [32, "32x32"],
    ]);
  });

  it("draws the favicon on --accent with --on-accent, in light and in dark", () => {
    const svg = served("/webchat/icon.svg").toString("utf8");
    const style = svg.match(/<style>([\s\S]*)<\/style>/)?.[1] ?? "";
    const [light, dark = ""] = style.split(/@media\s*\(prefers-color-scheme:\s*dark\)/);
    const accent = token("--accent");
    const onAccent = token("--on-accent");
    // Safari ignores the dark block inside an SVG favicon, so the light tile comes first and
    // must read on any tab: it is opaque, and covers the whole box.
    expect([fill(light, ".t"), fill(light, ".g")]).toEqual([accent.light, onAccent.light]);
    expect([fill(dark, ".t"), fill(dark, ".g")]).toEqual([accent.dark, onAccent.dark]);
    expect(svg).toMatch(/<rect class="t" width="32" height="32"/);
  });

  it("draws the mark's pointed ears clockwise, so they join the body with no hole (ADR-0062)", () => {
    const glyphs = {
      "kelpie-mark.svg": MARK.match(/ d="([^"]+)"/)?.[1] ?? "",
      "icon.svg":
        served("/webchat/icon.svg")
          .toString("utf8")
          .match(/class="g" d="([^"]+)"/)?.[1] ?? "",
      "icon-waiting.svg":
        served("/webchat/icon-waiting.svg")
          .toString("utf8")
          .match(/class="g" d="([^"]+)"/)?.[1] ?? "",
    };
    for (const [file, glyph] of Object.entries(glyphs)) {
      // The body is a subpath with arcs, drawn clockwise; each ear is one of lines and curves.
      const ears = glyph.split(/(?=M)/).filter((subpath) => !subpath.includes("A"));
      expect(ears, file).toHaveLength(2);
      for (const ear of ears) {
        const at = [...ear.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map(([, x, y]) => [+x, +y]);
        // In SVG's y-down space a positive shoelace area is clockwise, the body's direction.
        const area = at.reduce((sum, [x, y], i) => {
          const [nx, ny] = at[(i + 1) % at.length];
          return sum + x * ny - nx * y;
        }, 0);
        expect(area, file).toBeGreaterThan(0);
      }
    }
  });

  it("inlines the sidebar's mark from docs/brand/kelpie-mark.svg (ADR-0062)", () => {
    // The page inlines the mark so it takes the lockup's --accent; scripts/brand-icons.mjs doesn't
    // write it. After a change to the logo, copy the path from docs/brand/kelpie-mark.svg.
    const inline = page.querySelector(".brand .brand-mark");
    expect(inline?.getAttribute("viewBox")).toBe(MARK.match(/viewBox="([^"]+)"/)?.[1]);
    expect(inline?.querySelector("path")?.getAttribute("d")).toBe(MARK.match(/ d="([^"]+)"/)?.[1]);
  });

  it("sizes the sidebar's mark by the figure's height, so it stands 1.3 cap heights tall (5.23)", () => {
    // The figure's box counts the ears' control points, as scripts/brand-icons.mjs measures it;
    // an arc's radii aren't points.
    const d = (MARK.match(/ d="([^"]+)"/)?.[1] ?? "").replace(/A[\d.]+,[\d.]+/g, "A");
    const ys = [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map(([, , y]) => +y);
    const style = served("/webchat/style.css").toString("utf8");
    const figure = style.match(
      /\.brand-mark\s*\{[^}]*block-size:\s*calc\(1\.3cap \* 64 \/ ([\d.]+)\)/,
    )?.[1];
    expect(Number(figure)).toBeCloseTo(Math.max(...ys) - Math.min(...ys), 2);
  });

  it("draws the waiting favicon: the same tile, and a --warm dot in an --on-accent ring (5.9)", () => {
    const plain = served("/webchat/icon.svg").toString("utf8");
    const svg = served("/webchat/icon-waiting.svg").toString("utf8");
    const style = svg.match(/<style>([\s\S]*)<\/style>/)?.[1] ?? "";
    const [light, dark = ""] = style.split(/@media\s*\(prefers-color-scheme:\s*dark\)/);
    const accent = token("--accent");
    const onAccent = token("--on-accent");
    const warm = token("--warm");
    expect([fill(light, ".t"), fill(light, ".g"), fill(light, ".w")]).toEqual([
      accent.light,
      onAccent.light,
      warm.light,
    ]);
    expect([fill(dark, ".t"), fill(dark, ".g"), fill(dark, ".w")]).toEqual([
      accent.dark,
      onAccent.dark,
      warm.dark,
    ]);
    // The tile and the mark are icon.svg's, unchanged.
    const tile = plain.match(/<rect class="t"[^>]*\/><path class="g"[^>]*\/>/)?.[0];
    expect(tile).toBeDefined();
    expect(svg).toContain(tile);
    // --warm on --accent measures about 1:1, so a ring in --on-accent sets the dot apart. Both sit
    // in the bottom-right corner, where the 36 px badge sits (5.19), and leave the ears clear.
    expect(svg).toMatch(
      /<circle class="g" cx="25" cy="25" r="7"\/><circle class="w" cx="25" cy="25" r="5"\/>/,
    );
  });

  it("serves the home-screen icon at 180 px", () => {
    expect(pngSize(served(links("apple-touch-icon")[0].getAttribute("href")))).toBe("180x180");
  });

  it("names icons in the manifest that exist at their sizes, any and maskable apart", () => {
    const manifest = JSON.parse(served("/webchat/manifest.webmanifest").toString("utf8"));
    expect(manifest).toMatchObject({ name: "Kelpie", start_url: "/webchat/", scope: "/webchat/" });
    // The page's light background, as the phone's bar takes it before the page paints (5.22).
    const background = token("--bg").light;
    expect([manifest.background_color, manifest.theme_color].map((c) => c.toLowerCase())).toEqual([
      background,
      background,
    ]);
    // Chrome needs a 192 and a 512 px icon; a maskable one stays a separate entry.
    expect(manifest.icons.map((icon) => [icon.sizes, icon.purpose ?? "any"])).toEqual([
      ["192x192", "any"],
      ["512x512", "any"],
      ["512x512", "maskable"],
    ]);
    for (const icon of manifest.icons) {
      expect(icon.type).toBe("image/png");
      expect(pngSize(served(icon.src)), icon.src).toBe(icon.sizes);
    }
  });
});
