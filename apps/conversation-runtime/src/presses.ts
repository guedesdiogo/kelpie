import type { Locale, Localized } from "@kelpie/channels";

// The buttons under Kelpie's own notices on a channel behind channel-egress, and their taps
// (ADR-0067 §3). A button's data is an action and the random id of what it acts on, so a tap names
// exactly one thing: never a counter or "the latest one" (ADR-0026 §4). The conversation looks the
// id up for that action, and acts by that action's own rules.

/** What a button can do. ADR-0055's model picker and ADR-0069's Approve and Deny add theirs. */
export type PressAction = "confirm";

const ACTIONS: readonly string[] = ["confirm"] satisfies readonly PressAction[];

/** A random id, as a button carries it: 128 bits, in hex. */
const PRESS_ID = /^[0-9a-f]{32}$/;

/** A new random id for something a button acts on. */
export function newPressId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** The data on a button that does `action` to what `id` names. */
export function pressData(action: PressAction, id: string): string {
  return `${action}:${id}`;
}

/** The action and id a button's data names, or null for data Kelpie didn't write. */
export function parsePress(data: string): { action: PressAction; id: string } | null {
  const [action = "", id = "", ...rest] = data.split(":");
  if (rest.length > 0 || !ACTIONS.includes(action) || !PRESS_ID.test(id)) return null;
  return { action: action as PressAction, id };
}

/** What a tap on a button that acts on nothing open is answered. */
const REFUSED: Localized<string> = {
  en: "This button no longer works.",
  "pt-BR": "Este botão não funciona mais.",
  es: "Este botón ya no funciona.",
};

export function pressRefused(locale: Locale): string {
  return REFUSED[locale];
}
