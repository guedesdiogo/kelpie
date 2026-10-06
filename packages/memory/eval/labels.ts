import { GOLD_MEMORIES } from "./gold-vault.ts";
import { QUESTIONS } from "./questions.ts";

/**
 * The labels were frozen at this hash before any retrieval run (#108). Changing the gold vault or
 * the questions means a new hash, a new baseline, and saying so in the result.
 */
export const LABELS_SHA256 = "12b9571ab00e1426e9e044783f871cef015eec9fbe0862bdec867b2add640527";

export async function labelsHash(): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({ GOLD_MEMORIES, QUESTIONS }));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
