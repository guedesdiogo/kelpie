// Dream (#112): memory's consolidation, off the hot path. A step is one model call. The Context
// Store keeps the run, picks the notes and decides what is written (docs/memory-format.md).
import type { ModelTier, RoutedRequest, Usage } from "@kelpie/llm";
import {
  ABSTRACT_PROMPT,
  abstractInput,
  abstractOf,
  MERGE_PROMPT,
  mergeInput,
  mergeOf,
  SUMMARY_PROMPT,
  summaryInput,
  summaryOf,
} from "@kelpie/memory";
import { complete, type ModelGateway } from "./model.ts";

const DREAM_TIER: ModelTier = "cheap";
/** Room for a model that thinks before it answers; the answer itself is one short line. */
const ABSTRACT_OUTPUT_TOKENS = 2_000;

/**
 * The abstract the model proposes for a note, or null when its answer isn't one. Throws when the
 * model fails or is late.
 */
export async function proposeAbstract(
  gateway: ModelGateway,
  note: { path: string; title: string; body: string },
  timeoutMs: number,
): Promise<{ abstract: string | null; usage: Usage[] }> {
  const request: RoutedRequest = {
    system: ABSTRACT_PROMPT,
    messages: [{ role: "user", parts: [{ type: "text", text: abstractInput(note) }] }],
    maxOutputTokens: ABSTRACT_OUTPUT_TOKENS,
  };
  const { text, usage } = await complete(gateway, DREAM_TIER, request, timeoutMs);
  return { abstract: abstractOf(text), usage };
}

/** Room for a model that thinks; the summary itself is a few short paragraphs. */
const SUMMARY_OUTPUT_TOKENS = 3_000;

/**
 * The summary the model proposes for one day of one conversation, or null when its answer isn't
 * one. Throws when the model fails or is late.
 */
export async function proposeSummary(
  gateway: ModelGateway,
  day: { date: string; pages: readonly { path: string; title: string; body: string }[] },
  timeoutMs: number,
): Promise<{ summary: string | null; usage: Usage[] }> {
  const input = summaryInput(day);
  if (input === null) throw new RangeError("the day's pages don't fit");
  const request: RoutedRequest = {
    system: SUMMARY_PROMPT,
    messages: [{ role: "user", parts: [{ type: "text", text: input }] }],
    maxOutputTokens: SUMMARY_OUTPUT_TOKENS,
  };
  const { text, usage } = await complete(gateway, DREAM_TIER, request, timeoutMs);
  return { summary: summaryOf(text), usage };
}

/** Room for a model that thinks; the merged body is at most 8,000 characters. */
const MERGE_OUTPUT_TOKENS = 6_000;

/**
 * What the model says of notes that share a title: that they're distinct, or their merged body;
 * null when its answer isn't one. Throws when the notes don't fit whole, or the model fails or is
 * late.
 */
export async function proposeMerge(
  gateway: ModelGateway,
  notes: readonly { path: string; title: string; body: string }[],
  timeoutMs: number,
): Promise<{ answer: ReturnType<typeof mergeOf>; usage: Usage[] }> {
  const input = mergeInput(notes);
  if (input === null) throw new RangeError("the notes don't fit whole");
  const request: RoutedRequest = {
    system: MERGE_PROMPT,
    messages: [{ role: "user", parts: [{ type: "text", text: input }] }],
    maxOutputTokens: MERGE_OUTPUT_TOKENS,
  };
  const { text, usage } = await complete(gateway, DREAM_TIER, request, timeoutMs);
  return { answer: mergeOf(text), usage };
}
