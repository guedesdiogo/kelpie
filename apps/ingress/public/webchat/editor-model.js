// The agent editor's decisions, without the DOM (#379): its sections, the mascot's axes and their
// options, a random look, the summary line that is the preview's text alternative, and what
// changed since the editor opened. editor.js and construtor.js draw what these return.

import { ACCESSORIES, COLORS, EYES, HEADS, SHAPES } from "./mascot-art.js";

/**
 * The editor's sections, in the nav's order. Profile and Mascot ship with #379; the agent's own
 * files arrive with #381, and until then show, disabled, so the frame doesn't change.
 */
export const SECTIONS = [
  { id: "profile", icon: "profile", ready: true },
  { id: "mascot", icon: "body", ready: true },
  { id: "soul", icon: "soul", ready: false },
  { id: "rules", icon: "rules", ready: false },
  { id: "memory", icon: "memory", ready: false },
  { id: "skills", icon: "skills", ready: false },
];

/** The sections a save writes, each through its own route. */
export const SAVED_SECTIONS = ["profile", "mascot"];

/** The mascot's axes, one tab each, in the order the summary reads them (ADR-0045 §2). */
export const AXES = ["shape", "color", "eyes", "head", "accessory"];

/** The options of an axis that is one choice. */
export const CHOICES = { shape: Object.keys(SHAPES), color: COLORS, eyes: Object.keys(EYES) };

/** The types of a part, each with its variations. */
export const PARTS = { head: HEADS, accessory: ACCESSORIES };

/** The profile's limits, as the agent's settings hold them (packages/config). */
export const LIMITS = { name: 80, specialty: 40, remit: 200 };

/** Every option of a part, each type without a variation once, in their lists' order. */
export function partOptions(types) {
  return Object.entries(types).flatMap(([type, variations]) =>
    variations.length === 0 ? [{ type }] : variations.map((variation) => ({ type, variation })),
  );
}

/** A look drawn from every option, as a new agent's is on the server. */
export function randomLook(random = Math.random) {
  const pick = (options) => options[Math.floor(random() * options.length)];
  return {
    shape: pick(CHOICES.shape),
    color: pick(CHOICES.color),
    eyes: pick(CHOICES.eyes),
    cheeks: random() < 0.5,
    head: pick(partOptions(HEADS)),
    accessory: pick(partOptions(ACCESSORIES)),
  };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** `look` with one axis drawn again, never to the option it has: "Randomize <axis>". */
export function randomizeAxis(look, axis, random = Math.random) {
  const options = Object.hasOwn(PARTS, axis) ? partOptions(PARTS[axis]) : CHOICES[axis];
  const others = options.filter((option) => !same(option, look[axis]));
  return { ...look, [axis]: others[Math.floor(random() * others.length)] };
}

/**
 * A part's new type: the variation it had when the type stays, or the type's first one. The
 * variation's own radiogroup picks among the rest.
 */
export function withType(part, type, types) {
  if (part.type === type) return part;
  const variations = types[type];
  return variations.length === 0 ? { type } : { type, variation: variations[0] };
}

/** The summary line (5.19): what the preview shows, in the order it shows it. */
export function summaryOf(look, names) {
  const phrase = (part, none) =>
    part.type === "none" ? none : names.phrases[part.type][part.variation];
  return names.summary({
    shape: names.shapes[look.shape],
    color: names.colors[look.color],
    eyes: names.eyes[look.eyes],
    cheeks: look.cheeks,
    head: phrase(look.head, names.phrases.none),
    accessory: phrase(look.accessory, names.phrases.noAccessory),
  });
}

/** The axis a step changed, for the motion that follows it and for Undo's name. */
export function changedAxis(before, after) {
  const changed = [...AXES, "cheeks"].filter((axis) => !same(before[axis], after[axis]));
  return changed.length === 1 ? changed[0] : "random";
}

/** The profile's fields as the page edits them: what the list said, "" for what it didn't. */
export function profileOf(agent) {
  return {
    name: agent.name,
    specialty: typeof agent.specialty === "string" ? agent.specialty : "",
    remit: typeof agent.remit === "string" ? agent.remit : "",
  };
}

/**
 * What a line the agent keeps can hold, as packages/config checks it: tabs and breaks become
 * spaces, and control, format, private-use and unassigned characters go, as does a run of
 * variation selectors after the first. Pasted text often carries them, and the line would be
 * refused.
 */
export function cleanLine(text) {
  return text
    .replace(/[\t\n\r\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\p{C}/gu, "")
    .replace(/(\p{Variation_Selector})\p{Variation_Selector}+/gu, "$1");
}

/** Whether a line shows something: spaces, fillers and the Braille blank alone don't (#401). */
export const shows = (text) =>
  /[^\p{White_Space}\p{Default_Ignorable_Code_Point}\u2800]/u.test(text);

/**
 * The profile's fields that differ from what is saved, trimmed as the agent keeps them. A remit or
 * a specialty that shows nothing is an empty one.
 */
export function profileChanges(saved, draft, { main }) {
  const changes = {};
  for (const field of ["name", "remit", ...(main ? [] : ["specialty"])]) {
    const value = field === "name" || shows(draft[field]) ? draft[field].trim() : "";
    if (value !== saved[field]) changes[field] = value;
  }
  return changes;
}

/** The sections that changed since the editor opened, in the nav's order. */
export function changedSections({ saved, draft, main }) {
  const changed = [];
  if (Object.keys(profileChanges(saved.profile, draft.profile, { main })).length > 0) {
    changed.push("profile");
  }
  if (!same(saved.mascot, draft.mascot)) changed.push("mascot");
  return changed;
}

/** Whether the profile can be saved: a name that shows something. */
export const profileValid = (draft) => shows(draft.name);
