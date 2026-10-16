import { describe, expect, it } from "vitest";
import designSystem from "../../../docs/design-system.md?raw";
import tokens from "../public/webchat/tokens.css?raw";

// The webchat's tokens (#140) are the design system's values (docs/design-system.md), so a page
// built on them can't drift from the document that decides them.

/** tokens.css with every run of whitespace as one space, as the formatter wraps long values. */
const css = tokens.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")");

/** The rule body after `selector`, up to its closing brace. */
function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`no rule for ${selector}`);
  return css.slice(start, css.indexOf("}", start));
}

/** Section 1's table of color tokens: name, light and dark. */
const COLORS = [
  ...designSystem.matchAll(/^\| `(--[a-z-]+)` \| `(#[0-9A-F]{6})` \| `(#[0-9A-F]{6})` \|/gm),
].map(([, name, light, dark]) => ({
  name,
  light: light?.toLowerCase(),
  dark: dark?.toLowerCase(),
}));

describe("the webchat's tokens", () => {
  it("has every color of §1 in light and dark", () => {
    expect(COLORS.map(({ name }) => name)).toEqual([
      "--bg",
      "--surface",
      "--sunken",
      "--fg",
      "--muted",
      "--line",
      "--accent",
      "--on-accent",
      "--warm",
      "--ok",
      "--danger",
      "--line",
      "--muted",
    ]);
    const [base, contrast] = [COLORS.slice(0, 11), COLORS.slice(11)];
    const light = block(":root");
    const dark = block(':root:not([data-theme="light"])');
    const picked = block(':root[data-theme="dark"]');
    for (const { name, light: lightValue, dark: darkValue } of base) {
      expect(light, name).toContain(`${name}: ${lightValue};`);
      expect(dark, name).toContain(`${name}: ${darkValue};`);
      expect(picked, name).toContain(`${name}: ${darkValue};`);
    }
    // Higher contrast changes two tokens, in both themes.
    const more = block(':root[data-contrast="more"]');
    const moreDark = block(':root[data-contrast="more"][data-theme="dark"]');
    for (const { name, light: lightValue, dark: darkValue } of contrast) {
      expect(more, name).toContain(`${name}: ${lightValue};`);
      expect(moreDark, name).toContain(`${name}: ${darkValue};`);
    }
  });

  it("has every spring of §4.2 with its duration", () => {
    const springs = [
      ...designSystem.matchAll(
        /^ {2}(--spring-[a-z-]+): (linear\([^)]*\));\n {2}\1-dur: (\d+ms);/gm,
      ),
    ];
    expect(springs).toHaveLength(7);
    for (const [, name, easing, duration] of springs) {
      expect(css, name).toContain(`${name}: ${easing};`);
      expect(css, name).toContain(`${name}-dur: ${duration};`);
    }
  });

  it("has §3's spacing and radii, and §4.3's durations", () => {
    for (const [name, value] of [
      ["--space-1", "4px"],
      ["--r-bubble", "14px"],
      ["--r-chip", "999px"],
      ["--dur-fade", "150ms"],
      ["--dur-exit", "120ms"],
      ["--stagger", "30ms"],
      ["--rise", "8px"],
      ["--scale-in", "0.97"],
    ]) {
      expect(designSystem, name).toContain(`\`${name}\``);
      expect(css, name).toContain(`${name}: ${value};`);
    }
    // §3 writes the rest of the grid as `-2` to `-16`.
    for (const [step, px] of [
      [2, 8],
      [3, 12],
      [4, 16],
      [6, 24],
      [8, 32],
      [12, 48],
      [16, 64],
    ]) {
      expect(designSystem).toContain(`\`-${step}\` ${px}px`);
      expect(css).toContain(`--space-${step}: ${px}px;`);
    }
  });

  it("serves the three families itself, at only the weights §2 lists", () => {
    const faces = [...css.matchAll(/@font-face \{ ([^}]*) \}/g)].map(([, body]) => body ?? "");
    const weights = (family: string) =>
      new Set(
        faces
          .filter((face) => face.includes(`"${family}"`))
          .map((face) => face.match(/font-weight: ([^;]+);/)?.[1]),
      );
    expect(weights("Geist")).toEqual(new Set(["400 600"]));
    expect(weights("Geist Mono")).toEqual(new Set(["400 500"]));
    expect(weights("Bricolage Grotesque")).toEqual(new Set(["680"]));
    for (const face of faces) {
      expect(face).toMatch(
        /src: url\("\/webchat\/fonts\/[a-z-]+-5\.3\.0\.woff2"\) format\("woff2"\);/,
      );
      expect(face).toContain("font-display: swap;");
    }
    expect(css).not.toMatch(/url\("?https?:/);
  });
});
