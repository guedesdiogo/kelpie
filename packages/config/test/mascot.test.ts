import { describe, expect, it } from "vitest";
import {
  derivedMascot,
  KELPIE_MASCOT,
  MASCOT_ACCESSORIES,
  MASCOT_COLORS,
  MASCOT_EYES,
  MASCOT_HEADS,
  MASCOT_SHAPES,
  type Mascot,
  mascotFor,
  parseMascot,
} from "../src/mascot.ts";
import { DEFAULT_SETTINGS, parseSettings } from "../src/settings.ts";

const agenda: Mascot = {
  shape: "pebble",
  color: "fawn",
  eyes: "dots",
  cheeks: true,
  head: { type: "ears", variation: "floppy" },
  accessory: { type: "bow", variation: "tie" },
};

describe("the mascot's axes (ADR-0045 §2)", () => {
  it("has 12 shapes, 12 colors, 10 eyes, 13 heads in 5 types and 10 accessories in 5 types", () => {
    expect(MASCOT_SHAPES).toHaveLength(12);
    expect(MASCOT_COLORS).toHaveLength(12);
    expect(MASCOT_EYES).toHaveLength(10);
    const options = (types: Record<string, readonly string[]>) =>
      Object.values(types).reduce((sum, variations) => sum + Math.max(1, variations.length), 0);
    expect(Object.keys(MASCOT_HEADS)).toHaveLength(5);
    expect(options(MASCOT_HEADS)).toBe(13);
    expect(Object.keys(MASCOT_ACCESSORIES)).toHaveLength(5);
    expect(options(MASCOT_ACCESSORIES)).toBe(10);
    // Cheeks on or off double the eyes: 374,400 combinations.
    expect(12 * 12 * 10 * 2 * options(MASCOT_HEADS) * options(MASCOT_ACCESSORIES)).toBe(374_400);
  });

  it("has no amber body color: amber means the owner needs to act", () => {
    expect(MASCOT_COLORS).not.toContain("amber");
  });
});

describe("parseMascot", () => {
  it("takes the five axes, with a variation only for a type that has some", () => {
    expect(parseMascot(agenda)).toEqual(agenda);
    const plain = { ...agenda, head: { type: "none" }, accessory: { type: "none" } };
    expect(parseMascot(plain)).toEqual(plain);
  });

  it.each([
    [{ ...agenda, shape: "triangle" }],
    [{ ...agenda, color: "amber" }],
    [{ ...agenda, eyes: "lasers" }],
    [{ ...agenda, cheeks: "yes" }],
    [{ ...agenda, head: { type: "ears" } }],
    [{ ...agenda, head: { type: "ears", variation: "mohawk" } }],
    [{ ...agenda, head: { type: "none", variation: "pointed" } }],
    [{ ...agenda, head: "ears" }],
    [{ ...agenda, accessory: { type: "hat", variation: "crown" } }],
    [{ ...agenda, accessory: { type: "belt", variation: "collar", color: "red" } }],
    [{ ...agenda, accessory: undefined }],
    [{ ...agenda, extra: true }],
    [null],
    ["mark"],
  ])("refuses %j", (input) => {
    expect(parseMascot(input)).toBeNull();
  });
});

describe("the mascot setting", () => {
  it("is unset by default, so the agent shows its default", () => {
    expect(DEFAULT_SETTINGS.mascot).toBeNull();
  });

  it("is validated at the boundary, and null goes back to the default", () => {
    expect(parseSettings({ mascot: agenda })).toEqual({ mascot: agenda });
    expect(parseSettings({ mascot: null })).toEqual({ mascot: null });
    expect(parseSettings({ mascot: { ...agenda, shape: "triangle" } })).toBeNull();
  });
});

describe("mascotFor", () => {
  it("starts the main agent as Kelpie", () => {
    expect(KELPIE_MASCOT).toEqual({
      shape: "mark",
      color: "kelp",
      eyes: "shine",
      cheeks: false,
      head: { type: "ears", variation: "pointed" },
      accessory: { type: "belt", variation: "collar" },
    });
    expect(mascotFor("kelpie", "main", null)).toEqual(KELPIE_MASCOT);
    expect(mascotFor("assistant", "main", null)).toEqual(KELPIE_MASCOT);
  });

  it("starts every other agent with a mascot derived from its id, the setup agent included", () => {
    for (const role of ["admin", "specialist", null] as const) {
      expect(mascotFor("setup", role, null)).toEqual(derivedMascot("setup"));
    }
    expect(mascotFor("agenda", "specialist", null)).toEqual(derivedMascot("agenda"));
  });

  it("shows the mascot the owner picked, whatever the role", () => {
    expect(mascotFor("kelpie", "main", agenda)).toEqual(agenda);
    expect(mascotFor("agenda", "specialist", agenda)).toEqual(agenda);
  });
});

describe("derivedMascot", () => {
  it("gives the same id the same valid mascot, in every release", () => {
    const ids = ["setup", "agenda", "pesquisa", "codigo", "sales-bot", "a1"];
    for (const id of ids) {
      const mascot = derivedMascot(id);
      expect(parseMascot(mascot), id).toEqual(mascot);
      expect(derivedMascot(id)).toEqual(mascot);
    }
    // Pinned: reordering an axis's options would change every agent that never picked one.
    expect(derivedMascot("setup")).toMatchInlineSnapshot(`
      {
        "accessory": {
          "type": "bow",
          "variation": "head",
        },
        "cheeks": false,
        "color": "tide",
        "eyes": "stars",
        "head": {
          "type": "horns",
          "variation": "two",
        },
        "shape": "buoy",
      }
    `);
  });

  it("makes two agents rarely look alike", () => {
    const ids = Array.from({ length: 200 }, (_, i) => `agent-${i}`);
    const looks = new Set(ids.map((id) => JSON.stringify(derivedMascot(id))));
    expect(looks.size).toBe(ids.length);
    // Every shape and color turns up across them.
    expect(new Set(ids.map((id) => derivedMascot(id).shape)).size).toBe(MASCOT_SHAPES.length);
    expect(new Set(ids.map((id) => derivedMascot(id).color)).size).toBe(MASCOT_COLORS.length);
    // ...and every eye, head and accessory, each a valid option.
    expect(new Set(ids.map((id) => derivedMascot(id).eyes)).size).toBe(MASCOT_EYES.length);
    const heads = new Set(ids.map((id) => JSON.stringify(derivedMascot(id).head)));
    expect(heads.size).toBe(13);
    const accessories = new Set(ids.map((id) => JSON.stringify(derivedMascot(id).accessory)));
    expect(accessories.size).toBe(10);
  });
});
