import type { AgentRole } from "./commands.ts";

// Each agent is a plush mascot the owner customizes on five axes (ADR-0045 §2). The webchat's
// engine (apps/ingress/public/webchat/mascot-art.js) draws each option by these ids.
//
// A new option goes at the end of its list. Derived mascots draw from the options as they were
// first listed (`DERIVED`), so a new one never changes an agent that never picked one.

export const MASCOT_SHAPES = [
  "mark",
  "bubble",
  "drop",
  "pebble",
  "buoy",
  "jellyfish",
  "cloud",
  "dune",
  "star",
  "heart",
  "bean",
  "block",
] as const;

/** Mid tones, the `--mascot-*` tokens. None is amber, which means the owner needs to act. */
export const MASCOT_COLORS = [
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
] as const;

export const MASCOT_EYES = [
  "dots",
  "pills",
  "shine",
  "marbles",
  "cyclops",
  "half-moon",
  "frog",
  "stars",
  "big",
  "buttons",
] as const;

/** What sits on the head: a type, and for some types a variation. */
export const MASCOT_HEADS = {
  none: [],
  ears: ["pointed", "floppy", "round"],
  horns: ["two", "one", "antennae"],
  hair: ["strands", "curl", "mohawk"],
  leaves: ["one", "two", "kelp"],
} as const;

export const MASCOT_ACCESSORIES = {
  none: [],
  glasses: ["round", "dark"],
  bow: ["tie", "head"],
  hat: ["beret", "top", "beanie"],
  belt: ["belt", "collar"],
} as const;

type Part<Types extends Record<string, readonly string[]>> = {
  [Type in keyof Types]: Types[Type] extends readonly []
    ? { type: Type }
    : { type: Type; variation: Types[Type][number] };
}[keyof Types];

export interface Mascot {
  shape: (typeof MASCOT_SHAPES)[number];
  color: (typeof MASCOT_COLORS)[number];
  eyes: (typeof MASCOT_EYES)[number];
  /** Rosy cheeks, with any eyes. */
  cheeks: boolean;
  head: Part<typeof MASCOT_HEADS>;
  accessory: Part<typeof MASCOT_ACCESSORIES>;
}

/** The main agent's mascot until the owner picks another. */
export const KELPIE_MASCOT: Mascot = {
  shape: "mark",
  color: "kelp",
  eyes: "shine",
  cheeks: false,
  head: { type: "ears", variation: "pointed" },
  accessory: { type: "belt", variation: "collar" },
};

const oneOf = <T extends string>(options: readonly T[], value: unknown): value is T =>
  options.includes(value as T);

function parsePart<Types extends Record<string, readonly string[]>>(
  types: Types,
  value: unknown,
): Part<Types> | null {
  if (typeof value !== "object" || value === null) return null;
  const { type, variation, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || typeof type !== "string" || !Object.hasOwn(types, type)) {
    return null;
  }
  const variations = types[type] as readonly string[];
  if (variations.length === 0) {
    return variation === undefined ? ({ type } as Part<Types>) : null;
  }
  return oneOf(variations, variation) ? ({ type, variation } as Part<Types>) : null;
}

/** A mascot with every axis set to a known option, or null for anything else. */
export function parseMascot(value: unknown): Mascot | null {
  if (typeof value !== "object" || value === null) return null;
  const { shape, color, eyes, cheeks, head, accessory, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return null;
  if (!oneOf(MASCOT_SHAPES, shape) || !oneOf(MASCOT_COLORS, color) || !oneOf(MASCOT_EYES, eyes)) {
    return null;
  }
  if (typeof cheeks !== "boolean") return null;
  const parsedHead = parsePart(MASCOT_HEADS, head);
  const parsedAccessory = parsePart(MASCOT_ACCESSORIES, accessory);
  if (!parsedHead || !parsedAccessory) return null;
  return { shape, color, eyes, cheeks, head: parsedHead, accessory: parsedAccessory };
}

/** FNV-1a, then mulberry32: the same numbers in every runtime, for the same id. */
function randomFrom(id: string): () => number {
  let seed = 2_166_136_261;
  for (let i = 0; i < id.length; i++) seed = Math.imul(seed ^ id.charCodeAt(i), 16_777_619);
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * What a derived mascot draws from: ADR-0045's options, frozen. The heads and accessories are
 * listed whole, since a new variation inside a type would shift a flattened list.
 */
const DERIVED: {
  shapes: readonly Mascot["shape"][];
  colors: readonly Mascot["color"][];
  eyes: readonly Mascot["eyes"][];
  heads: readonly Mascot["head"][];
  accessories: readonly Mascot["accessory"][];
} = {
  shapes: MASCOT_SHAPES.slice(0, 12),
  colors: MASCOT_COLORS.slice(0, 12),
  eyes: MASCOT_EYES.slice(0, 10),
  heads: [
    { type: "none" },
    { type: "ears", variation: "pointed" },
    { type: "ears", variation: "floppy" },
    { type: "ears", variation: "round" },
    { type: "horns", variation: "two" },
    { type: "horns", variation: "one" },
    { type: "horns", variation: "antennae" },
    { type: "hair", variation: "strands" },
    { type: "hair", variation: "curl" },
    { type: "hair", variation: "mohawk" },
    { type: "leaves", variation: "one" },
    { type: "leaves", variation: "two" },
    { type: "leaves", variation: "kelp" },
  ],
  accessories: [
    { type: "none" },
    { type: "glasses", variation: "round" },
    { type: "glasses", variation: "dark" },
    { type: "bow", variation: "tie" },
    { type: "bow", variation: "head" },
    { type: "hat", variation: "beret" },
    { type: "hat", variation: "top" },
    { type: "hat", variation: "beanie" },
    { type: "belt", variation: "belt" },
    { type: "belt", variation: "collar" },
  ],
};

/** An agent's mascot until the owner picks one, so two agents rarely look alike. */
export function derivedMascot(agentId: string): Mascot {
  const random = randomFrom(agentId);
  const pick = <T>(options: readonly T[]): T => options[Math.floor(random() * options.length)] as T;
  return {
    shape: pick(DERIVED.shapes),
    color: pick(DERIVED.colors),
    eyes: pick(DERIVED.eyes),
    cheeks: random() < 0.5,
    head: pick(DERIVED.heads),
    accessory: pick(DERIVED.accessories),
  };
}

/**
 * The mascot an agent shows: the one the owner picked, or else Kelpie for the main agent and one
 * derived from its id for any other, the setup agent and new agents included.
 */
export function mascotFor(agentId: string, role: AgentRole | null, picked: Mascot | null): Mascot {
  if (picked) return picked;
  return role === "main" ? KELPIE_MASCOT : derivedMascot(agentId);
}
