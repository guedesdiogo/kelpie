// The JSON schema of an agent's mascot (ADR-0045 §2), for the tool that changes it. The values are
// checked again by `parseMascot` before anything runs, a variation against its type among them.
import {
  MASCOT_ACCESSORIES,
  MASCOT_COLORS,
  MASCOT_EYES,
  MASCOT_HEADS,
  MASCOT_SHAPES,
} from "@kelpie/config";

/** A part's schema, and the variations of each type in its description. */
function part(types: Record<string, readonly string[]>, what: string) {
  const listed = Object.entries(types)
    .filter(([, variations]) => variations.length > 0)
    .map(([type, variations]) => `${type}: ${variations.join(", ")}`)
    .join("; ");
  return {
    type: "object",
    description: `${what}: a type, and a variation for a type that has some (${listed}).`,
    properties: {
      type: { type: "string", enum: Object.keys(types) },
      variation: { type: "string", enum: [...new Set(Object.values(types).flat())] },
    },
    required: ["type"],
    additionalProperties: false,
  } as const;
}

export const MASCOT_SCHEMA = {
  type: ["object", "null"],
  description:
    "How the agent looks: a plush mascot, set whole, every axis included. get_agent shows the one it shows now; change only what the owner asks. null goes back to its default.",
  properties: {
    shape: { type: "string", enum: [...MASCOT_SHAPES] },
    color: { type: "string", enum: [...MASCOT_COLORS] },
    eyes: { type: "string", enum: [...MASCOT_EYES] },
    cheeks: { type: "boolean", description: "Rosy cheeks." },
    head: part(MASCOT_HEADS, "What sits on its head"),
    accessory: part(MASCOT_ACCESSORIES, "Its accessory; a hat hides what sits on top of the head"),
  },
  required: ["shape", "color", "eyes", "cheeks", "head", "accessory"],
  additionalProperties: false,
} as const;
