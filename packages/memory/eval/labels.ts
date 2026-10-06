import { RELATIONS, relationQuestion } from "../src/write-decision.ts";
import { GOLD_MEMORIES } from "./gold-vault.ts";
import { QUESTIONS } from "./questions.ts";
import { WRITE_PAIRS } from "./write-decision-set.ts";

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

/**
 * The write decision's labeled set (#149), with the question it is asked and its answers: a change
 * to any of them needs a new measurement.
 */
export const WRITE_SET_SHA256 = "91b58905b4496ddf5e1478ea21d9467718608b2381f638e14b8bd9af06bc84f2";

export async function writeSetHash(): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ WRITE_PAIRS, RELATIONS, question: relationQuestion("c0") }),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
